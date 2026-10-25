// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 会话历史（Reasonix：prepend-only + 低频 compaction）
// ---------------------------------------------------------------------------
//
// 与 Reasonix SPEC §3.6 一致：
// - 两次 compaction 之间：消息只追加、且与 API 字节一致 → DeepSeek 前缀缓存可命中
// - compaction 是刻意的 cache-reset 点：把旧段折叠成一条永久 digest 消息写入列表
// - 绝不把 digest 每轮挂到 turn 尾（那会让「已存历史 ≠ 上次 API 内容」→ 整段 miss）
//
// 会话按「配置指纹」分目录存放：改 API Key / Base URL / 模型 / system prompt 等任一字段
 // → 新命名空间；改回完全一致配置 → 回到原会话。

import fs from 'fs';
import path from 'path';
import type { SmartChatConfig, SmartChatDeps, SmartChatSessionFile, SmartChatSessionMessage } from './smart-chat-types';
import { SMART_CHAT_LEGACY_ROOT, SMART_CHAT_ROOT, markNativeThinkingModel } from './smart-chat-types';
import { loadSmartChatConfig } from './smart-chat-config';
import {
    fingerprintPreview,
    sessionConfigFingerprint,
} from './smart-chat-fingerprint';
import { presentImageSupplementsForModel } from './smart-chat-image';
import { presentFileNotesForModel } from './smart-chat-file';
import { extractStatusTexts } from './smart-chat-reply';
import {
    configWithEffectivePersona,
    resolveEffectivePersonaForChatId,
} from './smart-chat-switches';
import {
    MAX_FILE_MESSAGES,
    DIGEST_MAX_CHARS,
    SHADOW_LOG_MAX_MESSAGES,
    COMPACTION_RECORD_MAX,
    clipDigestBody,
    looksLikeRealCompactionDigest,
    repairCompactionContent,
    maybeCompactSession,
    collapseStackedDigests,
    collapseRedundantShutUpHistory,
} from './smart-chat-compact';
import {
    writebackFromCompact,
    collectPeopleIdsFromMessages,
} from './smart-chat-memory';
import { loadChatBuffer } from './smart-chat-buffer';
import { resolveCompactionBudget } from './smart-chat-token-meter';

/** 从 cfg 解析压缩预算（无 cfg 则回退纯计数触发，token 字段留 null）。 */
function budgetFromCfg(cfg?: SmartChatConfig) {
    if (!cfg) return null;
    return resolveCompactionBudget(cfg as unknown as Record<string, unknown>, {
        vendor: String((cfg as { vendor?: unknown }).vendor || ''),
        model: String((cfg as { model?: unknown }).model || ''),
    });
}

export {
    COMPACT_MESSAGE_THRESHOLD,
    COMPACT_KEEP_TAIL,
    COMPACT_HYSTERESIS,
    MAX_FILE_MESSAGES,
    collapseRedundantShutUpHistory,
    collapseStackedDigests,
    maybeCompactSession,
    looksLikeRealCompactionDigest,
    repairCompactionContent,
} from './smart-chat-compact';

const SESSIONS_ROOT = `${SMART_CHAT_ROOT}sessions/`;
const BY_CONFIG_ROOT = `${SESSIONS_ROOT}by-config/`;
const REGISTRY_FILE = `${BY_CONFIG_ROOT}_registry.json`;

let migratedFlatOnce = false;

function resolveFingerprint(deps: SmartChatDeps, cfg?: SmartChatConfig): string {
    return sessionConfigFingerprint(cfg || loadSmartChatConfig(deps));
}

/**
 * 目录/文件名安全段：id 会被拼进落盘路径，放行字母数字下划线，
 * 其余（`/ \ . : ..` 等）一律替换成 `_`。QQ 群号/好友号只有数字与 g_/p_ 前缀，
 * 正常值经过本函数不变，所以不会造成历史数据错位。
 */
function safeSegment(raw: unknown, fallback = 'unknown'): string {
    const s = String(raw ?? '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
    return s || fallback;
}

function sessionRelPath(fp: string, chatId: string): string {
    return `${BY_CONFIG_ROOT}${safeSegment(fp, 'default')}/${safeSegment(chatId)}.json`;
}

function legacyFlatSessionPath(chatId: string): string {
    return `${SESSIONS_ROOT}${safeSegment(chatId)}.json`;
}

function legacyDeepSeekPath(chatId: string): string {
    return `${SMART_CHAT_LEGACY_ROOT}DeepSeek/${safeSegment(chatId)}.json`;
}

function absSessionsDir(deps: SmartChatDeps): string {
    return path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions');
}

function absByConfigDir(deps: SmartChatDeps, fp: string): string {
    return path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config', safeSegment(fp, 'default'));
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface SessionRegistry {
    active: string;
    profiles: Record<string, {
        fingerprint: string;
        updated_at: string;
        model?: string;
        base_url?: string;
        session_files?: number;
    }>;
}

function loadRegistry(deps: SmartChatDeps): SessionRegistry {
    const raw = deps.readA(REGISTRY_FILE);
    if (!raw) return { active: '', profiles: {} };
    try {
        const obj = JSON.parse(raw);
        return {
            active: String(obj.active || ''),
            profiles: obj.profiles && typeof obj.profiles === 'object' ? obj.profiles : {},
        };
    } catch {
        return { active: '', profiles: {} };
    }
}

function saveRegistry(deps: SmartChatDeps, reg: SessionRegistry): void {
    deps.writeA(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

function touchRegistry(deps: SmartChatDeps, fp: string, cfg: SmartChatConfig): void {
    const reg = loadRegistry(deps);
    const dir = absByConfigDir(deps, fp);
    let count = 0;
    try {
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.json') || f.endsWith('.memory.json')) continue;
                try {
                    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
                    const obj = JSON.parse(raw);
                    const msgs = Array.isArray(obj?.messages) ? obj.messages : [];
                    const hasSummary = Boolean(
                        obj?.summary
                        || String(msgs[0]?.content || '').includes('<compaction-summary>'),
                    );
                    if (msgs.length > 0 || hasSummary) count += 1;
                } catch {
                    /* 坏文件不计 */
                }
            }
        }
    } catch {
        count = 0;
    }
    reg.active = fp;
    reg.profiles[fp] = {
        fingerprint: fp,
        updated_at: new Date().toISOString(),
        model: cfg.model,
        base_url: cfg.base_url,
        session_files: count,
    };
    saveRegistry(deps, reg);
}

/**
 * 一次性：把旧版扁平 sessions/*.json 迁入当前配置指纹目录。
 * （这些历史默认归属「迁移当时的配置」。）
 */
function migrateFlatSessionsIfNeeded(deps: SmartChatDeps, fp: string): void {
    if (migratedFlatOnce) return;
    migratedFlatOnce = true;
    try {
        const root = absSessionsDir(deps);
        if (!fs.existsSync(root)) return;
        const flat = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
        if (!flat.length) return;
        const dest = absByConfigDir(deps, fp);
        ensureDir(dest);
        for (const f of flat) {
            const src = path.join(root, f);
            const dst = path.join(dest, f);
            if (fs.existsSync(dst)) continue;
            try {
                fs.renameSync(src, dst);
            } catch {
                try {
                    fs.copyFileSync(src, dst);
                    fs.unlinkSync(src);
                } catch {
                    /* ignore */
                }
            }
        }
        deps.logger?.info?.(`[智能对话] 已将 ${flat.length} 个旧会话迁入配置命名空间 ${fingerprintPreview(fp)}`);
    } catch (e) {
        deps.logger?.warn?.('[智能对话] 扁平会话迁移失败:', e?.message || e);
    }
}

export function getActiveSessionNamespace(deps: SmartChatDeps, cfg?: SmartChatConfig): {
    fingerprint: string;
    preview: string;
    relDir: string;
} {
    const config = cfg || loadSmartChatConfig(deps);
    const fp = resolveFingerprint(deps, config);
    migrateFlatSessionsIfNeeded(deps, fp);
    ensureDir(absByConfigDir(deps, fp));
    touchRegistry(deps, fp, config);
    return {
        fingerprint: fp,
        preview: fingerprintPreview(fp),
        relDir: `${BY_CONFIG_ROOT}${fp}/`,
    };
}

function normalizeMessages(messages: unknown[]): SmartChatSessionMessage[] {
    return (messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: String(m.content) }));
}

/** 历史 user：剥 host-state / skill-tree（仅旧会话一次性迁移用；日常 API 路径禁止再剥） */
function stripLegacyUserMetaForMigration(content: string): string {
    let s = String(content || '');
    s = s.replace(/以下 <skill-tree>[^\n]*\n?/g, '');
    s = s.replace(/<skill-tree>[\s\S]*?<\/skill-tree>\s*/gi, '');
    s = s.replace(/<host-state>[\s\S]*?<\/host-state>\s*/gi, '');
    s = s.replace(/(?:^|\n)读史：[^\n]*/g, '');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 历史 assistant：剥掉旧版 API 侧「当时发出」前缀（磁盘不应再带） */
function stripLegacyAssistantApiLabel(content: string): string {
    return String(content || '').replace(/^（你「[^」]+」(?:\([^)]*\))?\s*当时发出）\n/, '');
}

/**
 * 旧会话一次性迁移：磁盘历史 → 与今后 API 同构的稳定史。
 * - 剥历史 user 的 host-state/skill-tree/读史 tip（旧版曾「存完整、发剥离」）
 * - 剥 assistant 的 API 自标前缀；顺带眼睛/status 瘦身一次
 * - 之后 api_history_aligned=true，禁止再静默改写已发送历史
 */
export function migrateApiHistoryAlignment(session: SmartChatSessionFile): boolean {
    if (session.api_history_aligned) return false;
    let changed = false;
    const next = (session.messages || []).map((m, idx) => {
        let content = String(m.content || '');
        if (m.role === 'user') {
            if (
                idx === 0
                && (/<compaction-summary>/i.test(content) || looksLikeRealCompactionDigest(content))
            ) {
                const repaired = repairCompactionContent(content);
                if (repaired !== content) {
                    changed = true;
                    content = repaired;
                }
                const eyed = presentFileNotesForModel(presentImageSupplementsForModel(content, 48, { dropFailed: true }));
                if (eyed !== content) {
                    changed = true;
                    content = eyed;
                }
            } else {
                const stripped = stripLegacyUserMetaForMigration(content);
                const eyed = presentFileNotesForModel(presentImageSupplementsForModel(stripped, 48, { dropFailed: true }));
                if (eyed !== content) {
                    changed = true;
                    content = eyed;
                }
            }
        } else if (m.role === 'assistant') {
            let c = stripLegacyAssistantApiLabel(content);
            const { rest } = extractStatusTexts(c);
            c = rest || c;
            if (c !== content) {
                changed = true;
                content = c;
            }
        }
        return { role: m.role, content };
    });
    if (changed) session.messages = next;
    session.api_history_aligned = true;
    return true;
}

function parseSessionRaw(raw: string | false): SmartChatSessionFile {
    if (!raw) return { messages: [] };
    try {
        const obj = JSON.parse(raw);
        const streak = Number(obj?.shut_up_streak);
        const chatTypeRaw = String(obj?.chat_type || '').trim();
        const chat_type = chatTypeRaw === 'group' || chatTypeRaw === 'private'
            ? chatTypeRaw
            : undefined;
        const group_id = String(obj?.group_id ?? '').trim() || undefined;
        const group_name = String(obj?.group_name ?? '').trim() || undefined;
        const bot_join_time = Number(obj?.bot_join_time);
        const bot_role_raw = String(obj?.bot_role || '').trim().toLowerCase();
        const bot_role = bot_role_raw === 'owner' || bot_role_raw === 'admin' || bot_role_raw === 'member'
            ? bot_role_raw
            : undefined;
        const standing_raw = String(obj?.bot_standing || '').trim();
        const bot_standing = standing_raw === '新成员' || standing_raw === '普通群成员' || standing_raw === '老成员'
            ? standing_raw
            : undefined;
        const session: SmartChatSessionFile = {
            messages: normalizeMessages(Array.isArray(obj?.messages) ? obj.messages : []),
            summary: typeof obj.summary === 'string' ? obj.summary : undefined,
            compacted_at: typeof obj.compacted_at === 'string' ? obj.compacted_at : undefined,
            shut_up_streak: Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0,
            prefer_no_reply: Boolean(obj?.prefer_no_reply),
            prefer_silence: Boolean(obj?.prefer_silence),
            prefer_silence_at: typeof obj?.prefer_silence_at === 'string' && obj.prefer_silence_at.trim()
                ? String(obj.prefer_silence_at).trim()
                : undefined,
        };
        if (chat_type) session.chat_type = chat_type;
        if (group_id) session.group_id = group_id;
        if (group_name) session.group_name = group_name;
        if (Number.isFinite(bot_join_time) && bot_join_time > 0) {
            session.bot_join_time = Math.floor(bot_join_time);
        }
        const bot_join_at = String(obj?.bot_join_at ?? '').trim();
        if (bot_join_at) session.bot_join_at = bot_join_at;
        if (bot_role) session.bot_role = bot_role;
        const bot_role_label = String(obj?.bot_role_label ?? '').trim();
        if (bot_role_label) session.bot_role_label = bot_role_label;
        if (bot_standing) session.bot_standing = bot_standing;
        const bot_card = String(obj?.bot_card ?? '').trim();
        if (bot_card) session.bot_card = bot_card;
        const bot_nickname = String(obj?.bot_nickname ?? '').trim();
        if (bot_nickname) session.bot_nickname = bot_nickname;
        if (Boolean(obj?.api_history_aligned)) session.api_history_aligned = true;
        const caps = obj?.frozen_system_caps;
        if (caps && typeof caps === 'object') {
            session.frozen_system_caps = {
                tools: Boolean(caps.tools),
                image: Boolean(caps.image),
                sticker: Boolean(caps.sticker),
                think: Boolean(caps.think),
                think_model: String(caps.think_model || '').trim().toLowerCase(),
            };
        }
        const skillTree = obj?.frozen_skill_tree;
        if (skillTree && typeof skillTree === 'object' && String(skillTree.text || '').trim()) {
            session.frozen_skill_tree = {
                hash: String(skillTree.hash || ''),
                text: String(skillTree.text || ''),
            };
        }
        const stickerSuffix = obj?.frozen_sticker_suffix;
        if (stickerSuffix && typeof stickerSuffix === 'object' && String(stickerSuffix.text || '').trim()) {
            session.frozen_sticker_suffix = {
                key: String(stickerSuffix.key || ''),
                text: String(stickerSuffix.text || ''),
            };
        }
        const lastHash = String(obj?.last_api_prefix_hash ?? '').trim();
        if (lastHash) session.last_api_prefix_hash = lastHash;
        const prefixEpoch = Number(obj?.last_api_prefix_epoch);
        if (Number.isFinite(prefixEpoch) && prefixEpoch >= 0) session.last_api_prefix_epoch = Math.floor(prefixEpoch);
        // A② 影子日志与 compaction 台账（缺字段的老文件照常工作）
        const shadow = Array.isArray(obj?.shadow_log) ? obj.shadow_log : [];
        if (shadow.length) {
            const rows = shadow
                .map((r: unknown) => {
                    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
                    const role = String(o.role || 'user') === 'assistant' ? 'assistant' : 'user';
                    const content = String(o.content ?? '');
                    return content ? { role, content } : null;
                })
                .filter(Boolean)
                .slice(-SHADOW_LOG_MAX_MESSAGES) as Array<{ role: string; content: string }>;
            if (rows.length) session.shadow_log = rows;
        }
        const epoch = Number(obj?.compaction_epoch);
        if (Number.isFinite(epoch) && epoch > 0) session.compaction_epoch = Math.floor(epoch);
        const compactions = Array.isArray(obj?.compactions) ? obj.compactions : [];
        if (compactions.length) {
            session.compactions = compactions
                .map((r: unknown) => (r && typeof r === 'object' ? r : null))
                .filter(Boolean)
                .slice(-COMPACTION_RECORD_MAX) as SmartChatSessionFile['compactions'];
        }
        const fusionHash = String(obj?.persona_fusion_hash ?? '').trim();
        if (fusionHash) session.persona_fusion_hash = fusionHash;
        if (Boolean(obj?.native_thinking_seen)) session.native_thinking_seen = true;
        const nativeModels = Array.isArray(obj?.native_thinking_models) ? obj.native_thinking_models : [];
        if (nativeModels.length) {
            const keys = nativeModels
                .map((s: unknown) => String(s || '').trim().toLowerCase())
                .filter(Boolean);
            if (keys.length) session.native_thinking_models = Array.from(new Set(keys)).slice(-24);
        }
        const thinkingLog = Array.isArray(obj?.thinking_log) ? obj.thinking_log : [];
        if (thinkingLog.length) {
            const rows = thinkingLog
                .map((r: unknown) => {
                    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
                    const text = String(o.text || '').trim();
                    if (!text) return null;
                    const kind = String(o.kind || '') === 'native' ? 'native' : 'fake';
                    const at = String(o.at || '').trim() || new Date().toISOString();
                    return { at, kind, text };
                })
                .filter(Boolean)
                .slice(-30);
            if (rows.length) session.thinking_log = rows as SmartChatSessionFile['thinking_log'];
        }
        const recentStickers = Array.isArray(obj?.recent_stickers)
            ? obj.recent_stickers.map((x: unknown) => String(x || '').trim()).filter(Boolean).slice(0, 6)
            : [];
        if (recentStickers.length) session.recent_stickers = recentStickers;
        // 无 chat_type 时：有群号则视为群聊（兼容旧文件 / 仅靠文件名推断前的半填充）
        if (!session.chat_type && group_id) session.chat_type = 'group';
        migrateLegacySummaryIntoMessages(session);
        return session;
    } catch {
        return { messages: [] };
    }
}

/**
 * 旧数据：summary 很大且 messages 已是 compact 后的尾巴。
 * 若 messages 开头还没有 compaction-summary，则插入一次，并清空 summary。
 */
function migrateLegacySummaryIntoMessages(session: SmartChatSessionFile): void {
    const summary = String(session.summary || '').trim();
    if (!summary) return;
    const first = session.messages[0]?.content || '';
    if (first.includes('<compaction-summary>')) {
        delete session.summary;
        return;
    }
    let digest = summary;
    if (digest.length > DIGEST_MAX_CHARS) digest = clipDigestBody(digest, DIGEST_MAX_CHARS);
    session.messages = [
        { role: 'user', content: repairCompactionContent(`<compaction-summary>\n${digest}\n</compaction-summary>`) },
        ...session.messages,
    ];
    delete session.summary;
}

export function loadSession(deps: SmartChatDeps, chatId: string, cfg?: SmartChatConfig): SmartChatSessionFile {
    const ns = getActiveSessionNamespace(deps, cfg);
    let raw = deps.readA(sessionRelPath(ns.fingerprint, chatId));
    // 兼容：尚未迁走的扁平文件 / 更旧 DeepSeek 目录（只读一次，写入时进指纹目录）
    if (!raw) raw = deps.readA(legacyFlatSessionPath(chatId));
    if (!raw) raw = deps.readA(legacyDeepSeekPath(chatId));
    const session = parseSessionRaw(raw);
    let dirty = false;
    // Reasonix：仅未对齐旧脏数据做一次迁移；已对齐则禁止每轮瘦身改写历史
    if (migrateApiHistoryAlignment(session)) dirty = true;
    // 叠 digest 迁移（智能对话11 类故障）：合并为 index0 单条
    if (collapseStackedDigests(session)) dirty = true;
    if (dirty && raw) {
        try {
            saveSession(deps, chatId, session, cfg);
        } catch {
            /* ignore rewrite failures */
        }
    }
    return session;
}

export function saveSession(deps: SmartChatDeps, chatId: string, session: SmartChatSessionFile, cfg?: SmartChatConfig): void {
    const ns = getActiveSessionNamespace(deps, cfg);
    let messages = session.messages || [];
    // 硬上限安全阀：走同一 maybeCompactSession（策略不在此另写）
    if (messages.length > MAX_FILE_MESSAGES) {
        maybeCompactSession(session, budgetFromCfg(cfg));
        messages = session.messages || [];
    }
    const toSave: SmartChatSessionFile & { config_fingerprint: string } = {
        ...session,
        messages,
        config_fingerprint: ns.fingerprint,
    };
    if (!toSave.summary) delete toSave.summary;
    if (!toSave.chat_type) delete toSave.chat_type;
    if (!toSave.group_id) delete toSave.group_id;
    if (!toSave.group_name) delete toSave.group_name;
    if (!toSave.bot_join_time) delete toSave.bot_join_time;
    if (!toSave.bot_join_at) delete toSave.bot_join_at;
    if (!toSave.bot_role) delete toSave.bot_role;
    if (!toSave.bot_role_label) delete toSave.bot_role_label;
    if (!toSave.bot_standing) delete toSave.bot_standing;
    if (!toSave.bot_card) delete toSave.bot_card;
    if (!toSave.bot_nickname) delete toSave.bot_nickname;
    if (!toSave.api_history_aligned) delete toSave.api_history_aligned;
    if (!toSave.frozen_system_caps) delete toSave.frozen_system_caps;
    if (!toSave.frozen_skill_tree?.text) delete toSave.frozen_skill_tree;
    if (!toSave.frozen_sticker_suffix?.text) delete toSave.frozen_sticker_suffix;
    if (!toSave.last_api_prefix_hash) delete toSave.last_api_prefix_hash;
    if (!toSave.persona_fusion_hash) delete toSave.persona_fusion_hash;
    if (!toSave.native_thinking_seen) delete toSave.native_thinking_seen;
    if (!toSave.native_thinking_models?.length) delete toSave.native_thinking_models;
    if (!toSave.thinking_log?.length) delete toSave.thinking_log;
    if (!toSave.shadow_log?.length) delete toSave.shadow_log;
    if (!toSave.compactions?.length) delete toSave.compactions;
    if (!toSave.compaction_epoch) delete toSave.compaction_epoch;
    const wrote = deps.writeA(sessionRelPath(ns.fingerprint, chatId), JSON.stringify(toSave, null, 2));
    if (wrote === false) {
        // 写失败还被当成成功，会连着两件事一起坏：注册表 updated_at 会谎报「刚更新过」，
        // 而 last_api_prefix_hash 与消息都没落盘 → 下一轮会把旧历史重发。
        // 这里明确报错并跳过 touchRegistry，让上面的调用方/日志能看到真实状态。
        deps.logger?.error?.(
            `[智能对话] 会话落盘失败 ${chatId}（messages=${(session.messages || []).length}）`,
        );
        return;
    }
    touchRegistry(deps, ns.fingerprint, cfg || loadSmartChatConfig(deps));
}

/**
 * Reasonix prepend-only：整段已确认对话原样进入 API messages，不做「历史轮数」滑动截断。
 */
export function getPrependOnlyMessages(session: SmartChatSessionFile): SmartChatSessionMessage[] {
    return [...(session.messages || [])];
}

/**
 * 按「访问轮次」截取历史（不含本轮待发消息）。
 * rounds≤0：全部；否则从尾部取最近 rounds 条 user 消息及其后内容。
 */
export function sliceMessagesByRounds(
    messages: Array<{ role: string; content: string }>,
    rounds: number,
): Array<{ role: string; content: string }> {
    const list = Array.isArray(messages) ? messages : [];
    const n = Number(rounds);
    if (!Number.isFinite(n) || n <= 0) return list;
    const want = Math.min(999, Math.max(1, Math.floor(n)));
    let userCount = 0;
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.role === 'user') {
            userCount += 1;
            if (userCount >= want) {
                start = i;
                break;
            }
        }
    }
    return list.slice(start);
}


export function appendSessionTurn(
    deps: SmartChatDeps,
    chatId: string,
    userContentExact: string,
    assistantContent: string,
    cfg?: SmartChatConfig,
    opts?: {
        shutUp?: boolean;
        preferNoReply?: boolean;
        preferSilence?: boolean;
        /**
         * 本轮 flush 中的会话对象（含 frozen_system_caps / last_api_prefix_hash）。
         * 传入则不再 loadSession，避免落盘前内存字段被磁盘旧快照盖掉。
         */
        baseSession?: SmartChatSessionFile;
        /** 会话顶层元数据（群号/群名等；不进 messages） */
        chatMeta?: {
            chat_type?: 'group' | 'private';
            group_id?: string;
            group_name?: string;
        };
        /** 本轮思考文本（伪装 <think> 或原生 reasoning）；只落盘顶层，不进 messages */
        thinkingText?: string;
        /** 思考来源：fake=伪装 <think>；native=上游原生思考 */
        thinkingKind?: 'fake' | 'native';
        /** 本轮是否见到上游原生思考字段（配合下面的厂商/模型记进名单） */
        nativeThinkingSeen?: boolean;
        /** 本轮实际出活的厂商 / 模型（轮替后是替补模型）；原生思考按模型记名单 */
        nativeThinkingVendor?: string;
        nativeThinkingModel?: string;
    },
): SmartChatSessionFile {
    const session = opts?.baseSession || loadSession(deps, chatId, cfg);
    session.messages.push({ role: 'user', content: userContentExact });
    session.messages.push({ role: 'assistant', content: assistantContent });
    // 伪装/原生思考落盘（仅顶层，供后台复盘；绝不进 messages / 不送 API）
    const thinkingText = String(opts?.thinkingText || '').trim();
    if (thinkingText) {
        const log = Array.isArray(session.thinking_log) ? session.thinking_log : [];
        log.push({
            at: new Date().toISOString(),
            kind: opts?.thinkingKind === 'native' ? 'native' : 'fake',
            text: thinkingText.length > 4000 ? `${thinkingText.slice(0, 4000)}…` : thinkingText,
        });
        session.thinking_log = log.slice(-30);
    }
    if (opts?.nativeThinkingSeen) {
        session.native_thinking_seen = true;
        // 名单按模型记：只有这个模型以后不挂伪装思考，换回不会思考的模型照常挂
        markNativeThinkingModel(session, opts?.nativeThinkingVendor, opts?.nativeThinkingModel);
    }
    if (opts?.shutUp) {
        const limit = Math.max(1, Number(cfg?.shut_up_limit) || 5);
        const next = Math.max(0, Number(session.shut_up_streak) || 0) + 1;
        // 封顶显示；达限后下一轮由 decideSilence.forceSpeak 强制开口
        session.shut_up_streak = Math.min(limit, next);
    } else {
        session.shut_up_streak = 0;
    }
    if (opts?.preferNoReply != null) {
        session.prefer_no_reply = Boolean(opts.preferNoReply);
    }
    if (opts?.preferSilence != null) {
        if (opts.preferSilence) {
            session.prefer_silence = true;
            if (!session.prefer_silence_at) {
                session.prefer_silence_at = new Date().toISOString();
            }
        } else {
            session.prefer_silence = false;
            delete session.prefer_silence_at;
        }
    }
    if (!session.api_history_aligned) session.api_history_aligned = true;
    applySessionChatMeta(session, opts?.chatMeta);
    const compactedBefore = session.compacted_at;
    // B3：带上 token 预算，让「达 token 阈值」也能触发（并把 tokens_before/window 记进影子日志），
    // 不再是纯 96 条计数一种触发。无 cfg 时回退计数。
    maybeCompactSession(session, budgetFromCfg(cfg));
    if (session.compacted_at && session.compacted_at !== compactedBefore) {
        try {
            const ns = getActiveSessionNamespace(deps, cfg);
            // 只把 digest 的「立场/约定」要点写进记忆 episode；没有立场就传空串（→ 不写 episode）。
            // 绝不把 digest 表头或 <digest-users> 的带时间戳原始转录当「近史」存盘，
            // 否则会每轮召回一堆旧聊天记录，既撑爆上下文又污染当前话题。
            const digestContent = String(session.messages?.[0]?.content || '');
            const stanceMatch = digestContent.match(/<digest-stance>\s*([\s\S]*?)\s*<\/digest-stance>/i);
            const digest = stanceMatch
                ? stanceMatch[1]
                    .split(/\n+/)
                    .map((l) => l.replace(/^\s*[-•·]\s*/, '').trim())
                    .filter((l) => l && l !== '（本段无明显约定/立场句）')
                    .join('；')
                : '';
            writebackFromCompact(
                deps,
                ns.fingerprint,
                chatId,
                digest,
                collectPeopleIdsFromMessages(session),
            );
        } catch {
            /* memory 写回失败不影响主会话 */
        }
    }
    saveSession(deps, chatId, session, cfg);
    return session;
}

/** 把群号/群名等写到会话顶层（不碰 messages） */
export function applySessionChatMeta(
    session: SmartChatSessionFile,
    meta?: {
        chat_type?: 'group' | 'private';
        group_id?: string;
        group_name?: string;
    } | null,
): void {
    if (!meta) return;
    if (meta.chat_type === 'group' || meta.chat_type === 'private') {
        session.chat_type = meta.chat_type;
    }
    if (meta.chat_type === 'private') {
        delete session.group_id;
        delete session.group_name;
        delete session.bot_join_time;
        delete session.bot_join_at;
        delete session.bot_role;
        delete session.bot_role_label;
        delete session.bot_standing;
        delete session.bot_card;
        delete session.bot_nickname;
        return;
    }
    const gid = String(meta.group_id || '').trim();
    const gname = String(meta.group_name || '').trim();
    if (gid) {
        session.chat_type = 'group';
        session.group_id = gid;
    }
    if (gname) session.group_name = gname;
}

function emptySessionPreservingMeta(
    chatId: string,
    prev: SmartChatSessionFile,
): SmartChatSessionFile {
    const empty: SmartChatSessionFile = {
        messages: [],
        shut_up_streak: 0,
        prefer_no_reply: false,
        prefer_silence: false,
        api_history_aligned: true,
    };
    delete empty.prefer_silence_at;
    // 清空对话时保留群号/群名/站位声明，避免只剩文件名可辨认、也不重复拉身份
    // 不保留 frozen_system_caps / frozen_skill_tree / frozen_sticker_suffix / last_api_prefix_hash：
    // 清空=新窗口，允许重新冻结 system
    if (prev.chat_type) empty.chat_type = prev.chat_type;
    if (prev.group_id) empty.group_id = prev.group_id;
    if (prev.group_name) empty.group_name = prev.group_name;
    if (prev.bot_join_time) empty.bot_join_time = prev.bot_join_time;
    if (prev.bot_join_at) empty.bot_join_at = prev.bot_join_at;
    if (prev.bot_role) empty.bot_role = prev.bot_role;
    if (prev.bot_role_label) empty.bot_role_label = prev.bot_role_label;
    if (prev.bot_standing) empty.bot_standing = prev.bot_standing;
    if (prev.bot_card) empty.bot_card = prev.bot_card;
    if (prev.bot_nickname) empty.bot_nickname = prev.bot_nickname;
    if (!empty.group_id && /^g_(\d+)$/i.test(chatId)) {
        empty.chat_type = 'group';
        empty.group_id = chatId.slice(2);
    }
    if (!empty.chat_type && /^p_/i.test(chatId)) empty.chat_type = 'private';
    return empty;
}

export function clearSession(deps: SmartChatDeps, chatId: string, cfg?: SmartChatConfig): void {
    const ns = getActiveSessionNamespace(deps, cfg);
    const prev = loadSession(deps, chatId, cfg);
    const empty = emptySessionPreservingMeta(chatId, prev);
    deps.writeA(
        sessionRelPath(ns.fingerprint, chatId),
        JSON.stringify({ ...empty, config_fingerprint: ns.fingerprint }, null, 2),
    );
}

/** 读取指定指纹命名空间下的会话（不写回、不迁到当前 ns） */
export function loadSessionAtFingerprint(
    deps: SmartChatDeps,
    chatId: string,
    fingerprint: string,
): SmartChatSessionFile {
    const fp = String(fingerprint || '').trim();
    if (!fp) return parseSessionRaw(false);
    const raw = deps.readA(sessionRelPath(fp, chatId));
    return parseSessionRaw(raw);
}

/** 清空指定指纹命名空间下的会话消息（保留 meta） */
export function clearSessionAtFingerprint(
    deps: SmartChatDeps,
    chatId: string,
    fingerprint: string,
): void {
    const fp = String(fingerprint || '').trim();
    if (!fp) return;
    const prev = loadSessionAtFingerprint(deps, chatId, fp);
    const empty = emptySessionPreservingMeta(chatId, prev);
    deps.writeA(
        sessionRelPath(fp, chatId),
        JSON.stringify({ ...empty, config_fingerprint: fp }, null, 2),
    );
}

/**
 * 物理删除某会话在「其他配置指纹命名空间」下的会话文件（保留 keepFingerprint 下的那份）。
 * 用于「长按删除会话 → 是否删除其他会话数据」。返回删除的文件数与命中的指纹。
 */
export function purgeOtherSessionData(
    deps: SmartChatDeps,
    chatId: string,
    keepFingerprint?: string,
): { removed: number; fingerprints: string[] } {
    const id = String(chatId || '').trim();
    const keep = String(keepFingerprint || '').trim();
    const removedFps: string[] = [];
    let removed = 0;
    if (!id) return { removed, fingerprints: removedFps };
    const root = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config');
    if (!fs.existsSync(root)) return { removed, fingerprints: removedFps };
    let fps: string[] = [];
    try {
        fps = fs.readdirSync(root).filter((name) => {
            if (name.startsWith('_') || name.startsWith('.')) return false;
            try {
                return fs.statSync(path.join(root, name)).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return { removed, fingerprints: removedFps };
    }
    for (const fp of fps) {
        if (keep && fp === keep) continue;
        const full = path.join(root, safeSegment(fp), `${safeSegment(id)}.json`);
        // 再加一道包含性断言：即便 safeSegment 被绕过，也不许删到 by-config 之外
        const rootAbs = path.resolve(root);
        if (!path.resolve(full).startsWith(rootAbs + path.sep)) continue;
        try {
            if (fs.existsSync(full)) {
                fs.unlinkSync(full);
                removed += 1;
                removedFps.push(fp);
            }
        } catch {
            /* ignore */
        }
    }
    return { removed, fingerprints: removedFps };
}

export function listSessionIds(deps: SmartChatDeps, cfg?: SmartChatConfig): string[] {
    const ns = getActiveSessionNamespace(deps, cfg);
    const dir = absByConfigDir(deps, ns.fingerprint);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

export interface SmartChatSessionListRow {
    chatId: string;
    messageCount: number;
    hasSummary: boolean;
    chat_type?: string;
    group_id?: string;
    group_name?: string;
    bot_standing?: string;
    bot_role_label?: string;
    bot_join_at?: string;
    config_fingerprint: string;
    /** 是否属于当前配置指纹（正常使用中） */
    active: boolean;
}

/** 扫描全部 by-config 指纹目录下的会话（含非当前配置） */
export function listAllSessionRows(deps: SmartChatDeps, cfg?: SmartChatConfig): SmartChatSessionListRow[] {
    const baseCfg = cfg || loadSmartChatConfig(deps);
    // 触发迁移 / 目录创建（全局指纹即可）
    getActiveSessionNamespace(deps, baseCfg);
    const root = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config');
    const rows: SmartChatSessionListRow[] = [];
    if (!fs.existsSync(root)) return rows;

    let fps: string[] = [];
    try {
        fps = fs.readdirSync(root).filter((name) => {
            if (name.startsWith('_') || name.startsWith('.')) return false;
            try {
                return fs.statSync(path.join(root, name)).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return rows;
    }

    for (const fp of fps) {
        const dir = path.join(root, fp);
        let files: string[] = [];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        } catch {
            continue;
        }
        for (const file of files) {
            const chatId = file.replace(/\.json$/, '');
            if (!chatId) continue;
            const s = loadSessionAtFingerprint(deps, chatId, fp);
            let chatType = s.chat_type || undefined;
            if (!chatType) {
                if (/^p_/i.test(chatId)) chatType = 'private';
                else if (/^g_/i.test(chatId)) chatType = 'group';
            }
            let groupId = s.group_id || undefined;
            if (!groupId && chatType === 'group' && /^g_(\d+)$/i.test(chatId)) {
                groupId = chatId.slice(2);
            }
            if (!groupId && chatType === 'private' && /^p_(\d+)$/i.test(chatId)) {
                groupId = chatId.slice(2);
            }
            const expectFp = sessionConfigFingerprint(
                configWithEffectivePersona(
                    baseCfg,
                    resolveEffectivePersonaForChatId(deps, chatId, baseCfg),
                ),
            );
            rows.push({
                chatId,
                messageCount: (s.messages || []).length,
                hasSummary: Boolean(
                    s.summary || (s.messages[0]?.content || '').includes('<compaction-summary>'),
                ),
                chat_type: chatType,
                group_id: groupId,
                group_name: s.group_name || undefined,
                bot_standing: s.bot_standing || undefined,
                bot_role_label: s.bot_role_label || undefined,
                bot_join_at: s.bot_join_at || undefined,
                config_fingerprint: fp,
                active: fp === expectFp,
            });
        }
    }
    return rows;
}

/** 会话是否有可展示内容（非幽灵空文件） */
export function sessionRowHasContent(row: Pick<SmartChatSessionListRow, 'messageCount' | 'hasSummary'>): boolean {
    return Number(row.messageCount || 0) > 0 || Boolean(row.hasSummary);
}

/**
 * 清理幽灵空会话：无 messages、无 summary、无 buffer 的 json。
 * 可选删除空指纹目录。不删 .memory.json。
 */
export function pruneEmptySessions(
    deps: SmartChatDeps,
    opts?: { removeEmptyNamespaces?: boolean },
): { removedFiles: number; removedNamespaces: number; paths: string[] } {
    const root = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config');
    const paths: string[] = [];
    let removedFiles = 0;
    let removedNamespaces = 0;
    if (!fs.existsSync(root)) {
        return { removedFiles, removedNamespaces, paths };
    }

    let fps: string[] = [];
    try {
        fps = fs.readdirSync(root).filter((name) => {
            if (name.startsWith('_') || name.startsWith('.')) return false;
            try {
                return fs.statSync(path.join(root, name)).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return { removedFiles, removedNamespaces, paths };
    }

    for (const fp of fps) {
        const dir = path.join(root, fp);
        let files: string[] = [];
        try {
            files = fs.readdirSync(dir);
        } catch {
            continue;
        }
        let remainingJson = 0;
        for (const file of files) {
            if (file.endsWith('.memory.json')) {
                remainingJson += 1;
                continue;
            }
            if (!file.endsWith('.json')) continue;
            const chatId = file.replace(/\.json$/, '');
            const full = path.join(dir, file);
            try {
                const raw = fs.readFileSync(full, 'utf8');
                const obj = JSON.parse(raw);
                const msgs = Array.isArray(obj?.messages) ? obj.messages : [];
                const hasSummary = Boolean(
                    obj?.summary
                    || String(msgs[0]?.content || '').includes('<compaction-summary>'),
                );
                if (msgs.length > 0 || hasSummary) {
                    remainingJson += 1;
                    continue;
                }
                let hasBuf = false;
                try {
                    hasBuf = Boolean(loadChatBuffer(deps, chatId)?.length);
                } catch {
                    hasBuf = false;
                }
                if (hasBuf) {
                    remainingJson += 1;
                    continue;
                }
                fs.unlinkSync(full);
                removedFiles += 1;
                paths.push(`${fp}/${file}`);
            } catch {
                remainingJson += 1;
            }
        }
        if (opts?.removeEmptyNamespaces && remainingJson === 0) {
            try {
                const left = fs.readdirSync(dir);
                if (!left.length) {
                    fs.rmdirSync(dir);
                    removedNamespaces += 1;
                    paths.push(`${fp}/`);
                }
            } catch {
                /* ignore */
            }
        }
    }

    try {
        const cfg = loadSmartChatConfig(deps);
        const ns = getActiveSessionNamespace(deps, cfg);
        touchRegistry(deps, ns.fingerprint, cfg);
    } catch {
        /* ignore */
    }

    return { removedFiles, removedNamespaces, paths };
}

export function listSessionNamespaces(deps: SmartChatDeps): {
    active: string;
    activePreview: string;
    profiles: Array<{ fingerprint: string; preview: string; model?: string; base_url?: string; updated_at?: string; session_files?: number }>;
} {
    const ns = getActiveSessionNamespace(deps);
    const reg = loadRegistry(deps);
    const profiles = Object.values(reg.profiles || {}).map((p) => ({
        fingerprint: p.fingerprint,
        preview: fingerprintPreview(p.fingerprint),
        model: p.model,
        base_url: p.base_url,
        updated_at: p.updated_at,
        session_files: p.session_files,
    }));
    // 也扫描磁盘上其它指纹目录
    try {
        const root = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config');
        if (fs.existsSync(root)) {
            for (const name of fs.readdirSync(root)) {
                if (name.startsWith('_') || name.startsWith('.')) continue;
                const full = path.join(root, name);
                if (!fs.statSync(full).isDirectory()) continue;
                if (profiles.some((p) => p.fingerprint === name)) continue;
                const count = fs.readdirSync(full).filter((f) => f.endsWith('.json')).length;
                profiles.push({
                    fingerprint: name,
                    preview: fingerprintPreview(name),
                    session_files: count,
                });
            }
        }
    } catch {
        /* ignore */
    }
    profiles.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    return {
        active: ns.fingerprint,
        activePreview: ns.preview,
        profiles,
    };
}
