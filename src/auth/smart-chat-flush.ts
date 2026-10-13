// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — flush / 防抖调度
// ---------------------------------------------------------------------------

import type { SmartChatBufferEntry, SmartChatDeps } from './smart-chat-types';
import { loadSmartChatConfig } from './smart-chat-config';
import { appendChatBuffer, loadChatBuffer, saveChatBuffer, takeChatBuffer } from './smart-chat-buffer';
import {
    composeTurn,
    detectReplyPreference,
    detectSpeakPreference,
    parseBufferTimeMs,
    recordSentApiPrefix,
    resolveFrozenSkillTree,
    sortBatchByTime,
} from './smart-chat-compose';
import {
    resolveStickerAbsolutePath,
    fuzzyResolveStickerInGallery,
    buildStickerSystemSuffix,
    stickerGalleryInstallKey,
    buildSendStickerOpenAiTool,
    buildListStickersOpenAiTool,
    runListStickers,
    SEND_STICKER_TOOL_NAME,
    scrubStickerHonestyActions,
    batchWantsStickerText,
    buildForceSendStickerToolChoice,
    filterCooldownStickers,
    pushRecentStickers,
    normalizeRecentStickers,
} from './smart-chat-sticker';
import { searchKnowledgeTopM, selectLoreByKeys, ensureBuiltinKnowledge } from './smart-chat-knowledge';
import {
    loadChatMemory,
    saveChatMemory,
    touchPeopleFromBatch,
    recallMemoryBlock,
} from './smart-chat-memory';
import { chatCompletion, looksLikeToolMarkup, mergeUsage, stripToolMarkup, isContextOverflowError, modelHasNativeThinking } from './smart-chat-provider';
import { forceCompactForOverflow, maybeCompactSession } from './smart-chat-compact';
import {
    estimateMessagesTokens,
    nvidiaContextBudget,
    NVIDIA_CONTEXT_PRECHECK_RATIO,
} from './smart-chat-nvidia-context';
import { resolveCompactionBudget } from './smart-chat-token-meter';
import { applyActionLimits, refineOutboundByScene, inferToolPreambleTexts, extractGroupSafeStatusTexts, extractThinkTexts, stripReplyAttrsFromContent } from './smart-chat-reply';
import {
    buildMkApiOpenAiTools,
    contentHasMkApi,
    executeMkApiCalls,
    executeMkApiFunctionCall,
    parseMkApiCalls,
    stripMkApiTags,
} from '../ai/index.js';
import { isMkApiToolEnabled } from './smart-chat-mkapi';
import {
    buildMkApiFileBridge,
    buildSpillHint,
    spillTextToScope,
    SPILL_INLINE_HEAD_CHARS,
} from './smart-chat-file';
import { appendSessionTurn, applySessionChatMeta, loadSession, saveSession, getActiveSessionNamespace } from './smart-chat-session';
import { recordUsage } from './smart-chat-billing';
import {
    getSmartChatRoundsForEvent,
    isSmartChatImageForEvent,
    isSmartChatFileForEvent,
    isSmartChatStickerForEvent,
    isSmartChatToolsForEvent,
    isSmartChatFakeThinkForEvent,
    isSmartChatAllowVoiceForEvent,
    loadConfigForChat,
    needsPersonaFusionForChat,
    isPersonaFusionReady,
    currentPersonaFusionHash,
} from './smart-chat-switches';
import { runPersonaFusionWarmup } from './smart-chat-persona-fusion';
import {
    SMART_CHAT_TOOLS,
    buildToolChoice,
    executeToolCalls,
    toolsShouldAttach,
} from './smart-chat-tools';
import { ensureBotIdentity, getBotNickname } from './smart-chat-identity';
import {
    ensureSessionBotPresence,
    resolveSessionBotDisplayNick,
} from './smart-chat-presence';
import {
    dropTrailingSoftFollowUp,
    looksLikeAuthorImpersonation,
    AUTHOR_IMPERSONATION_SHORT_MSG,
    looksLikeCustomerServiceText,
    looksLikeTechHowtoText,
    stripCustomerServiceTone,
    rewriteEnglishRefusal,
    looksLikeImageLoadExposureText,
} from './smart-chat-safety';
import { buildSilenceVetoSeed, decideSilence, refreshPreferSilence } from './smart-chat-silence';
import {
    resolveSessionChatMeta,
    rebuildEventFromSnapshot,
    executeAssistantActions,
    batchAtsBot,
    hasRealTextMsg,
    actionsToAssistantStoreContent,
    mergeToolStickersIntoStore,
    appendQueuedStickers,
    parseOutboundActions,
} from './smart-chat-outbound';
import {
    synthesizeVoice,
    voiceReadyText,
    voiceMaxChars,
    resolveVoiceEngine,
    VOICE_MAX_SEGMENTS,
} from './smart-chat-voice';

interface TimerState {
    timer: ReturnType<typeof setTimeout> | null;
    /** 本次抽到的等待值（ms）；随机模式下用于日志与验收 */
    waitMs?: number;
    /** 本次计时起算时刻（ms epoch）：每来一条新消息就重置为此刻 */
    armedAt?: number;
    /**
     * 反应延迟的目标触发时刻（ms epoch）。满批/概率触发装载后，
     * 后续新消息不再重抽（否则活跃群里每来一条就把访问往后推，永远发不出去）。
     */
    reactAt?: number;
    /**
     * 计时代数：每次重抽 +1。旧计时到期后发现代数已变就自己作废，
     * 不依赖 clearTimeout 一定赢（Node 里已入队的回调 clearTimeout 拦不住）。
     */
    seq?: number;
}

export const busyChats = new Map<string, boolean>();
export const chatTimers = new Map<string, TimerState>();

/**
 * 失败退避状态：上游失败后把整批放回缓冲，并按指数退避重试。
 *
 * 为什么不直接重排一次 flush：失败是「上游/网络坏了」，立刻再打只会连刷失败请求，
 * 而 `scheduleFlush` 抽的是 1–30 分钟随机等待，等于把重试拖到半小时后。
 * 这里给 5s 起、每次翻倍、封顶 60s 的确定性退避。
 */
const flushFailures = new Map<string, number>();
const flushNotBefore = new Map<string, number>();
export const FLUSH_RETRY_BASE_MS = 5000;
export const FLUSH_RETRY_MAX_MS = 60000;

/** 记一次失败：返回本次退避时长（ms） */
function noteFlushFailure(chatId: string): number {
    const n = (Number(flushFailures.get(chatId)) || 0) + 1;
    flushFailures.set(chatId, n);
    const delay = Math.min(
        FLUSH_RETRY_MAX_MS,
        FLUSH_RETRY_BASE_MS * 2 ** Math.min(6, n - 1),
    );
    flushNotBefore.set(chatId, Date.now() + delay);
    return delay;
}

function noteFlushSuccess(chatId: string): void {
    flushFailures.delete(chatId);
    flushNotBefore.delete(chatId);
}

/** 距退避结束还剩多久（ms）；0 = 可以打了 */
export function flushRetryDelayMs(chatId: string): number {
    const at = Number(flushNotBefore.get(chatId)) || 0;
    return Math.max(0, at - Date.now());
}

/**
 * 把已经 takeChatBuffer 出盘的批次放回缓冲（失败路径专用）。
 * - 顺序：batch（更旧）在前，flush 期间新到的消息在后
 * - 按 messageId 去重，避免重试把同一条放回两遍
 * 返回实际放回的条数。
 */
function restoreBatchToBuffer(
    deps: SmartChatDeps,
    chatId: string,
    batch: SmartChatBufferEntry[],
): number {
    if (!batch?.length) return 0;
    const now = loadChatBuffer(deps, chatId);
    const existing = new Set(
        now.map((e) => String(e?.messageId || '').trim()).filter(Boolean),
    );
    const back = batch.filter((e) => {
        const id = String(e?.messageId || '').trim();
        return !id || !existing.has(id);
    });
    if (!back.length) return 0;
    saveChatBuffer(deps, chatId, [...back, ...now]);
    return back.length;
}

/**
 * 失败/退避重试计时器：与 scheduleReactionFlush 同款幂等 —— 已装载且未到点的计时
 * 不被重排，免得把更早的触发点往后推。
 */
function scheduleRetryFlush(deps: SmartChatDeps, chatId: string, delayMs: number): void {
    let state = chatTimers.get(chatId);
    if (!state) {
        state = { timer: null, seq: 0 };
        chatTimers.set(chatId, state);
    }
    const now = Date.now();
    if (state.timer && Number(state.reactAt) > now) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.seq = (Number(state.seq) || 0) + 1;
    const mySeq = state.seq;
    const delay = Math.max(1000, Number(delayMs) || FLUSH_RETRY_BASE_MS);
    state.waitMs = delay;
    state.armedAt = now;
    state.reactAt = now + delay;
    deps.logger?.warn?.(
        `[智能对话] ${chatId} 退避 ${Math.round(delay / 1000)} 秒后重试（消息已放回缓冲）`,
    );
    state.timer = setTimeout(() => {
        if (chatTimers.get(chatId) !== state || state.seq !== mySeq) return;
        state.timer = null;
        state.reactAt = 0;
        const pending = loadChatBuffer(deps, chatId);
        if (!pending.length) return;
        flushChat(deps, chatId).catch((e) =>
            deps.logger?.error?.('[智能对话] 退避重试 flush 失败:', e),
        );
    }, delay);
}

/**
 * 失败收尾：放回缓冲 + 记失败 + 挂退避重试。返回放回条数。
 * @param tag 日志用的人话原因
 */
function handleFlushFailure(
    deps: SmartChatDeps,
    chatId: string,
    batch: SmartChatBufferEntry[],
    tag: string,
): number {
    const back = restoreBatchToBuffer(deps, chatId, batch);
    const delay = noteFlushFailure(chatId);
    deps.logger?.warn?.(
        `[智能对话] ${chatId} ${tag}：已放回缓冲 ${back}/${batch.length} 条，`
        + `${Math.round(delay / 1000)} 秒后重试`,
    );
    scheduleRetryFlush(deps, chatId, delay);
    return back;
}

/** 概率提前访问的起算条数（含）：缓冲到第 8 条起才开始按递增概率随机提前 */
export const PROB_FLUSH_MIN_BATCH = 8;

/**
 * 插件重载/卸载时清空随机计时记录：
 * 把挂着的 setTimeout 全部撤掉并清空 chatTimers，让重载后从零重抽。
 * 故意不动 busyChats：飞行中的 flush 仍应挡住并发访问（保 prepend-only 前缀）。
 */
export function resetFlushTimers(): number {
    let cleared = 0;
    for (const state of chatTimers.values()) {
        if (state?.timer) {
            clearTimeout(state.timer);
            state.timer = null;
            cleared += 1;
        }
    }
    chatTimers.clear();
    // 失败退避也一起清：重载后从零开始，别让上一轮的退避窗口压住新进程
    flushFailures.clear();
    flushNotBefore.clear();
    return cleared;
}

/**
 * 撤掉某个会话挂着的等待计时并让已入队的旧回调作废（消息缓存不动）。
 * 满批/艾特/识图补充这类「立即访问」的入口用它，避免旧计时在访问后抢跑一次。
 */
export function invalidateFlushTimer(chatId: string): void {
    const state = chatTimers.get(chatId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.reactAt = 0;
    state.seq = (Number(state.seq) || 0) + 1;
}

/**
 * 满批/概率触发的「人类反应延迟」区间。
 *
 * 为什么要有：满批与「≥8 条概率提前」这两条路以前是 0 秒发起请求，从最后一条消息
 * 落地到开口只剩模型生成耗时，方差极小 —— 盯着看的人会发现「凑够一串它就秒接」。
 * 被 @ 不走这里（叫到名字还慢半分钟反而更怪），仍然立即访问。
 */
export const REACTION_DELAY_MIN_MS = 5000;
export const REACTION_DELAY_MAX_MS = 45000;

/** 反应延迟抽样：[5s, 45s] 均匀，rnd 可注入供验收断言 */
export function pickReactionDelayMs(rnd: () => number = Math.random): number {
    let r = Number(rnd());
    if (!Number.isFinite(r) || r < 0) r = 0;
    if (r >= 1) r = 1 - Number.EPSILON;
    const span = REACTION_DELAY_MAX_MS - REACTION_DELAY_MIN_MS;
    return REACTION_DELAY_MIN_MS + Math.floor(r * (span + 1));
}

/**
 * 随机等待抽样：在 [minMs, maxMs] 上按「整分钟」均匀抽样（1-30 分钟 → 抽出 4 就是 4 分钟）。
 * rnd 可注入，验收脚本用固定序列断言，避免不可复现。
 */
export function pickRandomWaitMs(minMs: number, maxMs: number, rnd: () => number = Math.random): number {
    const lo = Math.max(1000, Number(minMs) || 0);
    const hi = Math.max(lo, Number(maxMs) || 0);
    const loMin = Math.max(1, Math.round(lo / 60000));
    const hiMin = Math.max(loMin, Math.round(hi / 60000));
    const span = hiMin - loMin + 1;
    let r = Number(rnd());
    if (!Number.isFinite(r) || r < 0) r = 0;
    if (r >= 1) r = 1 - Number.EPSILON;
    return (loMin + Math.floor(r * span)) * 60000;
}

/**
 * 秒级抖动：抽样落在整分钟上，实际等待再摊 ±30 秒。
 *
 * 为什么要加：整分钟等待本身是可观测规律 —— 盯时间戳的人会发现「回复时刻 - 最后一条
 * 消息时刻」永远是整数分钟。抖动后同一个抽样值每次落点都不同，抽到 4 分钟表现为
 * 3 分 31 秒到 4 分 30 秒之间，读日志仍是「抽到 4 分钟」。
 * 下限保护：抖完不许低于 minMs（否则抽到 1 分钟可能变 30 秒，比人类反应还快）。
 */
export function jitterWaitMs(
    ms: number,
    minMs: number,
    maxMs: number,
    rnd: () => number = Math.random,
): number {
    const base = Math.max(0, Number(ms) || 0);
    const lo = Math.max(1000, Number(minMs) || 0);
    const hi = Math.max(lo, Number(maxMs) || 0);
    let r = Number(rnd());
    if (!Number.isFinite(r) || r < 0) r = 0;
    if (r >= 1) r = 1 - Number.EPSILON;
    const offset = Math.floor(r * 60000) - 30000; // [-30s, +30s)
    return Math.min(hi, Math.max(lo, base + offset));
}

/**
 * 本次该等多久（ms）。
 * 随机模式关：沿用 1.3.1 的固定 debounce_ms。
 * 随机模式开：抽 1-30 分钟（再摊 ±30 秒抖动，见 jitterWaitMs），
 *   但被「最老一条的硬上限」收口 ——
 *   硬上限 = max(batch_max_age_ms, random_wait_max_ms)，
 *   这样现存的 batch_max_age_ms=2 分钟不会把随机等待压回 2 分钟（否则新功能等于没开），
 *   同时活跃群里最老那条也不会因为不断重抽被无限期饿着。
 * 被上限收口的那次不抖动：waitMs 已经是「还差多久到硬上限」，抖动会越线。
 */
export function resolveFlushDelay(
    config: Record<string, unknown>,
    oldestAgeMs?: number,
    rnd: () => number = Math.random,
): { mode: 'debounce' | 'random'; waitMs: number; drawMs: number; capped: boolean } {
    const enabled = config?.random_wait_enabled !== false;
    if (!enabled) {
        const d = Math.max(0, Number(config?.debounce_ms) || 0);
        return { mode: 'debounce', waitMs: d, drawMs: d, capped: false };
    }
    const minMs = Math.max(1000, Number(config?.random_wait_min_ms) || 60000);
    const maxMs = Math.max(minMs, Number(config?.random_wait_max_ms) || 1800000);
    const drawMs = pickRandomWaitMs(minMs, maxMs, rnd);
    const jittered = jitterWaitMs(drawMs, minMs, maxMs, rnd);

    const hardCap = Math.max(Number(config?.batch_max_age_ms) || 0, maxMs);
    const age = Number(oldestAgeMs);
    if (!Number.isFinite(age) || hardCap <= 0) {
        return { mode: 'random', waitMs: jittered, drawMs, capped: false };
    }
    const remain = hardCap - age;
    if (remain <= 0) return { mode: 'random', waitMs: 0, drawMs, capped: true };
    if (drawMs > remain) return { mode: 'random', waitMs: Math.max(1000, remain), drawMs, capped: true };
    // 抖动可能把等待推过硬上限，收口到剩余时间
    return { mode: 'random', waitMs: Math.min(jittered, remain), drawMs, capped: false };
}

/**
 * 缓冲里最老一条的年龄（ms，相对现在）；没有可解析时间戳时返回 NaN。
 * NaN 时调用方退回「只看满批」的老口径，不误判超龄。
 */
export function oldestPendingAgeMs(pending: SmartChatBufferEntry[], nowMs = Date.now()): number {
    let oldest = Number.NaN;
    for (const b of pending || []) {
        const t = parseBufferTimeMs(b?.time);
        if (!Number.isFinite(t)) continue;
        if (!Number.isFinite(oldest) || t < oldest) oldest = t;
    }
    if (!Number.isFinite(oldest)) return Number.NaN;
    return Math.max(0, Number(nowMs) - oldest);
}

/**
 * 防抖到期是否允许 flush：满批，或最老一条已经超过 batch_max_age_ms。
 * 超龄逃生口是 1.3.1 新增：1.3.0 未满批直接 return 且不再续倒计时，
 * 实测把 9 条跨 147 分钟、8 条跨 191 分钟的杂消息攒成一批，
 * 模型面对一堆互不相关的旧消息只能逐条点评（narrator 从 1% 涨到 53%）。
 */
export function shouldFlushOnDebounce(
    pendingCount: number,
    maxBatch: number,
    oldestAgeMs?: number,
    maxAgeMs?: number,
): boolean {
    const cap = Math.min(25, Math.max(1, Number(maxBatch) || 1));
    const n = Math.max(0, Number(pendingCount) || 0);
    if (n <= 0) return false;
    if (n >= cap) return true;
    const age = Number(oldestAgeMs);
    const limit = Number(maxAgeMs);
    if (!Number.isFinite(age) || !Number.isFinite(limit) || limit <= 0) return false;
    return age >= limit;
}

/**
 * 入队时提前 flush 策略：
 * - 达到 max_batch：必定 flush
 * - max_batch ≤ PROB_FLUSH_MIN_BATCH(8)：未达上限不提前
 * - max_batch ∈ [9,25]：从第 8 条起递增概率随机提前；未满 8 条不提前
 * 随机等待计时不改这里：满批立即触发、>8 条概率触发都照旧。
 */
export function shouldFlushByBatchCount(pendingCount: number, maxBatch: number): boolean {
    const cap = Math.min(25, Math.max(1, Number(maxBatch) || 1));
    const n = Math.max(0, Number(pendingCount) || 0);
    if (n <= 0) return false;
    if (n >= cap) return true;
    if (cap <= PROB_FLUSH_MIN_BATCH) return false;
    if (n < PROB_FLUSH_MIN_BATCH) return false;
    const span = cap - PROB_FLUSH_MIN_BATCH;
    const step = n - PROB_FLUSH_MIN_BATCH;
    const p = (step + 1) / (span + 1);
    return Math.random() < p;
}

export interface FlushChatOptions {
    /**
     * 穿透失败退避：被 @ / 带 forceFlush 的补充（用户正在等）用。
     * 连续失败 ≥3 次后仍受退避约束，免得把坏上游打成雪崩。
     */
    force?: boolean;
}

export async function flushChat(
    deps: SmartChatDeps,
    chatId: string,
    opts?: FlushChatOptions,
): Promise<void> {
    // 访问进行中：只把新消息记入 buffer，不并行再开一次 API（保证 prepend-only 前缀不被并发打乱）
    if (busyChats.get(chatId)) return;
    const pending = loadChatBuffer(deps, chatId);
    if (!pending.length) return;

    // 上一次失败后的退避窗口：消息留在缓冲里，时间到自动重试（不丢批、不连刷失败请求）
    const failures = Number(flushFailures.get(chatId)) || 0;
    const force = Boolean(opts?.force) && failures < 3;
    if (!force) {
        const retryWait = flushRetryDelayMs(chatId);
        if (retryWait > 0) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} 退避中（连续失败 ${failures} 次），`
                + `${Math.ceil(retryWait / 1000)} 秒后再试；消息留在缓冲`,
            );
            scheduleRetryFlush(deps, chatId, retryWait);
            return;
        }
    }

    busyChats.set(chatId, true);
    // 时间戳升序排一次：缓冲顺序实测非单调（有 03:52:59 → 03:52:42），
    // 乱序会让正文时间轴读起来像"倒着说话"，也会污染 talk-graph 的先后关系。
    const batch = sortBatchByTime(takeChatBuffer(deps, chatId));
    /** 本轮是否已写进会话历史：已落盘就不再把 batch 放回，避免同一批被处理两遍 */
    let turnRecorded = false;

    try {
        const baseConfig = loadSmartChatConfig(deps);
        if (!String(baseConfig.api_key || '').trim()) {
            // 没配 key 不是「上游坏了」，但同样不能丢消息：放回 + 退避重试（管理端补齐即会自愈）
            handleFlushFailure(deps, chatId, batch, '未配置 api_key，跳过 flush');
            return;
        }

        const config = loadConfigForChat(deps, chatId, baseConfig);
        /**
         * A① 压缩预算（**所有厂商**，不再只对英伟达）：
         * 窗口 × thresholdRatio（默认 0.8）触发压缩，尾部按 retainRatio（默认 0.16）收。
         * 定义在 batch 日志之前，日志里要打这份预算便于线上核对。
         */
        const compactBudget = resolveCompactionBudget(config as unknown as Record<string, unknown>, {
            vendor: String(config.vendor || ''),
            model: String(config.model || ''),
            nvidiaBudget: String(config.vendor || '') === 'nvidia'
                ? nvidiaContextBudget(config.model)
                : undefined,
        });
        const session = loadSession(deps, chatId, config);
        const queryText = batch.map((b) => b.text).join(' ');
        const replyPref = detectReplyPreference(queryText);
        if (replyPref === 'ban') session.prefer_no_reply = true;
        if (replyPref === 'ask') session.prefer_no_reply = false;
        const speakPref = detectSpeakPreference(queryText);
        if (speakPref === 'ban') {
            session.prefer_silence = true;
            session.prefer_silence_at = new Date().toISOString();
        }
        if (speakPref === 'ask') {
            session.prefer_silence = false;
            delete session.prefer_silence_at;
        }
        // TTL：过期自动解除，避免一次闭嘴整段隐身
        refreshPreferSilence(session);
        // 仅对方禁止引用时剥 reply；平时由模型自己决定要不要引用
        const stripReply = Boolean(session.prefer_no_reply);
        // 先解析群号/群名写入会话对象，再 compose，保证本轮 host-state 就能给模型看
        const chatMeta = await resolveSessionChatMeta(deps, batch, session);
        applySessionChatMeta(session, chatMeta);
        // 本群站位：仅无会话上下文时 get_group_member_info 拉一次并锁定
        const snapForSelf = batch[batch.length - 1]?.eventSnapshot || {};
        if (chatMeta.chat_type === 'group') {
            const locked = await ensureSessionBotPresence(deps, session, {
                groupId: chatMeta.group_id || String(snapForSelf.group_id || ''),
                selfId: String(snapForSelf.self_id || ''),
            });
            // 站位锁定仅写内存；首次 appendSessionTurn 再落盘
            void locked;
        }
        const groupId = batch[0]?.eventSnapshot?.message_type === 'group'
            ? String(batch[0].eventSnapshot.group_id || '')
            : null;
        const lastSnapForRounds = batch[batch.length - 1]?.eventSnapshot || {};
        const historyRounds = getSmartChatRoundsForEvent(deps, lastSnapForRounds);
        const imageRecognize = isSmartChatImageForEvent(deps, lastSnapForRounds);
        // 识别文件：仅群聊；只影响「新文件是否落盘登记」，已存文件照样能被 002 读
        const fileRecognize = isSmartChatFileForEvent(deps, lastSnapForRounds);
        const stickerOutput = isSmartChatStickerForEvent(deps, lastSnapForRounds);
        const allowVoice = isSmartChatAllowVoiceForEvent(deps, lastSnapForRounds);
        const toolsEnabled = isSmartChatToolsForEvent(deps, lastSnapForRounds);
        // 伪装思考：当前群/好友开关；模型自带原生思考则 auto-skip（跳过按模型判，不按会话判）
        const fakeThink = isSmartChatFakeThinkForEvent(deps, lastSnapForRounds);
        const modelNativeThinking = modelHasNativeThinking(config);
        const currentVendor = String(config.vendor || '');
        const currentModel = String(config.model || '');
        let knowledge = searchKnowledgeTopM(deps, queryText, groupId, config.kb_top_m, {
            stickerOutput,
        });
        // 技能树进稳定 system：先冻结，保证人设融合预热与正式访问用同一份 system
        const skillFreeze = resolveFrozenSkillTree(session, knowledge);
        if (skillFreeze.refrozen) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} 技能树已变更，重新冻结 system skillHash=${skillFreeze.hash}（本轮打断一次前缀缓存，历史不动）`,
            );
        }
        const loreEntries = selectLoreByKeys(deps, queryText, groupId, 4);
        const ns = getActiveSessionNamespace(deps, config);
        const mem = loadChatMemory(deps, ns.fingerprint, chatId);
        touchPeopleFromBatch(mem, batch);
        saveChatMemory(deps, ns.fingerprint, chatId, mem);
        const memoryBlock = recallMemoryBlock(mem, batch);
        // 登录昵称：有 identity.json 则直接用；否则本轮最多拉一次 get_login_info
        await ensureBotIdentity(deps);
        const botNickname = resolveSessionBotDisplayNick(session, getBotNickname(deps));

        if (needsPersonaFusionForChat(deps, chatId, config)) {
            const personaHash = currentPersonaFusionHash(deps, chatId, config);
            if (isPersonaFusionReady(session, personaHash)) {
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 人设融合已就绪 personaHash=${personaHash}`,
                );
            } else {
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 人设融合预热开始 personaHash=${personaHash}`,
                );
                const warmup = await runPersonaFusionWarmup(deps, chatId, config, session, {
                    imageRecognize,
                    stickerOutput,
                    toolsEnabled,
                    botNickname,
                });
                if (!warmup.ok) {
                    const detail = warmup.raw
                        ? `\n${warmup.raw}`
                        : '';
                    deps.logger?.warn?.(
                        `[智能对话] ${chatId} 人设融合预热失败`
                        + (warmup.status ? ` status=${warmup.status}` : '')
                        + ` error=${warmup.error || 'unknown'}`
                        + ` latency=${warmup.latency_ms}ms${detail}`,
                    );
                    // 预热失败=上游坏了，不能把用户这批发球权：放回缓冲 + 退避重试
                    handleFlushFailure(deps, chatId, batch, '人设融合预热失败');
                    return;
                }
                session.persona_fusion_hash = personaHash;
                saveSession(deps, chatId, session, config);
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 人设融合预热成功 latency=${warmup.latency_ms}ms → 开始正式访问`,
                );
            }
        }

        // 表情包：细则走 system suffix（cache-stable），不再每轮往 user 灌整份图库技能树
        // 已冻结 sticker=true 时即使本轮聊天开关关掉，仍需 suffix 字节与 system 一致
        const stickerSystemSuffix = (stickerOutput || session.frozen_system_caps?.sticker)
            ? buildStickerSystemSuffix(deps)
            : '';
        const stickerInstallKey = stickerGalleryInstallKey(deps);
        // 「没人对你说话」否决抽样种子：compose 的 host-state 与下面的预判必须抽到同一个值，
        // 否则会出现「面板写着不开口、预判却放行」这种自相矛盾。
        const vetoSeed = buildSilenceVetoSeed(
            chatId,
            Number(session.shut_up_streak || 0),
            batch.map((b) => b?.messageId),
        );
        let composed = composeTurn(config, session, batch, knowledge, historyRounds, {
            imageRecognize,
            stickerOutput,
            stickerSystemSuffix,
            stickerInstallKey,
            toolsEnabled,
            botNickname,
            chatId,
            loreEntries,
            memoryBlock,
            stylePackId: 'groupie',
            fakeThink,
            modelNativeThinking,
            currentVendor,
            currentModel,
        });
        if (composed.cacheReset || historyRounds > 0) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} cache-reset：历史上传轮次=${historyRounds}（不含本轮；显式截断会打断前缀缓存）`,
            );
        }
        const liveTools = toolsShouldAttach(config, toolsEnabled);
        if (
            composed.systemCaps.tools !== liveTools
            || composed.systemCaps.image !== imageRecognize
            || composed.systemCaps.sticker !== stickerOutput
        ) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} system 后缀已冻结 tools=${composed.systemCaps.tools} image=${composed.systemCaps.image} sticker=${composed.systemCaps.sticker}（聊天开关变更不改写本会话前缀）`,
            );
        }
        // 质量回归诊断：batch 聚合时机 + 稳定前缀是否真的稳（对照 scripts/quality-baseline.mjs 指标）
        const batchStamps = batch.map((b) => parseBufferTimeMs(b?.time)).filter((n) => Number.isFinite(n));
        const batchSpanMin = batchStamps.length > 1
            ? Math.round((Math.max(...batchStamps) - Math.min(...batchStamps)) / 60000)
            : 0;
        deps.logger?.info?.(
            `[智能对话] ${chatId} batch=${batch.length}条 跨度=${batchSpanMin}分 sys=${String(composed.systemPrompt || '').length}字 `
            + `prefixStable=${composed.prefixStable} prefixHash=${composed.prefixHash}`
            + `${composed.prefixResetReason ? ` 前缀失配原因=${composed.prefixResetReason}` : ''}`
            + ` 压缩预算=${compactBudget.thresholdTokens}/${compactBudget.retainTokens}tok`
            + `(窗口 ${compactBudget.window} ${compactBudget.source}, 比例 ${compactBudget.thresholdRatio}/${compactBudget.retainRatio})`,
        );

        // 工具挂载与冻结 system 一致，避免「system 写了能用 / FC 没挂」或反之
        const useWebTools = composed.systemCaps.tools && toolsShouldAttach(config, true);
        const mkApiTools = buildMkApiOpenAiTools();
        const stickerTool = composed.systemCaps.sticker ? buildSendStickerOpenAiTool(deps) : null;
        const listStickerTool = composed.systemCaps.sticker ? buildListStickersOpenAiTool(deps) : null;
        const attachedTools = [
            ...mkApiTools,
            ...(stickerTool ? [stickerTool] : []),
            ...(listStickerTool ? [listStickerTool] : []),
            ...(useWebTools ? SMART_CHAT_TOOLS : []),
        ];
        const useFc = attachedTools.length > 0;
        const mkApiCtx = {
            botApi: deps.botApi,
            logger: deps.logger,
            isToolEnabled: (code) => isMkApiToolEnabled(deps, code),
            // 002 号工具的群文件桥：锁死在本群目录；私聊不给（没有群文件）
            file: groupId
                ? buildMkApiFileBridge(deps, {
                    scopeId: groupId,
                    target: { chatType: 'group', groupId },
                    enabled: fileRecognize,
                })
                : null,
        };
        const runMkApi = (name, args) => executeMkApiFunctionCall(mkApiCtx, name, args);
        /** 本轮工具通道已校验入队、待最终出站的表情包相对路径（不即时发群） */
        const pendingStickers: string[] = [];
        const actionMax = Math.max(1, Number(config.action_max) || 3);
        let nonStickerFcUsed = false;
        let stickerAttempts = 0;
        let lastStickerError = '';
        /** B2 强制要图轮后仍未入队 → 出站结构诚实兜底 */
        let stickerHonestyForce = false;
        const failStickerEnqueue = (error: string, pathHint: string, extra?: Record<string, unknown>) => {
            lastStickerError = `${error}${pathHint ? ` path=${pathHint}` : ''}`;
            deps.logger?.warn?.(
                `[智能对话] ${chatId} ${SEND_STICKER_TOOL_NAME} 入队失败 error=${error} path=${pathHint || '(empty)'}`,
            );
            return JSON.stringify({
                error,
                message:
                    error === 'action_limit'
                        ? `本轮最多发 ${actionMax} 张表情包`
                        : error === 'send_unavailable'
                          ? '宿主无法发图'
                          : '路径无效或不存在；请从 [表情包选取规则] 已装前缀里重选',
                path: pathHint,
                ...extra,
            });
        };
        const runSendSticker = async (pathRaw: string): Promise<string> => {
            const pathHint = String(pathRaw || '').trim();
            stickerAttempts += 1;
            if (pendingStickers.length >= actionMax) {
                return failStickerEnqueue('action_limit', pathHint, { queued: pendingStickers.length });
            }
            const resolved = fuzzyResolveStickerInGallery(deps, pathRaw);
            if (!resolved.ok) {
                return failStickerEnqueue(resolved.error || 'invalid_path', pathHint);
            }
            if (resolved.fuzzy) {
                deps.logger?.info?.(
                    `[智能对话] ${chatId} ${SEND_STICKER_TOOL_NAME} 模糊兜底 ${pathHint} → ${resolved.rel}`,
                );
            }
            if (typeof deps.段_图片 !== 'function') {
                return failStickerEnqueue('send_unavailable', pathHint || resolved.rel);
            }
            // 仅校验入队；真正发图放在最终「先字后图」统一出站
            if (pendingStickers.includes(resolved.rel)) {
                lastStickerError = '';
                deps.logger?.info?.(
                    `[智能对话] ${chatId} ${SEND_STICKER_TOOL_NAME} 已排队(重复) ${resolved.rel} (${pendingStickers.length}/${actionMax})`,
                );
                return JSON.stringify({
                    ok: true,
                    queued: true,
                    path: resolved.rel,
                    sent: pendingStickers.length,
                    duplicate: true,
                });
            }
            pendingStickers.push(resolved.rel);
            lastStickerError = '';
            deps.logger?.info?.(
                `[智能对话] ${chatId} ${SEND_STICKER_TOOL_NAME} 已排队 ${resolved.rel} (${pendingStickers.length}/${actionMax})`,
            );
            return JSON.stringify({
                ok: true,
                queued: true,
                path: resolved.rel,
                sent: pendingStickers.length,
            });
        };
        const runListStickersCb = (emotion: string): string => runListStickers(deps, emotion);
        const fcOpts = useFc
            ? {
                tools: attachedTools,
                tool_choice: buildToolChoice(false),
                /**
                 * A③ 有界输出：联网/抓网页这类可能上万字的结果超过阈值就落盘到本群文件目录，
                 * 只回头部 + 一句 mkapi_002 取回指引（私聊没有群文件 scope，走原截断）。
                 */
                spill: groupId
                    ? (name: string, text: string, kind: string) => {
                        const s = spillTextToScope(deps, groupId, name, text);
                        if (!s.ok) return '';
                        deps.logger?.info?.(
                            `[智能对话·spill] ${chatId} ${kind} ${text.length}字 → ${s.rel}`
                            + `${s.truncated ? '（超上限已截断）' : ''}`,
                        );
                        return buildSpillHint(s, {
                            kind,
                            omittedChars: Math.max(0, text.length - SPILL_INLINE_HEAD_CHARS),
                        });
                    }
                    : undefined,
            }
            : undefined;
        const maxRounds = Math.min(5, Math.max(1, Number(config.tools_max_rounds) || 3));
        let liveMessages = composed.apiMessages.map((m) => ({ ...m }));
        const lastSnapEarly = batch[batch.length - 1]?.eventSnapshot;

        const isNvidiaBuiltin = String(config.vendor || '') === 'nvidia';
        const rebuildAfterOverflowCompact = () => {
            composed = composeTurn(config, session, batch, knowledge, historyRounds, {
                imageRecognize,
                stickerOutput,
                stickerSystemSuffix,
                stickerInstallKey,
                toolsEnabled,
                botNickname,
                chatId,
                loreEntries,
                memoryBlock,
                stylePackId: 'groupie',
                fakeThink,
                modelNativeThinking,
                currentVendor,
                currentModel,
            });
            liveMessages = composed.apiMessages.map((m) => ({ ...m }));
        };
        /**
         * 触顶恢复：强制 compact + 重建本轮请求，然后让调用方重试一次。
         * 与厂商无关（`forceCompactForOverflow` 本身就和厂商无关）——
         * 旧实现只把它接在英伟达分支里，导致别的厂商遇到上下文超长只会「静默不回复」。
         */
        const applyOverflowCompact = (reason: string) => {
            const changed = forceCompactForOverflow(session);
            if (changed) {
                saveSession(deps, chatId, session, config);
                rebuildAfterOverflowCompact();
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 上下文触顶恢复 compact (${reason}) msgs→${(session.messages || []).length}`,
                );
            }
            return changed;
        };
        /**
         * A① 主动压缩（按 token 预算）：达到阈值前先压，尾部按 retainTokens 收。
         * 与下面的 applyOverflowCompact（上游已报触顶后的应急短尾）分工不同：
         * 这里是「还没报错就先腾地方」，保留量更大、不牺牲上下文质量。
         */
        const applyBudgetCompact = (reason: string) => {
            const changed = maybeCompactSession(session, compactBudget);
            if (changed) {
                saveSession(deps, chatId, session, config);
                rebuildAfterOverflowCompact();
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 上下文预算压缩 (${reason}) msgs→${(session.messages || []).length}`
                    + ` 台账 ${(session.compactions || []).length} 条 epoch=${session.compaction_epoch || 0}`,
                );
            }
            return changed;
        };
        /**
         * A① 压缩预检：est 超阈值就先按预算压一次再发请求；
         * 上游报了 context_length 的应急路径仍走 applyOverflowCompact（下面 API 失败分支）。
         */
        {
            const est = estimateMessagesTokens([
                { role: 'system', content: composed.systemPrompt },
                ...liveMessages,
            ]);
            // 无条件记一行：线上要能回答「这轮为什么没压/为什么压了」
            deps.logger?.info?.(
                `[智能对话] ${chatId} 压缩预检 est=${est} 阈值=${compactBudget.thresholdTokens}`
                + ` (窗口 ${compactBudget.window} ${compactBudget.source}`
                + ` 比例 ${compactBudget.thresholdRatio}/${compactBudget.retainRatio}`
                + ` 已发 ${liveMessages.length} 条)`,
            );
            if (est > compactBudget.thresholdTokens) {
                applyBudgetCompact(
                    `precheck est=${est} 阈值=${compactBudget.thresholdTokens}`
                    + ` 窗口=${compactBudget.window}(${compactBudget.source})`,
                );
            }
        }

        // A2：未点名 + hard（peerLoop 等）→ 跳过 LLM，直接 shut_up
        {
            const atBotSkip = Boolean(composed.scene?.atBot)
                || batchAtsBot(batch, lastSnapEarly?.self_id);
            const silenceOkSkip = (Number(config.action_min) || 0) === 0;
            const batchBlobSkip = batch.map((b) => b.text || '').join('\n');
            const silenceDec = decideSilence({
                scene: composed.scene,
                session,
                silenceAllowedByConfig: silenceOkSkip,
                atBot: atBotSkip,
                batchText: batchBlobSkip,
                shutUpLimit: config.shut_up_limit,
                // 与 compose 内那次判定同源，避免预判与 host-state 说两套
                addressedToBot: composed.talkGraph?.computed ? composed.talkGraph.toBot.length > 0 : null,
                peerThreads: composed.talkGraph?.computed ? composed.talkGraph.threads : 0,
                vetoRatio: config.silence_veto_ratio,
                vetoSeed,
            });
            if (silenceDec.skipLlm) {
                const streakNow = Math.max(0, Number(session.shut_up_streak) || 0);
                const why = silenceDec.addressVetoed ? '没人对你说话（否决）' : `场况 ${silenceDec.sceneBias}`;
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 预判跳过 LLM ${why} bias=${silenceDec.sceneBias} streak=${streakNow}`,
                );
                // 本轮没有真正发请求：前缀基准仍是上一次发出的那次。
                // 这里若写 hash，下一轮 prefixStable 会假报 true（服务端没见过本轮 tip）。
                appendSessionTurn(deps, chatId, composed.userContentExact, '<shut_up/>', config, {
                    shutUp: true,
                    preferNoReply: Boolean(session.prefer_no_reply),
                    preferSilence: Boolean(session.prefer_silence),
                    chatMeta,
                    baseSession: session,
                });
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 闭嘴(预判) streak→${Math.min(
                        Math.max(1, Number(config.shut_up_limit) || 5),
                        streakNow + 1,
                    )}/${config.shut_up_limit}`,
                );
                return;
            }
        }

        // 脚本工具始终挂载；表情包按开关；联网仅当本聊天开启。tool_choice=auto
        // 上下文触顶（任何厂商）：紧急 compact 保盘后最多再试 2 次
        let result = await chatCompletion(
            config,
            composed.systemPrompt,
            liveMessages,
            fcOpts,
        );
        if (!result.ok && isContextOverflowError(result.error)) {
            let overflowTries = 0;
            while (overflowTries < 2 && !result.ok && isContextOverflowError(result.error)) {
                overflowTries += 1;
                const changed = applyOverflowCompact(`api_overflow try=${overflowTries}`);
                if (!changed && overflowTries > 1) break;
                const retryCfg = {
                    ...config,
                    max_tokens: Math.min(Number(config.max_tokens) || 2048, 1024),
                };
                result = await chatCompletion(
                    retryCfg,
                    composed.systemPrompt,
                    liveMessages,
                    fcOpts,
                );
            }
            if (!result.ok && isContextOverflowError(result.error)) {
                deps.logger?.error?.(
                    `[智能对话] ${chatId} context_overflow_exhausted:`,
                    result.error,
                );
            }
        }

        let rounds = 0;
        let statusSent = false;
        while (result.ok && useFc && result.tool_calls?.length && rounds < maxRounds) {
            rounds += 1;
            if (
                result.tool_calls.some(
                    (t) => String(t?.function?.name || '').trim() !== SEND_STICKER_TOOL_NAME,
                )
            ) {
                nonStickerFcUsed = true;
            }
            const toolNames = result.tool_calls.map((t) => t.function.name).join(',');
            const preambles = result.content?.trim()
                ? inferToolPreambleTexts(result.content)
                : [];
            const planNote = preambles[0]
                || String(result.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 80)
                || '(模型未给 status，按工具名续程)';
            deps.logger?.info?.(
                `[智能对话] ${chatId} 评定续程 工具轮 ${rounds}/${maxRounds}: ${toolNames}｜下一步=${planNote}`,
            );
            // 群内说明：只发显式且安全的 <status>；想法/工具名短正文绝不外发
            const groupStatuses = result.content?.trim()
                ? extractGroupSafeStatusTexts(result.content)
                : [];
            if (!statusSent && groupStatuses.length && lastSnapEarly) {
                statusSent = true;
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 工具前群内说明 ${groupStatuses.length} 条（不计行为）`,
                );
                try {
                    const ev = rebuildEventFromSnapshot(lastSnapEarly);
                    await executeAssistantActions(
                        deps,
                        ev,
                        groupStatuses.map((text) => ({ type: 'msg', text })),
                        config.reply_gap_ms,
                    );
                } catch (e) {
                    deps.logger?.warn?.('[智能对话] 工具前说明发送失败:', e?.message || e);
                }
            }
            liveMessages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.tool_calls,
            });
            const toolMsgs = await executeToolCalls(config, result.tool_calls, deps.logger, {
                runMkApi,
                runSendSticker,
                runListStickers: runListStickersCb,
            });
            for (const tm of toolMsgs) liveMessages.push(tm);

            const next = await chatCompletion(
                config,
                composed.systemPrompt,
                liveMessages,
                { tools: attachedTools, tool_choice: 'auto' },
            );
            next.usage = mergeUsage(result.usage, next.usage);
            result = next;
        }

        // MKAPI 文本标签兜底：模型输出 <MKAPI …/> → 宿主排队执行 → 结果回灌再续写
        let mkRounds = 0;
        while (result.ok && contentHasMkApi(result.content) && mkRounds < maxRounds) {
            const calls = parseMkApiCalls(result.content);
            if (!calls.length) break;
            mkRounds += 1;
            const preambles = result.content?.trim()
                ? inferToolPreambleTexts(result.content)
                : [];
            const planNote = preambles[0]
                || `执行 MKAPI ${calls.map((c) => c.code).join(',')}`;
            deps.logger?.info?.(
                `[智能对话] ${chatId} 评定续程 MKAPI 标签轮 ${mkRounds}/${maxRounds}: ${calls.map((c) => c.code).join(',')}｜下一步=${planNote}`,
            );
            const groupStatuses = result.content?.trim()
                ? extractGroupSafeStatusTexts(result.content)
                : [];
            if (!statusSent && groupStatuses.length && lastSnapEarly) {
                statusSent = true;
                try {
                    const ev = rebuildEventFromSnapshot(lastSnapEarly);
                    await executeAssistantActions(
                        deps,
                        ev,
                        groupStatuses.map((text) => ({ type: 'msg', text })),
                        config.reply_gap_ms,
                    );
                } catch (e) {
                    deps.logger?.warn?.('[智能对话] MKAPI 前说明发送失败:', e?.message || e);
                }
            }
            liveMessages.push({
                role: 'assistant',
                content: result.content || '',
            });
            const mkResultText = await executeMkApiCalls(mkApiCtx, calls);
            liveMessages.push({ role: 'user', content: mkResultText });
            const next = await chatCompletion(
                config,
                composed.systemPrompt,
                liveMessages,
                useFc
                    ? { tools: attachedTools, tool_choice: 'auto' }
                    : undefined,
            );
            next.usage = mergeUsage(result.usage, next.usage);
            result = next;
        }

        // send_sticker 调过却未入队：强制再试一次真实 path（不偷偷补图）
        if (
            result.ok
            && stickerOutput
            && useFc
            && stickerAttempts > 0
            && pendingStickers.length === 0
        ) {
            deps.logger?.warn?.(
                `[智能对话] ${chatId} ${SEND_STICKER_TOOL_NAME} 曾失败且未入队，强制再试一次 err=${lastStickerError || '?'}`,
            );
            liveMessages.push({
                role: 'user',
                content:
                    `[宿主] 上轮 send_sticker 失败${lastStickerError ? `（${lastStickerError}）` : ''}。`
                    + '禁止装神秘、禁止假装「其实不想发」。必须从 [表情包选取规则] 已装前缀抄真实 path 再调一次 send_sticker；'
                    + '或用一句短 <msg> 承认发不出。',
            });
            const retry = await chatCompletion(
                config,
                composed.systemPrompt,
                liveMessages,
                { tools: attachedTools, tool_choice: buildForceSendStickerToolChoice() },
            );
            retry.usage = mergeUsage(result.usage, retry.usage);
            result = retry;
            if (result.ok && result.tool_calls?.length) {
                if (
                    result.tool_calls.some(
                        (t) => String(t?.function?.name || '').trim() !== SEND_STICKER_TOOL_NAME,
                    )
                ) {
                    nonStickerFcUsed = true;
                }
                liveMessages.push({
                    role: 'assistant',
                    content: result.content || null,
                    tool_calls: result.tool_calls,
                });
                const toolMsgs = await executeToolCalls(config, result.tool_calls, deps.logger, {
                    runMkApi,
                    runSendSticker,
                    runListStickers: runListStickersCb,
                });
                for (const tm of toolMsgs) liveMessages.push(tm);
                const after = await chatCompletion(
                    config,
                    composed.systemPrompt,
                    liveMessages,
                    { tools: attachedTools, tool_choice: 'auto' },
                );
                after.usage = mergeUsage(result.usage, after.usage);
                result = after;
            }
            if (pendingStickers.length === 0) stickerHonestyForce = true;
        }

        // B2：*指名向 bot* 要图却零次 send_sticker → 强制 tool_choice 再试一轮
        // （A2：仅点名才强制。群里互相斗图、泛泛提"表情包"不逼 bot 发，省无谓 API 轮次）
        {
            const batchWants = batchWantsStickerText(batch.map((b) => b.text).join('\n'));
            const addressedForSticker = Boolean(composed.scene?.atBot)
                || batchAtsBot(batch, batch[batch.length - 1]?.eventSnapshot?.self_id)
                || (composed.talkGraph?.computed ? composed.talkGraph.toBot.length > 0 : false);
            if (
                result.ok
                && batchWants
                && addressedForSticker
                && stickerOutput
                && useFc
                && stickerTool
                && pendingStickers.length === 0
                && stickerAttempts === 0
            ) {
                deps.logger?.warn?.(
                    `[智能对话] ${chatId} 要图但未调 send_sticker，强制 tool_choice=${SEND_STICKER_TOOL_NAME}`,
                );
                liveMessages.push({
                    role: 'user',
                    content:
                        '[宿主] 对方点名要图。必须调 send_sticker（path=图库名/文件名），'
                        + '禁止只说发了/给你一张/Here\'s one 却零次工具。'
                        + '若发不出，用一句短 <msg> 承认发不出。',
                });
                const forceSticker = await chatCompletion(
                    config,
                    composed.systemPrompt,
                    liveMessages,
                    { tools: attachedTools, tool_choice: buildForceSendStickerToolChoice() },
                );
                forceSticker.usage = mergeUsage(result.usage, forceSticker.usage);
                result = forceSticker;
                if (result.ok && result.tool_calls?.length) {
                    if (
                        result.tool_calls.some(
                            (t) => String(t?.function?.name || '').trim() !== SEND_STICKER_TOOL_NAME,
                        )
                    ) {
                        nonStickerFcUsed = true;
                    }
                    liveMessages.push({
                        role: 'assistant',
                        content: result.content || null,
                        tool_calls: result.tool_calls,
                    });
                    const toolMsgs = await executeToolCalls(config, result.tool_calls, deps.logger, {
                        runMkApi,
                        runSendSticker,
                        runListStickers: runListStickersCb,
                    });
                    for (const tm of toolMsgs) liveMessages.push(tm);
                    const after = await chatCompletion(
                        config,
                        composed.systemPrompt,
                        liveMessages,
                        { tools: attachedTools, tool_choice: 'auto' },
                    );
                    after.usage = mergeUsage(result.usage, after.usage);
                    result = after;
                }
                if (pendingStickers.length === 0) stickerHonestyForce = true;
            }
        }

        // 达上限仍想调工具 / DSML 正文 / 无正文：强制一轮无 tools 收束（禁止再输出工具调用）
        // 纯 send_sticker 入队不算「须文字收束」
        const needForceText =
            result.ok &&
            (nonStickerFcUsed || mkRounds > 0) &&
            (Boolean(result.tool_calls?.length) ||
                contentHasMkApi(result.content) ||
                !result.content?.trim() ||
                looksLikeToolMarkup(result.content));
        if (needForceText) {
            if (result.tool_calls?.length || looksLikeToolMarkup(result.content) || contentHasMkApi(result.content)) {
                deps.logger?.warn?.(
                    `[智能对话] ${chatId} 工具未收束（calls=${result.tool_calls?.length || 0} mkapi=${contentHasMkApi(result.content)} dsml=${looksLikeToolMarkup(result.content)}），强制无工具收束`,
                );
            } else {
                deps.logger?.info?.(`[智能对话] ${chatId} 工具后无正文，强制无工具收束`);
            }
            // 不把未执行的 tool_calls / DSML 正文塞进历史，只基于已有 tool 结果再答
            const final = await chatCompletion(config, composed.systemPrompt, [
                ...liveMessages,
                {
                    role: 'user',
                    content:
                        '[宿主] 禁止再输出工具调用、MKAPI、DSML 或 function call。根据上文已有搜索/脚本结果，用 <replies> 在行为数范围内写够该说的点（可多条很短口语 <msg>）：像群友随口八卦，别念报告、别堆人数/协议名清单、别写安装教程。',
                },
            ]);
            final.usage = mergeUsage(result.usage, final.usage);
            if (final.ok) result = final;
        }

        if (!result.ok || (!result.content && !result.tool_calls?.length && !pendingStickers.length)) {
            deps.logger?.error?.('[智能对话] API 失败（不外发）:', result.error || 'empty_response');
            // 一次 429/超时/空响应不能等于「这批消息没存在过」：
            // 放回缓冲（模型下一轮仍能看到），退避后再试
            handleFlushFailure(deps, chatId, batch, `API 失败(${result.error || 'empty_response'})`);
            return;
        }

        // 仍夹带工具标记则剥掉；剥光则用兜底句，绝不把 DSML/MKAPI 发进群
        if (looksLikeToolMarkup(result.content) || result.tool_calls?.length || contentHasMkApi(result.content)) {
            deps.logger?.warn?.(`[智能对话] ${chatId} 最终仍含工具标记，丢弃外发`);
            result = {
                ...result,
                content: stripMkApiTags(stripToolMarkup(result.content) || '') || '',
                tool_calls: undefined,
            };
        }
        if (!result.content?.trim()) {
            // 模型没给正文：插件不替它编话。下面 rescue 分支会再给它一次用自己话说的机会；
            // 仍旧空 → 保持沉默（<shut_up/>），绝不注入写死句。
            result.content = '<shut_up/>';
        }

        // 落盘：仅最终对用户可见的 assistant 文本（工具中间轮不入 session）
        const lastSnapEv = batch[batch.length - 1]?.eventSnapshot;
        const isGroup = lastSnapEv?.message_type === 'group'
            || batch[0]?.eventSnapshot?.message_type === 'group';
        // 与 compose 场况一致：含 @ / 引用 bot / 昵称点名
        const atBot = Boolean(composed.scene?.atBot) || batchAtsBot(batch, lastSnapEv?.self_id);
        const toolResultsThisTurn = liveMessages.some((m) => m.role === 'tool')
            || mkRounds > 0;
        const nonStickerToolsUsed = nonStickerFcUsed || mkRounds > 0;
        const batchBlobOut = [queryText, ...batch.map((b) => b.text || '')].filter(Boolean).join('\n');
        const batchWantsStickerEarly =
            batchWantsStickerText(queryText)
            || batch.some((b) => batchWantsStickerText(String(b.text || '')));
        const silenceDec = decideSilence({
            scene: composed.scene,
            session,
            silenceAllowedByConfig: config.action_min === 0,
            atBot,
            batchText: batchBlobOut,
            nonStickerToolsUsed,
            shutUpLimit: config.shut_up_limit,
            addressedToBot: composed.talkGraph?.computed ? composed.talkGraph.toBot.length > 0 : null,
            peerThreads: composed.talkGraph?.computed ? composed.talkGraph.threads : 0,
            // 同一轮同一种子：走到这里说明预判没否决，这次抽样结果必然也是不否决
            vetoRatio: config.silence_veto_ratio,
            vetoSeed,
        });
        const silenceAllowed = silenceDec.silenceAllowed;
        const mustSpeak = Boolean(silenceDec.mustSpeak || silenceDec.forceSpeak);
        const forceSpeak = Boolean(silenceDec.forceSpeak);
        let sceneBias = silenceDec.sceneBias;
        const streak = Math.max(0, Number(session.shut_up_streak) || 0);

        const recentHumanTexts = batch
            .map((b) => String(b.text || '').trim())
            .filter((t) => t && !/^\[眼睛\s+msgid:/i.test(t) && !/^补充：/.test(t));

        const reparseLimited = (content, opts = {}) => {
            const parsedInner = parseOutboundActions(content, batch, isGroup, deps.logger);
            return applyActionLimits(parsedInner, {
                actionMin: config.action_min,
                actionMax: config.action_max,
                silenceAllowed: opts.silenceAllowed ?? silenceAllowed,
                mustSpeak: opts.mustSpeak ?? mustSpeak,
                stripReply,
            });
        };

        let authorImpersonationHit = false;
        const scrubMsgActions = (actions) => {
            const next = [];
            for (const a of actions || []) {
                if (a.type !== 'msg') {
                    next.push(a);
                    continue;
                }
                if (String(a.sticker || '').trim()) {
                    next.push({ ...a, text: '' });
                    continue;
                }
                let text = stripCustomerServiceTone(String(a.text || ''));
                if (!text) continue;
                const refusal = rewriteEnglishRefusal(text, { addressed: atBot });
                if (refusal?.kind === 'shut_up') {
                    if (!atBot && silenceAllowed) continue;
                    text = '';
                } else if (refusal?.kind === 'replace') {
                    text = refusal.text;
                }
                // 识图暴露兜底（长期顽疾）：看不到图数据时模型偶尔把「加载 / 解析 / 没刷出来 /
                // 图片资源 / 我这边图…」这类机制状态说出口。与英文拒答同策略：丢弃转沉默；
                // 被点名必须开口时交给下面 rescue 让模型用自己的话重说，仍不肯说则沉默。
                if (looksLikeImageLoadExposureText(text)) {
                    if (!atBot && silenceAllowed) continue;
                    text = '';
                }
                if (!text) continue;
                if (looksLikeAuthorImpersonation(text)) {
                    authorImpersonationHit = true;
                    // 冒充作者句一律丢弃：插件不替它编「得问作者」。
                    // 被点名须开口时，交给下面的 rescue 让模型用自己的话重说；仍不肯说则沉默。
                    continue;
                }
                next.push({ ...a, text });
            }
            return dropTrailingSoftFollowUp(next);
        };

        const actionsLookLikeHowto = (actions) =>
            (actions || []).some((a) => a.type === 'msg' && looksLikeTechHowtoText(a.text || ''));
        const actionsLookLikeCs = (actions) =>
            (actions || []).some((a) => a.type === 'msg' && looksLikeCustomerServiceText(a.text || ''));

        let parsed = parseOutboundActions(result.content, batch, isGroup, deps.logger);
        let limited = applyActionLimits(parsed, {
            actionMin: config.action_min,
            actionMax: config.action_max,
            silenceAllowed,
            mustSpeak,
            stripReply,
        });
        limited = { actions: scrubMsgActions(limited.actions), shutUp: limited.shutUp };

        const refined = refineOutboundByScene(limited.actions, {
            silenceAllowed: forceSpeak ? false : silenceAllowed,
            mustSpeak,
            forceSpeak,
            silenceBias: sceneBias,
            toolsUsed: nonStickerToolsUsed,
            actionMax: config.action_max,
            recentHumanTexts,
            batchWantsSticker: batchWantsStickerEarly,
        });
        const sceneWantedShutUp = Boolean(refined.shutUp)
            && (sceneBias === 'hard' || sceneBias === 'soft');
        let outboundRewritten = Boolean(refined.rewritten);
        if (refined.rewritten || refined.shutUp !== limited.shutUp) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} 出站场况校正 bias=${sceneBias} shutUp=${refined.shutUp} rewritten=${refined.rewritten}`,
            );
        }
        limited = { actions: scrubMsgActions(refined.actions), shutUp: refined.shutUp };

        // 本回合无工具回灌却写可执行教程 / 客服腔：再压一次短群友口吻
        if (
            !toolResultsThisTurn
            && hasRealTextMsg(limited.actions)
            && (actionsLookLikeHowto(limited.actions) || actionsLookLikeCs(limited.actions))
        ) {
            // 未点名的教程腔：优先直接闭嘴，少发万能「重装图库」
            if (!atBot && silenceAllowed && !forceSpeak) {
                limited = { actions: [], shutUp: true };
                outboundRewritten = true;
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 未点名教程/客服腔 → shut_up`,
                );
            } else {
            deps.logger?.warn?.(
                `[智能对话] ${chatId} 无工具回灌却教程/客服腔，强制改口`,
            );
            const rescue = await chatCompletion(config, composed.systemPrompt, [
                ...liveMessages,
                {
                    role: 'user',
                    content:
                        '[宿主] 本回合没有工具/MKAPI 回灌。禁止可执行教程、配置步骤、路径、命令、厂商申请清单；'
                        + '禁止客服腔（有什么需要帮忙/祝使用顺利/不客气/记得点保存）。'
                        + '用 <replies> 写很短的 <msg>（可多条，仍在行为数内）：态度或「不确定/自己搜」即可，像普通群友，别当助手。',
                },
            ]);
            result.usage = mergeUsage(result.usage, rescue.usage);
            if (rescue.ok && rescue.content?.trim() && !looksLikeToolMarkup(rescue.content)) {
                result = { ...rescue, usage: result.usage, tool_calls: undefined };
                limited = reparseLimited(result.content);
                limited = { actions: scrubMsgActions(limited.actions), shutUp: limited.shutUp };
                outboundRewritten = true;
            }
            // 仍像教程/客服腔：插件不替它编话，保留 react、其余转沉默
            if (actionsLookLikeHowto(limited.actions) || actionsLookLikeCs(limited.actions)) {
                const reacts = limited.actions.filter((a) => a.type === 'react');
                limited = { actions: reacts, shutUp: reacts.length === 0 };
                outboundRewritten = true;
                deps.logger?.info?.(`[智能对话] ${chatId} 改口后仍教程/客服腔 → 沉默`);
            }
            }
        }

        // 作者冒充：未点名优先闭嘴（scrub 已丢冒充句）
        if (authorImpersonationHit && !atBot && silenceAllowed && !forceSpeak) {
            limited = { actions: [], shutUp: true };
            outboundRewritten = true;
            deps.logger?.info?.(`[智能对话] ${chatId} 作者冒充未点名 → shut_up`);
        }

        // 点名 / 达限 / 工具汇报须开口，但模型仍闭嘴或只吐「……」：再要一次像群友的短接话
        if (forceSpeak && !hasRealTextMsg(limited.actions) && !pendingStickers.length) {
            const rescueHint = atBot
                ? '[宿主] 本轮被点名，必须开口。禁止 <shut_up/>，禁止只贴表情，禁止输出「……」。'
                    + '用 <replies> 在行为数范围内写够该说的点（可多条很短 <msg>），像普通群友随口接——有态度就行，别当客服、别祝使用顺利、别把每个问题答完。'
                    + '禁止自称插件作者或「我的插件」。'
                : '[宿主] 沉默已达上限，本轮必须开口。禁止 <shut_up/>，禁止只贴表情，禁止输出「……」。'
                    + '用 <replies> 在行为数范围内写一条很短的 <msg>：像普通群友随口接一句即可，别当客服、别复盘全场。';
            deps.logger?.warn?.(
                `[智能对话] ${chatId} ${atBot ? '须开口' : '达限强制'}但仍沉默，强制补一句`,
            );
            const rescue = await chatCompletion(config, composed.systemPrompt, [
                ...liveMessages,
                { role: 'user', content: rescueHint },
            ]);
            result.usage = mergeUsage(result.usage, rescue.usage);
            if (rescue.ok && rescue.content?.trim() && !looksLikeToolMarkup(rescue.content)) {
                result = { ...rescue, usage: result.usage, tool_calls: undefined };
                limited = reparseLimited(result.content, { silenceAllowed: false, mustSpeak: true });
                limited = { actions: scrubMsgActions(limited.actions), shutUp: limited.shutUp };
                outboundRewritten = true;
            }
            if (!hasRealTextMsg(limited.actions) && !pendingStickers.length) {
                // 给过一次机会仍不肯用自己的话开口：插件不代言，保留 react、转沉默
                const reacts = limited.actions.filter((a) => a.type === 'react');
                limited = { actions: reacts, shutUp: reacts.length === 0 };
                outboundRewritten = true;
                deps.logger?.info?.(`[智能对话] ${chatId} 须开口但 rescue 后仍无文字 → 沉默`);
            }
        } else if (mustSpeak && nonStickerToolsUsed && !hasRealTextMsg(limited.actions) && !pendingStickers.length) {
            // 工具汇报路径仍须有字；保留原 rescue 逻辑但去掉「沉默达上限」措辞
            deps.logger?.warn?.(`[智能对话] ${chatId} 工具后须开口但仍沉默，强制补一句`);
            const rescue = await chatCompletion(config, composed.systemPrompt, [
                ...liveMessages,
                {
                    role: 'user',
                    content:
                        '[宿主] 本轮已用工具，须用 <replies> 写一句人话汇报结果。禁止 <shut_up/>，禁止只贴表情。',
                },
            ]);
            result.usage = mergeUsage(result.usage, rescue.usage);
            if (rescue.ok && rescue.content?.trim() && !looksLikeToolMarkup(rescue.content)) {
                result = { ...rescue, usage: result.usage, tool_calls: undefined };
                limited = reparseLimited(result.content, { silenceAllowed: false, mustSpeak: true });
                limited = { actions: scrubMsgActions(limited.actions), shutUp: limited.shutUp };
                outboundRewritten = true;
            }
        }

        // 已搜到/脚本结果却只贴表情/闭嘴：再强制要一次文字答案（不含纯表情包）
        if (nonStickerToolsUsed && !hasRealTextMsg(limited.actions)) {
            deps.logger?.warn?.(`[智能对话] ${chatId} 联网后无文字回复，强制补答`);
            const rescue = await chatCompletion(config, composed.systemPrompt, [
                ...liveMessages,
                {
                    role: 'user',
                    content:
                        '[宿主] 你已经查完并拿到结果。不要闭嘴、不要只贴表情。用 <replies> 在行为数范围内用短口语 <msg>（可多条）把有用的点说出来——像群友转述，别念数据库/百科条目；禁止再提 mkapi、web_search、工具名。',
                },
            ]);
            result.usage = mergeUsage(result.usage, rescue.usage);
            if (rescue.ok && rescue.content?.trim() && !looksLikeToolMarkup(rescue.content)) {
                result = { ...rescue, usage: result.usage, tool_calls: undefined };
                limited = reparseLimited(result.content, { silenceAllowed: false, mustSpeak: true });
                limited = { actions: scrubMsgActions(limited.actions), shutUp: limited.shutUp };
                // 联网补答后不再按沉默场况压掉
                outboundRewritten = false;
            }
            if (!hasRealTextMsg(limited.actions)) {
                // 查完了但模型就是不肯用自己的话转述：插件不替它编「搜到一些…」，保留 react、转沉默
                const reacts = limited.actions.filter((a) => a.type === 'react');
                limited = { actions: reacts, shutUp: reacts.length === 0 };
                outboundRewritten = true;
                deps.logger?.info?.(`[智能对话] ${chatId} 联网补答 rescue 后仍无文字 → 沉默`);
            }
        }

        if (result.usage) {
            recordUsage(deps, config, chatId, result.usage, result.rotated_model);
            const hit = result.usage.prompt_cache_hit_tokens || 0;
            const miss = result.usage.prompt_cache_miss_tokens || 0;
            const prompt = result.usage.prompt_tokens || 0;
            const rate = prompt > 0 ? Math.round((hit / prompt) * 1000) / 10 : 0;
            const cacheNote = result.usage.cache_fields_reported
                ? `${rate}%`
                : 'cache_unsupported';
            deps.logger?.info?.(
                `[智能对话] ${chatId} tokens prompt=${prompt} cache_hit=${hit} cache_miss=${miss} (${cacheNote}) `
                + `prefixStable=${composed.prefixStable} completion=${result.usage.completion_tokens || 0} toolRounds=${rounds}`,
            );
        }

        // 无入队图时：结构诚实兜底（不嗅探正文语言；不自动补发）
        const batchWantsSticker = batchWantsStickerEarly;
        if (stickerOutput) {
            const beforeHonesty = limited.actions || [];
            const honest = scrubStickerHonestyActions(beforeHonesty, {
                hasPending: pendingStickers.length > 0,
                stickerAttempted: stickerAttempts > 0,
                batchWants: batchWantsSticker,
                honestyForce: stickerHonestyForce,
            });
            const beforeKey = beforeHonesty.map((a) => `${a.type}:${a.sticker || a.text || ''}`).join('|');
            const afterKey = honest.map((a) => `${a.type}:${a.sticker || a.text || ''}`).join('|');
            if (beforeKey !== afterKey) {
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 表情包出站诚实校正 attempts=${stickerAttempts} pending=${pendingStickers.length} force=${stickerHonestyForce}`,
                );
            }
            limited = {
                actions: honest,
                shutUp: Boolean(limited.shutUp) && !honest.some((a) => {
                    if (a.type !== 'msg') return false;
                    if (String(a.sticker || '').trim()) return true;
                    return Boolean(String(a.text || '').trim());
                }),
            };
        }

        // 排队表情包接到文字/react 之后；去掉最终 XML 里重复的同路径 sticker
        // 未点名要图：冷却集内路径不出站（防连刷同一三张）
        const coolRecent = normalizeRecentStickers(session.recent_stickers);
        if (coolRecent.length && !batchWantsSticker) {
            const coolSet = new Set(coolRecent);
            const beforePend = pendingStickers.length;
            for (let i = pendingStickers.length - 1; i >= 0; i--) {
                if (coolSet.has(String(pendingStickers[i] || '').trim().replace(/\\/g, '/'))) {
                    pendingStickers.splice(i, 1);
                }
            }
            const cooled = filterCooldownStickers(limited.actions || [], coolRecent, {
                batchWantsSticker: false,
            });
            if (cooled.dropped.length || pendingStickers.length !== beforePend) {
                limited = {
                    actions: cooled.actions,
                    shutUp: Boolean(limited.shutUp) && !cooled.actions.some((a) => {
                        if (a.type !== 'msg') return false;
                        if (String(a.sticker || '').trim()) return true;
                        return Boolean(String(a.text || '').trim());
                    }),
                };
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 表情冷却丢弃 ${cooled.dropped.join(',') || '(queue)'}`,
                );
            }
        }

        const queuedSet = new Set(pendingStickers);
        if (queuedSet.size) {
            const withoutDup = (limited.actions || []).filter((a) => {
                if (a.type !== 'msg') return true;
                const rel = String(a.sticker || '').trim();
                if (!rel) return true;
                return !queuedSet.has(rel);
            });
            const merged = appendQueuedStickers(withoutDup, pendingStickers);
            limited = {
                // 先字后图已排好序；超行为上限时从尾部截（优先保留文字）
                actions: merged.slice(0, actionMax),
                shutUp: false,
            };
        }

        // 结构 soft/hard 已判定沉默：要图/须开口/达限时不得清空贴纸队列
        if (
            silenceAllowed
            && !mustSpeak
            && !forceSpeak
            && !nonStickerToolsUsed
            && !batchWantsSticker
            && (sceneBias === 'hard' || sceneWantedShutUp)
        ) {
            if (!limited.shutUp || (limited.actions || []).length || pendingStickers.length) {
                pendingStickers.splice(0, pendingStickers.length);
                limited = { actions: [], shutUp: true };
                outboundRewritten = true;
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 场况 ${sceneBias} 最终压制出站（含贴纸）`,
                );
            }
        }

        // 会话落盘必须与最终出站动作一致（含宿主强制开口），避免历史教模型「达限也能闭嘴」
        let storeContent = actionsToAssistantStoreContent(limited.actions, limited.shutUp);
        // actions 已含 sticker 时 merge 为幂等补齐（插在 replies 末尾）
        const alreadyInStore = new Set(
            [...String(storeContent).matchAll(/<sticker>([^<]+)<\/sticker>/gi)].map((m) =>
                String(m[1] || '').trim(),
            ),
        );
        const missingForStore = pendingStickers.filter((r) => !alreadyInStore.has(r));
        storeContent = mergeToolStickersIntoStore(storeContent, missingForStore);
        if (stripReply) storeContent = stripReplyAttrsFromContent(storeContent);
        const shutUpForSession = Boolean(limited.shutUp) && !pendingStickers.length;
        // 本轮真正发出的全文 hash（不含模型回复）：下一轮 system+去尾 assistant 的历史应与之相等
        recordSentApiPrefix(session, composed.systemPrompt, composed.apiMessages);
        const outboundStickers = (limited.actions || [])
            .filter((a) => a.type === 'msg' && String(a.sticker || '').trim())
            .map((a) => String(a.sticker).trim().replace(/\\/g, '/'));
        for (const rel of pendingStickers) {
            const n = String(rel || '').trim().replace(/\\/g, '/');
            if (n && !outboundStickers.includes(n)) outboundStickers.push(n);
        }
        if (outboundStickers.length) pushRecentStickers(session, outboundStickers);
        // 伪装/原生思考：从最终输出与上游 reasoning 抠出，剥离后只落盘顶层（不进 messages / 不送 API）
        const fakeThinkTexts = extractThinkTexts(String(result.content || '')).thinking;
        const nativeReasoning = String(result.reasoning || '').trim();
        // 实际出活的模型（轮替后是替补）：原生思考名单按它记
        const answeredVendor = String(result.rotated_vendor || config.vendor || '');
        const answeredModel = String(result.rotated_model || config.model || '');
        const thinkingText = [nativeReasoning, ...fakeThinkTexts].filter(Boolean).join('\n\n');
        if (nativeReasoning) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} ${answeredVendor} / ${answeredModel} 自带原生思考 → 以后用这个模型不再挂伪装思考，换别的模型照常挂`,
            );
        }
        appendSessionTurn(deps, chatId, composed.userContentExact, storeContent, config, {
            shutUp: shutUpForSession,
            preferNoReply: Boolean(session.prefer_no_reply),
            preferSilence: Boolean(session.prefer_silence),
            chatMeta,
            baseSession: session,
            thinkingText,
            thinkingKind: nativeReasoning ? 'native' : 'fake',
            nativeThinkingSeen: Boolean(nativeReasoning),
            nativeThinkingVendor: answeredVendor,
            nativeThinkingModel: answeredModel,
        });
        turnRecorded = true;

        if (lastSnapEv && limited.actions.length) {
            const ev = rebuildEventFromSnapshot(lastSnapEv);
            for (const a of limited.actions) {
                if (a.type === 'msg' && String(a.sticker || '').trim()) {
                    deps.logger?.info?.(
                        `[智能对话] ${chatId} ${SEND_STICKER_TOOL_NAME} 已发 ${a.sticker}`,
                    );
                }
            }
            // 语音输出：本对象开了「允许语音」且引擎配好角色时，只把模型主动点名的
            // <voice> 气泡（a.voiceWanted）转语音——不是句句都转，主要仍是文本。
            // 单次回复最多两条语音（超长/失败/未点名一律按文本发）。
            // 合成走异步网络 I/O 且限时，全程在本 chat 的 busy 窗口内串行：期间新到的
            // 消息只累积在缓冲、不会并发插队，等这轮发完（成功或退回文本）才轮到它们。
            const voiceEngine = resolveVoiceEngine(config);
            const voiceConfigured = voiceEngine === 'qqai'
                ? Boolean(String(config.voice?.qq_character || '').trim())
                : Boolean(String(config.voice?.dub || '').trim());
            if (allowVoice && voiceConfigured) {
                const voiceGroupId = String(lastSnapForRounds?.group_id || groupId || '').trim();
                let voiceUsed = 0;
                for (const a of limited.actions) {
                    if (voiceUsed >= VOICE_MAX_SEGMENTS) break;
                    if (a.type !== 'msg') continue;
                    if (!a.voiceWanted) continue;
                    if (String(a.sticker || '').trim()) continue;
                    if (!voiceReadyText(a.text, voiceMaxChars(config))) continue;
                    try {
                        const r = await synthesizeVoice(deps, config, a.text, {
                            timeoutMs: 20000,
                            groupId: voiceGroupId,
                        });
                        if (r.ok && r.file) {
                            a.voiceFile = r.file;
                            voiceUsed += 1;
                            deps.logger?.info?.(
                                `[智能对话] ${chatId} 语音合成成功(${voiceEngine}${r.remote ? '/远端URL直传' : ''})：${String(a.text || '').slice(0, 20)}…`,
                            );
                        } else {
                            deps.logger?.warn?.(
                                `[智能对话] ${chatId} 语音合成失败(${voiceEngine})，按文本发：${r.error || '未知'}`,
                            );
                        }
                    } catch (e) {
                        deps.logger?.warn?.('[智能对话] 语音合成异常，按文本发:', e?.message || e);
                    }
                }
            }
            await executeAssistantActions(deps, ev, limited.actions, config.reply_gap_ms, {
                stickerOutput,
            });
        }
        if (shutUpForSession) {
            deps.logger?.info?.(
                `[智能对话] ${chatId} 闭嘴(含纯贴表情) streak→${streak + 1}/${config.shut_up_limit}`,
            );
        }
        // 本轮真的走完了（含成功闭嘴）：清失败计数，重新允许立即触发
        noteFlushSuccess(chatId);
    } catch (e) {
        deps.logger?.error?.('[智能对话] flush 异常:', e);
        if (turnRecorded) {
            // 已进历史：不能再放回（否则同一批会被答复两次），只记失败让退避生效
            const delay = noteFlushFailure(chatId);
            deps.logger?.warn?.(
                `[智能对话] ${chatId} 出站阶段异常，本轮已进历史不再放回；`
                + `${Math.round(delay / 1000)} 秒内不放行下一次访问`,
            );
            // 缓冲里可能还有等待期间新到的消息：保证退避期间也有计时兜底
            if (loadChatBuffer(deps, chatId).length) scheduleRetryFlush(deps, chatId, delay);
        } else {
            handleFlushFailure(deps, chatId, batch, `flush 异常(${e?.message || e})`);
        }
    } finally {
        busyChats.set(chatId, false);
        // 等待期间缓冲的消息：本轮结束后再处理（仍串行）
        const leftover = loadChatBuffer(deps, chatId);
        if (leftover.length) {
            const cfg = loadSmartChatConfig(deps);
            const backoff = flushRetryDelayMs(chatId);
            if (backoff > 0) {
                // 刚失败过：本轮失败已经把消息放回并挂了退避计时，
                // 这里再「立刻强制重试」等于把退避作废（@ 分支以前就是这样连打三轮）。
                deps.logger?.info?.(
                    `[智能对话] ${chatId} 退避中（还剩 ${Math.ceil(backoff / 1000)} 秒），`
                    + `leftover ${leftover.length} 条等退避到点再访问`,
                );
                scheduleRetryFlush(deps, chatId, backoff);
            } else {
                const selfId = String(leftover[leftover.length - 1]?.eventSnapshot?.self_id ?? '').trim();
                const forceByAt = leftover.some(
                    (e) =>
                        String(e.text || '').trim() &&
                        selfId &&
                        (e.atQqs || []).some((q) => String(q).trim() === selfId)
                        && !/^补充：/.test(String(e.text || '').trim()),
                );
                // 艾特+识图的补充：带 forceFlush，访问结束后立刻再跑一轮
                const forceByAtImageSupplement = leftover.some((e) => Boolean(e.forceFlush));
                if (forceByAt || forceByAtImageSupplement) {
                    deps.logger?.info?.(
                        `[智能对话] ${chatId} leftover 含${forceByAtImageSupplement ? '艾特识图补充/' : ''}艾特，立即访问（${leftover.length} 条）`,
                    );
                    flushChat(deps, chatId, { force: true }).catch((e) =>
                        deps.logger?.error?.('[智能对话] leftover flush 失败:', e),
                    );
                } else if (shouldFlushByBatchCount(leftover.length, cfg.max_batch)) {
                    // 满批/概率：摊反应延迟，别在上一轮刚说完就紧接着又发一次（连击也是可观测特征）
                    scheduleReactionFlush(deps, chatId);
                } else {
                    scheduleFlush(deps, chatId);
                }
            }
        }
    }
}

export function scheduleFlush(deps: SmartChatDeps, chatId: string): void {
    const config = loadSmartChatConfig(deps);
    let state = chatTimers.get(chatId);
    if (!state) {
        state = { timer: null, seq: 0 };
        chatTimers.set(chatId, state);
    }
    // 已装载且未到点的计时（满批/概率的反应延迟、失败退避）不得被重抽覆盖。
    //
    // 为什么：scheduleReactionFlush 的幂等只管它自己被重复调用；但识图/文件补充回调
    // 走的是 handleAsyncSupplement → scheduleFlush，于是「满批已装载 5–45 秒反应延迟」
    // 会被这条路径 clearTimeout 掉，改抽 1–30 分钟随机等待 —— 机制自我矛盾。
    // 缓冲不动，等已装载的计时到点照常访问。
    if (state.timer && Number(state.reactAt) > Date.now()) {
        deps.logger?.info?.(
            `[智能对话] ${chatId} 已有装载中的计时（还剩 ${Math.round(
                (Number(state.reactAt) - Date.now()) / 1000,
            )} 秒），不重抽等待；缓冲继续累积`,
        );
        return;
    }
    // 旧计时当场废弃（消息缓存不动，继续累积）：撤 setTimeout + 递增代数双保险
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.reactAt = 0;
    state.seq = (Number(state.seq) || 0) + 1;
    const mySeq = state.seq;

    const pendingNow = loadChatBuffer(deps, chatId);
    const ageNow = oldestPendingAgeMs(pendingNow);
    const plan = resolveFlushDelay(config as unknown as Record<string, unknown>, ageNow);

    if (plan.mode === 'random') {
        state.waitMs = plan.waitMs;
        state.armedAt = Date.now();
        deps.logger?.info?.(
            `[智能对话] ${chatId} 随机等待 ${Math.floor(plan.waitMs / 60000)} 分 ${Math.round((plan.waitMs % 60000) / 1000)} 秒`
            + `（抽到 ${Math.round(plan.drawMs / 60000)} 分钟${plan.capped ? '，被最老一条的上限收口' : '，已摊秒级抖动'}`
            + `；第 ${mySeq} 次计时，缓冲 ${pendingNow.length} 条）`,
        );
        state.timer = setTimeout(() => {
            if (chatTimers.get(chatId) !== state || state.seq !== mySeq) return; // 已被新消息重抽，作废
            state.timer = null;
            const pending = loadChatBuffer(deps, chatId);
            if (!pending.length) return;
            deps.logger?.info?.(
                `[智能对话] ${chatId} 随机等待到点，访问（${pending.length} 条）`,
            );
            flushChat(deps, chatId).catch((e) => deps.logger?.error?.('[智能对话] 随机计时 flush 失败:', e));
        }, Math.max(0, plan.waitMs));
        return;
    }

    // 随机等待关闭：1.3.1 原口径（固定防抖 + 续到超龄线）
    const arm = (delay: number): void => {
        state.timer = setTimeout(() => {
            if (chatTimers.get(chatId) !== state || state.seq !== mySeq) return;
            state.timer = null;
            const pending = loadChatBuffer(deps, chatId);
            if (!pending.length) return;
            const maxAge = Math.max(0, Number(config.batch_max_age_ms) || 0);
            const age = oldestPendingAgeMs(pending);
            if (shouldFlushOnDebounce(pending.length, config.max_batch, age, maxAge)) {
                if (pending.length < Math.min(25, Math.max(1, Number(config.max_batch) || 1))) {
                    deps.logger?.info?.(
                        `[智能对话] ${chatId} 缓冲超龄（最老 ${Math.round(age / 60000)} 分钟），未满批也访问（${pending.length} 条）`,
                    );
                }
                flushChat(deps, chatId).catch((e) => deps.logger?.error?.('[智能对话] 定时 flush 失败:', e));
                return;
            }
            // 未满批且未超龄：按「还差多久到超龄线」续一次倒计时。
            // 1.3.0 这里直接 return 且不续时，没有新消息进来缓冲就一直挂着。
            const wait = maxAge > 0 && Number.isFinite(age) ? maxAge - age : 0;
            if (wait > 0) arm(Math.max(1000, wait));
        }, Math.max(0, delay));
    };

    arm(plan.waitMs);
}

/**
 * 满批 / 「≥8 条概率提前」触发：摊一个 5-45 秒的反应延迟再访问，别 0 秒秒接。
 *
 * 与 scheduleFlush 的区别：这里不重抽 1-30 分钟，只延后几十秒 ——
 * 缓冲已经满批，本来就该发了，延迟只为消掉「凑够一串就秒回」这个可观测特征。
 * 幂等：已装载且未到点时直接返回，避免活跃群里每来一条新消息都把访问往后推。
 * 被 @ 与识图补充不走这里（见 smart-chat.ts / leftover 分支），仍然立即访问。
 */
export function scheduleReactionFlush(deps: SmartChatDeps, chatId: string): void {
    let state = chatTimers.get(chatId);
    if (!state) {
        state = { timer: null, seq: 0 };
        chatTimers.set(chatId, state);
    }
    const now = Date.now();
    if (state.timer && Number(state.reactAt) > now) return;

    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.seq = (Number(state.seq) || 0) + 1;
    const mySeq = state.seq;

    const delay = pickReactionDelayMs();
    state.waitMs = delay;
    state.armedAt = now;
    state.reactAt = now + delay;
    deps.logger?.info?.(
        `[智能对话] ${chatId} 满批/概率触发，反应延迟 ${Math.round(delay / 1000)} 秒后访问`,
    );
    state.timer = setTimeout(() => {
        if (chatTimers.get(chatId) !== state || state.seq !== mySeq) return;
        state.timer = null;
        state.reactAt = 0;
        const pending = loadChatBuffer(deps, chatId);
        if (!pending.length) return;
        flushChat(deps, chatId).catch((e) => deps.logger?.error?.('[智能对话] 反应延迟 flush 失败:', e));
    }, delay);
}
