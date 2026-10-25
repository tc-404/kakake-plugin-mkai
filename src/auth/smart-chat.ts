// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — Runtime（Controller：入站 / 调度；flush 见 smart-chat-flush）
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import type { SmartChatBufferEntry, SmartChatDeps } from './smart-chat-types';
import { SMART_CHAT_LEGACY_ROOT, SMART_CHAT_ROOT } from './smart-chat-types';
import { loadSmartChatConfig } from './smart-chat-config';
import { appendChatBuffer, clearChatBuffer, loadChatBuffer, saveChatBuffer } from './smart-chat-buffer';
import { extractInboundMeta, enrichReplyMeta, rememberInboundAsQuoteTarget, normalizeGroupRole, normalizeGroupTitle } from './smart-chat-inbound';
import { clearSession, loadSession, listSessionIds } from './smart-chat-session';
import { bindNvidiaRateDeps, fetchBalance, getUsageSummary } from './smart-chat-billing';
import { bindRotationDeps } from './smart-chat-rotation';
import {
    isSmartChatAiOnlyForEvent,
    isSmartChatAtOnlyForEvent,
    isSmartChatAtOnlyRecordForEvent,
    isSmartChatEnabledForEvent,
    isSmartChatFileForEvent,
    isSmartChatImageForEvent,
} from './smart-chat-switches';
import { isSmartChatBlacklistedForEvent } from './smart-chat-blacklist';
import {
    bindSmartChatImageRuntime,
    bindSmartChatImageVision,
    enqueueImageJobs,
    extractImageHttpUrls,
    planImageHandling,
    type ImageJobMeta,
} from './smart-chat-image';
import {
    bindSmartChatFileRuntime,
    enqueueFileJobs,
    extractInboundFiles,
    planFileHandling,
    FILE_DOWNLOAD_TIMEOUT_MS,
    type FileJobMeta,
} from './smart-chat-file';
import { ensureBotIdentity } from './smart-chat-identity';
import { ensureBuiltinKnowledge } from './smart-chat-knowledge';
import {
    busyChats,
    flushChat,
    invalidateFlushTimer,
    resetFlushTimers,
    scheduleFlush,
    scheduleReactionFlush,
    shouldFlushByBatchCount,
    shouldFlushOnDebounce,
} from './smart-chat-flush';

export {
    flushChat,
    invalidateFlushTimer,
    jitterWaitMs,
    pickRandomWaitMs,
    pickReactionDelayMs,
    resetFlushTimers,
    resolveFlushDelay,
    scheduleFlush,
    scheduleReactionFlush,
    shouldFlushByBatchCount,
    shouldFlushOnDebounce,
    PROB_FLUSH_MIN_BATCH,
    REACTION_DELAY_MAX_MS,
    REACTION_DELAY_MIN_MS,
} from './smart-chat-flush';

let migrationDone = false;

function chatIdFromEvent(event: Record<string, unknown>): string {
    if (event.message_type === 'group') return `g_${event.group_id}`;
    return `p_${event.user_id}`;
}

function groupIdFromEvent(event: Record<string, unknown>): string | null {
    if (event.message_type === 'group') return String(event.group_id || '');
    return null;
}

function isEventEnabled(deps: SmartChatDeps, event: Record<string, unknown>, cfg: ReturnType<typeof loadSmartChatConfig>): boolean {
    return isSmartChatEnabledForEvent(deps, event, cfg);
}

function readB(deps: SmartChatDeps, file: string, key: string, def: unknown): unknown {
    return deps.readB(file, key, def);
}

function snapshotEvent(event: Record<string, unknown>): Record<string, unknown> {
    return {
        message_type: event.message_type,
        group_id: event.group_id,
        group_name: event.group_name,
        user_id: event.user_id,
        self_id: event.self_id,
        message_id: event.message_id,
        sender: event.sender,
        raw_message: event.raw_message,
        message: event.message,
    };
}

export function migrateLegacySmartChat(deps: SmartChatDeps): void {
    if (migrationDone) return;
    migrationDone = true;
    try {
        const legacyDir = path.join(deps.getDataPath(), SMART_CHAT_LEGACY_ROOT, 'DeepSeek');
        const newDir = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config');
        if (!fs.existsSync(legacyDir)) return;
        // 旧 AI对话/DeepSeek → 扁平 sessions，再由 getActiveSessionNamespace 迁入 by-config
        const flatDir = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions');
        if (!fs.existsSync(flatDir)) fs.mkdirSync(flatDir, { recursive: true });
        for (const f of fs.readdirSync(legacyDir)) {
            if (!f.endsWith('.json')) continue;
            const chatId = f.replace(/\.json$/, '');
            const dst = path.join(flatDir, `${chatId}.json`);
            if (fs.existsSync(dst)) continue;
            // 已在 by-config 任意指纹下存在则跳过
            let existsInNs = false;
            if (fs.existsSync(newDir)) {
                for (const ns of fs.readdirSync(newDir)) {
                    if (fs.existsSync(path.join(newDir, ns, `${chatId}.json`))) {
                        existsInNs = true;
                        break;
                    }
                }
            }
            if (existsInNs) continue;
            const src = path.join(legacyDir, f);
            fs.copyFileSync(src, dst);
            deps.logger?.info?.(`[智能对话] 已迁移会话 ${chatId}`);
        }
    } catch (e) {
        deps.logger?.warn?.('[智能对话] 迁移旧会话失败:', e?.message || e);
    }
}

/**
 * 艾特本机且带有效内容（文字或已记录图片占位）→ 立即访问。
 */
export function shouldFlushByAtBot(
    event: Record<string, unknown>,
    atQqs: string[] | undefined,
    text: string,
): boolean {
    const selfId = String(event?.self_id ?? '').trim();
    if (!selfId) return false;
    if (!String(text || '').trim()) return false;
    const ats = Array.isArray(atQqs) ? atQqs : [];
    return ats.some((q) => String(q).trim() === selfId);
}

function isAtBotEvent(event: Record<string, unknown>, atQqs: string[]): boolean {
    const selfId = String(event?.self_id ?? '').trim();
    if (!selfId) return false;
    return (atQqs || []).some((q) => String(q).trim() === selfId);
}

/**
 * 异步补充统一入口（识图 / 文件）：把宿主读出来的内容再入缓冲。
 * tag 只影响日志，行为完全一致。
 */
function handleAsyncSupplement(deps: SmartChatDeps, entry: SmartChatBufferEntry, tag: string): void {
    const snap = entry.eventSnapshot || {};
    if (isSmartChatBlacklistedForEvent(deps, snap as Record<string, unknown>)) {
        deps.logger?.info?.(`[智能对话·黑户] ${tag}补充已跳过`);
        return;
    }
    let chatId = chatIdFromEvent(snap);
    if (!chatId || chatId === 'g_undefined' || chatId === 'p_undefined') {
        chatId = snap.message_type === 'group'
            ? `g_${snap.group_id}`
            : `p_${snap.user_id}`;
    }
    if (!chatId || chatId === 'g_undefined' || chatId === 'p_undefined') {
        deps.logger?.warn?.(`[智能对话·${tag}] 补充无法定位 chatId，已丢弃`);
        return;
    }
    const pending = appendChatBuffer(deps, chatId, entry);
    const force = Boolean(entry.forceFlush);
    deps.logger?.info?.(
        `[智能对话·${tag}] ${chatId} 已写入补充（缓冲 ${pending.length} 条${force ? '，艾特后立即访问' : ''}）: ${String(entry.text || '').slice(0, 80)}`,
    );
    if (force) {
        invalidateFlushTimer(chatId);
        // 访问进行中：留给 finally leftover（带 forceFlush）再触发
        if (busyChats.get(chatId)) return;
        flushChat(deps, chatId, { force: true }).catch((e) =>
            deps.logger?.error?.(`[智能对话] 艾特${tag}补充 flush 失败:`, e),
        );
        return;
    }
    // 仅@模式下的补充：只留在缓冲里当背景，等真被 @ 时一起上传
    if (entry.quiet) return;
    scheduleFlush(deps, chatId);
}

function handleImageSupplement(deps: SmartChatDeps, entry: SmartChatBufferEntry): void {
    handleAsyncSupplement(deps, entry, '识图');
}

function handleFileSupplement(deps: SmartChatDeps, entry: SmartChatBufferEntry): void {
    handleAsyncSupplement(deps, entry, '文件');
}

export type SmartChatIngestResult = {
    /** 本轮是否已入队/触发对话 */
    handled: boolean;
    /** 是否仅 AI 对话（宿主应中断后续处理） */
    aiOnly: boolean;
};

export async function smartChatIngest(deps: SmartChatDeps, event: Record<string, unknown>): Promise<SmartChatIngestResult> {
    const empty: SmartChatIngestResult = { handled: false, aiOnly: false };
    if (!deps) return empty;
    migrateLegacySmartChat(deps);

    const config = loadSmartChatConfig(deps);
    const enabled = isEventEnabled(deps, event, config);
    // 仅 AI：只有聊天开关也开启时才截断后续流水线，避免「只开仅AI、没开聊天」把群管全掐死
    const aiOnly = enabled && isSmartChatAiOnlyForEvent(deps, event);

    const 自触开关 = readB(deps, 'config.json', '自触开关', false);
    if (event.self_id === event.user_id && !自触开关) {
        return { handled: false, aiOnly };
    }

    // 黑户：群整群跳过；用户在群聊/私聊均不记录、不访问 API（含艾特）
    if (isSmartChatBlacklistedForEvent(deps, event)) {
        deps.logger?.info?.(
            `[智能对话·黑户] 跳过 group=${event.group_id ?? '-'} user=${event.user_id ?? '-'}`,
        );
        return { handled: false, aiOnly: false };
    }

    const plainText = String(deps.eventUserTextFromSegments(event) || '').trim();
    const inbound = extractInboundMeta(event);
    const atBot = isAtBotEvent(event, inbound.atQqs);
    const imageOn = isSmartChatImageForEvent(deps, event);
    const imgSettings = config.image_recognize;
    const imageUrls = imageOn ? extractImageHttpUrls(event.message) : [];
    const messageId = event.message_id != null ? String(event.message_id) : '';
    const imagePlan = planImageHandling({
        enabled: imageOn,
        urls: imageUrls,
        isAtBot: atBot,
        messageId,
        settings: imgSettings,
    });
    if (imagePlan.skipReason) {
        deps.logger?.info?.(`[智能对话·识图] ${imagePlan.skipReason} msgid=${messageId || '-'}`);
    }

    // 群文件（仅群聊 + 后台「识别文件」开启）：白名单后缀才落盘读字，任何情况都不执行
    const fileOn = isSmartChatFileForEvent(deps, event);
    const filePlan = planFileHandling({
        enabled: fileOn,
        files: fileOn ? extractInboundFiles(event) : [],
        messageId,
    });
    if (filePlan.skipReason) {
        deps.logger?.info?.(`[智能对话·文件] ${filePlan.skipReason} msgid=${messageId || '-'}`);
    }

    let text = plainText;
    if (imagePlan.recordImages && imagePlan.placeholderLine) {
        text = plainText
            ? `${plainText}\n${imagePlan.placeholderLine}`
            : imagePlan.placeholderLine;
    }
    if (filePlan.record && filePlan.placeholderLine) {
        text = text
            ? `${text}\n${filePlan.placeholderLine}`
            : filePlan.placeholderLine;
    }

    // 无文字、无图片占位、也无文件登记：不入队（纯艾特仍跳过）
    if (!String(text || '').trim()) {
        return { handled: false, aiOnly };
    }

    if (!enabled) {
        return { handled: false, aiOnly: false };
    }

    const chatId = chatIdFromEvent(event);
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    let inboundMeta = inbound;
    if (inbound.replyToId) {
        try {
            const buf = loadChatBuffer(deps, chatId);
            const sess = loadSession(deps, chatId, config);
            inboundMeta = await enrichReplyMeta(deps, inbound, { buffer: buf, session: sess });
        } catch (e: unknown) {
            deps.logger?.warn?.(
                '[智能对话] 引用补全失败:',
                e instanceof Error ? e.message : e,
            );
        }
    }

    const isGroup = String(event.message_type || '') === 'group' || Boolean(event.group_id);
    const groupRole = isGroup
        ? normalizeGroupRole((event.sender as { role?: unknown })?.role)
        : undefined;
    // 群专属头衔：仅群聊有；没挂头衔的人这里就是空串 → 不写入 entry
    const groupTitle = isGroup
        ? normalizeGroupTitle((event.sender as { title?: unknown })?.title)
        : '';

    const entry: SmartChatBufferEntry = {
        userId: String(event.user_id || ''),
        nickname: String(
            (event.sender as { card?: string; nickname?: string })?.card
            || (event.sender as { nickname?: string })?.nickname
            || event.user_id
            || '',
        ),
        text,
        time: timeStr,
        messageId: messageId || undefined,
        groupRole,
        groupTitle: groupTitle || undefined,
        replyToId: inboundMeta.replyToId,
        replyToUserId: inboundMeta.replyToUserId,
        replyToNickname: inboundMeta.replyToNickname,
        replyToSnippet: inboundMeta.replyToSnippet,
        atQqs: inboundMeta.atQqs.length ? inboundMeta.atQqs : undefined,
        eventSnapshot: snapshotEvent(event),
    };
    rememberInboundAsQuoteTarget(entry);

    // 群文件下载任务：quiet=true 时只补进缓冲、不排程访问（仅@模式）
    const enqueuePlannedFiles = (quiet: boolean): void => {
        if (!filePlan.record || !filePlan.jobs.length) return;
        const gid = groupIdFromEvent(event) || String(event.group_id || '');
        if (!gid) return;
        const jobs: FileJobMeta[] = filePlan.jobs.map((j) => ({
            chatId,
            scopeId: gid,
            groupId: gid,
            messageId: messageId || 'unknown',
            file: j.file,
            inline: j.inline,
            userId: entry.userId,
            nickname: entry.nickname,
            time: timeStr,
            timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
            forceFlushAfter: atBot && !quiet,
            quiet,
            eventSnapshot: entry.eventSnapshot,
        }));
        const n = enqueueFileJobs(jobs);
        if (n) {
            deps.logger?.info?.(
                `[智能对话·文件] ${chatId} 已排队 ${n} 个文件任务 msgid=${messageId || '-'}${quiet ? '（仅@模式：不触发访问）' : ''}`,
            );
        }
    };

    // 仅 @ 触发模式：防抖 / 最大合并均不生效，仅被 @ 时回应。
    // 未被 @ 的消息按「记录其他消息」子开关决定是否记入缓冲，且一律不排程 flush、不做识图触发。
    const atOnly = isSmartChatAtOnlyForEvent(deps, event);
    if (atOnly && !atBot) {
        if (isSmartChatAtOnlyRecordForEvent(deps, event)) {
            const recorded = appendChatBuffer(deps, chatId, entry);
            // 仅 @ 模式无防抖计时兜底，长期无人 @ 时缓冲会无限增长：只保留最近若干条作背景
            const cap = Math.max(20, Number(config.max_batch) || 12);
            if (recorded.length > cap) {
                saveChatBuffer(deps, chatId, recorded.slice(-cap));
            }
            enqueuePlannedFiles(true);
        }
        return { handled: false, aiOnly: false };
    }

    const pending = appendChatBuffer(deps, chatId, entry);

    if (imagePlan.recordImages && imagePlan.urls.length) {
        const timeoutMs = Math.round(Number(imgSettings?.timeout_sec || 30) * 1000);
        const jobs: ImageJobMeta[] = imagePlan.urls.map((url, i) => ({
            chatId,
            messageId: messageId || 'unknown',
            index: i + 1,
            total: imagePlan.urls.length,
            url,
            isAt: atBot,
            forceFlushAfter: atBot,
            timeoutMs,
            userId: entry.userId,
            nickname: entry.nickname,
            time: timeStr,
            eventSnapshot: entry.eventSnapshot,
        }));
        await enqueueImageJobs(jobs, imgSettings);
    }

    enqueuePlannedFiles(false);

    const forceByAt = shouldFlushByAtBot(event, inbound.atQqs, text);
    if (forceByAt) {
        invalidateFlushTimer(chatId);
        deps.logger?.info?.(`[智能对话] ${chatId} 艾特触发立即访问（含缓冲 ${pending.length} 条）`);
        await flushChat(deps, chatId, { force: true });
        return { handled: true, aiOnly };
    }
    if (shouldFlushByBatchCount(pending.length, config.max_batch)) {
        // 满批/概率提前：以前是 0 秒发请求（只剩模型耗时），太像「凑够一串就秒接」。
        // 改成摊 5-45 秒反应延迟；被 @ 走上面那支，仍然秒回。
        scheduleReactionFlush(deps, chatId);
        return { handled: true, aiOnly };
    }

    scheduleFlush(deps, chatId);
    return { handled: true, aiOnly };
}

/**
 * 群文件上传通知（OneBot notice: group_upload；NapCat 走这条）。
 * 把群文件当消息段下发的协议端（部分 SnowLuma 配置）走 smartChatIngest 的 file 段分支。
 * 仅群聊；未开「识别文件」时直接返回，一个字都不记。
 */
export async function smartChatIngestNotice(
    deps: SmartChatDeps,
    event: Record<string, unknown>,
): Promise<boolean> {
    if (!deps || !event) return false;
    const noticeType = String((event as { notice_type?: unknown }).notice_type || '').trim();
    if (noticeType !== 'group_upload') return false;
    const groupId = String(event.group_id || '').trim();
    const userId = String(event.user_id || '').trim();
    if (!groupId) return false;

    // 伪装成群消息事件：开关判定 / 快照 / chatId 全复用群聊那一套
    const shim: Record<string, unknown> = {
        message_type: 'group',
        group_id: event.group_id,
        user_id: event.user_id,
        self_id: event.self_id,
        message_id: event.message_id ?? '',
        sender: (event.sender as Record<string, unknown>) || { user_id: event.user_id },
        message: [],
        raw_message: '',
    };

    const 自触开关 = readB(deps, 'config.json', '自触开关', false);
    if (userId && String(event.self_id || '') === userId && !自触开关) return false;
    if (isSmartChatBlacklistedForEvent(deps, shim)) {
        deps.logger?.info?.(`[智能对话·黑户] 跳过群文件通知 group=${groupId} user=${userId || '-'}`);
        return false;
    }

    const config = loadSmartChatConfig(deps);
    if (!isSmartChatEnabledForEvent(deps, shim, config)) return false;
    if (!isSmartChatFileForEvent(deps, shim)) return false;

    const messageId = String(event.message_id ?? '').trim()
        || `up${Math.floor(Date.now() / 1000) % 1000000}`;
    const filePlan = planFileHandling({
        enabled: true,
        files: extractInboundFiles(event),
        messageId,
    });
    if (filePlan.skipReason) {
        deps.logger?.info?.(`[智能对话·文件] ${filePlan.skipReason} group=${groupId}`);
        return false;
    }
    if (!filePlan.record || !filePlan.placeholderLine) return false;

    const chatId = `g_${groupId}`;
    // 通知事件没有 sender.card：拿本群缓冲里最近一次同 QQ 的昵称顶上
    let nickname = String(
        (event.sender as { card?: string; nickname?: string })?.card
        || (event.sender as { nickname?: string })?.nickname
        || '',
    ).trim();
    if (!nickname) {
        try {
            const buf = loadChatBuffer(deps, chatId);
            for (let i = buf.length - 1; i >= 0; i -= 1) {
                if (String(buf[i]?.userId || '') === userId && String(buf[i]?.nickname || '').trim()) {
                    nickname = String(buf[i].nickname).trim();
                    break;
                }
            }
        } catch { /* ignore */ }
    }
    if (!nickname) nickname = userId || '群友';

    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const entry: SmartChatBufferEntry = {
        userId,
        nickname,
        text: filePlan.placeholderLine,
        time: timeStr,
        messageId,
        eventSnapshot: snapshotEvent(shim),
    };

    // 仅@模式：文件照记，但不排程访问
    const quiet = isSmartChatAtOnlyForEvent(deps, shim);
    if (quiet && !isSmartChatAtOnlyRecordForEvent(deps, shim)) return false;
    if (quiet) entry.quiet = true;
    const pending = appendChatBuffer(deps, chatId, entry);
    if (filePlan.jobs.length) {
        const jobs: FileJobMeta[] = filePlan.jobs.map((j) => ({
            chatId,
            scopeId: groupId,
            groupId,
            messageId,
            file: j.file,
            inline: j.inline,
            userId,
            nickname,
            time: timeStr,
            timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
            forceFlushAfter: false,
            quiet,
            eventSnapshot: entry.eventSnapshot,
        }));
        const n = enqueueFileJobs(jobs);
        deps.logger?.info?.(
            `[智能对话·文件] ${chatId} 群文件通知已排队 ${n}/${jobs.length} 个任务（缓冲 ${pending.length} 条）`,
        );
    }
    if (!quiet) scheduleFlush(deps, chatId);
    return true;
}

export function createSmartChatRuntime(deps: SmartChatDeps) {    migrateLegacySmartChat(deps);
    bindNvidiaRateDeps(deps);
    bindRotationDeps(deps);
    bindSmartChatImageRuntime(
        (entry) => handleImageSupplement(deps, entry),
        deps.logger,
    );
    bindSmartChatImageVision(
        () => loadSmartChatConfig(deps),
        () => deps.getDataPath(),
    );
    bindSmartChatFileRuntime(
        deps,
        (entry) => handleFileSupplement(deps, entry),
        deps.logger,
    );
    try {
        ensureBuiltinKnowledge(deps);
    } catch (e) {
        deps.logger?.warn?.('[智能对话] 内置技能树写入失败:', e?.message || e);
    }
    return {
        ingest: (event: Record<string, unknown>) => smartChatIngest(deps, event),
        ingestNotice: (event: Record<string, unknown>) => smartChatIngestNotice(deps, event),
        flushChat: (chatId: string) => flushChat(deps, chatId),
        getConfig: () => loadSmartChatConfig(deps),
        getUsageSummary: () => getUsageSummary(deps),
        fetchBalance: (force?: boolean) => fetchBalance(loadSmartChatConfig(deps), force, deps),
        clearSession: (chatId: string) => clearSession(deps, chatId),
        clearBuffer: (chatId: string) => clearChatBuffer(deps, chatId),
        listSessionIds: () => listSessionIds(deps),
    };
}

export type SmartChatRuntime = ReturnType<typeof createSmartChatRuntime>;

let defaultRuntime: SmartChatRuntime | null = null;

export function initSmartChatRuntime(deps: SmartChatDeps): SmartChatRuntime {
    // 重载后 module 状态可能残留：先清掉上一轮挂着的随机计时，从零重抽
    const cleared = resetFlushTimers();
    if (cleared) deps.logger?.info?.(`[智能对话] 重载：已清除 ${cleared} 个残留等待计时`);
    defaultRuntime = createSmartChatRuntime(deps);
    // 启动时尝试拉一次登录昵称并写入 identity.json；失败则等首轮 flush 再试
    ensureBotIdentity(deps).catch((e) => {
        deps.logger?.warn?.('[智能对话] 启动拉取登录昵称失败:', e?.message || e);
    });
    return defaultRuntime;
}

/** 卸载/重载前调用：撤掉所有随机等待计时（消息缓存留在磁盘，不丢） */
export function shutdownSmartChatRuntime(): number {
    defaultRuntime = null;
    return resetFlushTimers();
}

export function getSmartChatRuntime(): SmartChatRuntime | null {
    return defaultRuntime;
}
