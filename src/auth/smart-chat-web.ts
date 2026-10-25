// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 WebUI API
// ---------------------------------------------------------------------------

import type { SmartChatConfig, SmartChatDeps } from './smart-chat-types';
import {
    DEFAULT_PERSONA_LINE,
    DEFAULT_SYSTEM_PROMPT,
    clampPersonaText,
    extractPersonaLine,
} from './smart-chat-types';
import {
    configForWeb,
    loadSmartChatConfig,
    normalizeSmartChatConfig,
    saveSmartChatConfig,
} from './smart-chat-config';
import {
    applyBotNickToSystemPrompt,
    BOT_NICK_FALLBACK,
    BOT_NICK_PLACEHOLDER,
    ensureBotIdentity,
    getBotNickname,
} from './smart-chat-identity';
import { clearChatBuffer, loadChatBuffer } from './smart-chat-buffer';
import {
    clearSession,
    clearSessionAtFingerprint,
    getActiveSessionNamespace,
    listAllSessionRows,
    listSessionNamespaces,
    loadSession,
    loadSessionAtFingerprint,
    pruneEmptySessions,
    purgeOtherSessionData,
    sessionRowHasContent,
} from './smart-chat-session';
import {
    deleteKnowledge,
    ensureBuiltinKnowledge,
    isBuiltinSkillId,
    listKnowledge,
    listKnowledgeScopes,
    setKnowledgeEnabled,
    upsertKnowledge,
} from './smart-chat-knowledge';
import { listMkApiToolSkillRows, setMkApiToolEnabled } from './smart-chat-mkapi';
import { clearUsageLedger, fetchBalance, getUsageSummary, testConnection, probeChatAccess, simulateChatAccess, bindNvidiaRateDeps } from './smart-chat-billing';
import { fetchModelList } from './smart-chat-models';
import { isCustomVendorId, normalizeCustomVendors, normalizeRotationMode, isHttpEndpoint, endpointChangeNeedsKey } from './smart-chat-config';
import { bindRotationDeps } from './smart-chat-rotation';
import {
    bulkSetSmartChatEnabled,
    configWithEffectivePersona,
    getSmartChatFriendRounds,
    getSmartChatGroupRounds,
    getSmartChatPersonaOverride,
    isSmartChatAiOnlyFriend,
    isSmartChatAiOnlyGroup,
    isSmartChatAtOnlyFriend,
    isSmartChatAtOnlyGroup,
    isSmartChatAtOnlyRecordFriend,
    isSmartChatAtOnlyRecordGroup,
    isSmartChatFakeThinkFriend,
    isSmartChatFakeThinkGroup,
    isSmartChatAllowVoiceFriend,
    isSmartChatAllowVoiceGroup,
    isSmartChatFriendEnabled,
    isSmartChatGroupEnabled,
    isSmartChatImageFriend,
    isSmartChatImageGroup,
    isSmartChatStickerFriend,
    isSmartChatStickerGroup,
    isSmartChatToolsFriend,
    isSmartChatToolsGroup,
    listSmartChatSwitchMap,
    loadConfigForChat,
    normalizeSmartChatRounds,
    resolveEffectivePersonaLine,
    setSmartChatAiOnlyFriend,
    setSmartChatAiOnlyGroup,
    setSmartChatAtOnlyFriend,
    setSmartChatAtOnlyGroup,
    setSmartChatAtOnlyRecordFriend,
    setSmartChatAtOnlyRecordGroup,
    setSmartChatFakeThinkFriend,
    setSmartChatFakeThinkGroup,
    setSmartChatAllowVoiceFriend,
    setSmartChatAllowVoiceGroup,
    setSmartChatFriendEnabled,
    setSmartChatFriendRounds,
    setSmartChatGroupEnabled,
    setSmartChatGroupRounds,
    setSmartChatImageFriend,
    setSmartChatImageGroup,
    isSmartChatFileGroup,
    setSmartChatFileGroup,
    setSmartChatPersonaOverride,
    setSmartChatStickerFriend,
    setSmartChatStickerGroup,
    setSmartChatToolsFriend,
    setSmartChatToolsGroup,
} from './smart-chat-switches';
import { sessionConfigFingerprint } from './smart-chat-fingerprint';
import { fetchVoiceRoles, fetchQQVoiceCharacters } from './smart-chat-voice';
import {
    getActiveStickerInstallByGallery,
    getStickerInstallProgress,
    isAnyStickerGalleryReady,
    listStickerGalleriesStatus,
    startStickerGalleryInstall,
} from './smart-chat-sticker';
import {
    WEB_SEARCH_PROVIDER_META,
    listConfiguredProviders,
    testWebSearchProvider,
    type WebSearchProviderId,
} from './smart-chat-tools';
import {
    addBlacklistIds,
    loadBlacklistIds,
    removeBlacklistIds,
    saveBlacklistIds,
    type BlacklistKind,
} from './smart-chat-blacklist';


function readForceFlag(req: { query?: Record<string, unknown>; raw?: { originalUrl?: string; url?: string }; url?: string }): boolean {
    const q = req?.query || {};
    if (String(q.force || q.refresh || '') === '1' || String(q.force || '').toLowerCase() === 'true') {
        return true;
    }
    const rawUrl = String(req?.raw?.originalUrl || req?.raw?.url || req?.url || '');
    try {
        const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
        const params = new URLSearchParams(qs);
        const v = params.get('force') || params.get('refresh') || '';
        return v === '1' || v.toLowerCase() === 'true';
    } catch {
        return false;
    }
}

/**
 * 会话/开关/指纹 id 的白名单。
 *
 * 为什么必须有：这些 id 会被直接拼进落盘路径
 * （`smart-chat-session.ts::sessionRelPath` = `${BY_CONFIG_ROOT}${fp}/${chatId}.json`），
 * 而 `path.join` 会把 `../` 归一化掉 —— 一个 `chatId=../../../../../智能对话/config`
 * 就能读到/覆盖/删掉插件自己的 config.json（里面有明文密钥）。
 * QQ 群号/好友号只可能是数字与 `g_`/`p_` 前缀，放行字母数字下划线即可。
 */
const SAFE_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

function isSafeId(raw: unknown): boolean {
    return SAFE_ID_RE.test(String(raw ?? '').trim());
}

function isSafeFingerprint(raw: unknown): boolean {
    return SAFE_ID_RE.test(String(raw ?? '').trim());
}

/** 请求体上限：超限直接判为非法，别把内存交给调用方 */
const MAX_POST_BODY_BYTES = 256 * 1024;

/** 单次批量开关/查询的 id 数量上限（防「一次请求写爆一个 JSON」） */
const MAX_SWITCH_IDS = 500;

/** 忽略尾部斜杠与大小写的端点比较 */
function sameEndpoint(a: unknown, b: unknown): boolean {
    const na = String(a ?? '').trim().replace(/\/+$/, '').toLowerCase();
    const nb = String(b ?? '').trim().replace(/\/+$/, '').toLowerCase();
    return Boolean(na) && na === nb;
}

/**
 * 面板「测试访问 / 拉模型列表」的密钥解析。
 *
 * 安全规则（本函数存在的唯一理由）：
 * **只有调用方给的 base_url 与本地已存的那一个指向同一处时，才允许代入已存密钥。**
 *
 * 原实现是「请求里不带 key 就无条件代入已存 key」，而 base_url 完全来自请求体，
 * 于是 `POST /probe {vendor:'deepseek', base_url:'https://evil.tld'}` 会把明文
 * 密钥写进攻击者的访问日志（Authorization 头，不需要跨域可读就能拿到）。
 */
function resolvePanelApiKey(
    body: Record<string, unknown>,
    cfg: SmartChatConfig,
): { apiKey: string; error?: string } {
    const explicit = String(body.api_key || '').trim();
    if (explicit && !explicit.includes('…')) return { apiKey: explicit };

    const vid = String(body.vendor || '').trim();
    const custom = (cfg.custom_vendors || []).find((c) => c.id === vid);
    let storedKey = '';
    let storedBase = '';
    if (custom?.api_key) {
        storedKey = String(custom.api_key);
        storedBase = String(custom.base_url || '');
    } else if (vid && String(cfg.vendor) === vid && cfg.api_key) {
        storedKey = String(cfg.api_key);
        storedBase = String(cfg.base_url || '');
    }
    if (!storedKey) return { apiKey: '' };

    const askedBase = String(body.base_url || '').trim();
    if (!askedBase || sameEndpoint(askedBase, storedBase)) return { apiKey: storedKey };
    return { apiKey: '', error: 'api_key_required_for_custom_base_url' };
}

async function parsePostBody(req: { body?: unknown; on?: (ev: string, fn: (...args: unknown[]) => void) => void }) {
    let body = req.body;
    if (!body || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) {
        try {
            const raw = await new Promise<string>((resolve, reject) => {
                let data = '';
                let size = 0;
                let settled = false;
                const finish = (fn: () => void) => {
                    if (settled) return;
                    settled = true;
                    fn();
                };
                req.on?.('data', (chunk: Buffer | string) => {
                    const s = typeof chunk === 'string' ? chunk : String(chunk);
                    size += Buffer.byteLength(s);
                    if (size > MAX_POST_BODY_BYTES) {
                        finish(() => reject(new Error('body_too_large')));
                        return;
                    }
                    data += s;
                });
                req.on?.('end', () => finish(() => resolve(data)));
                // 断开的连接不能让这个 Promise 永远挂着（原实现既不回响应也不释放）
                req.on?.('aborted', () => finish(() => reject(new Error('request_aborted'))));
                req.on?.('error', () => finish(() => reject(new Error('request_error'))));
            });
            if (raw) body = JSON.parse(raw);
        } catch {
            body = {};
        }
    }
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function mergeConfigFromBody(
    current: SmartChatConfig,
    body: Record<string, unknown>,
    deps?: SmartChatDeps | null,
): SmartChatConfig {
    const next = { ...current };
    if (body.vendor != null) next.vendor = String(body.vendor);
    if (body.base_url != null) next.base_url = String(body.base_url);
    if (body.balance_url != null) next.balance_url = String(body.balance_url);
    if (body.model != null) next.model = String(body.model); // normalizeSmartChatConfig 按厂商白名单收敛
    if (body.temperature != null) next.temperature = Number(body.temperature);
    if (body.max_tokens != null) next.max_tokens = Number(body.max_tokens);
    if (body.custom_vendors != null && Array.isArray(body.custom_vendors)) {
        const prevMap = new Map((current.custom_vendors || []).map((c) => [c.id, c]));
        const merged = normalizeCustomVendors(body.custom_vendors).map((c) => {
            const old = prevMap.get(c.id);
            // 脱敏占位不覆盖旧 key
            if ((!c.api_key || c.api_key.includes('…')) && old?.api_key) {
                return { ...c, api_key: old.api_key };
            }
            return c;
        });
        // 保留未出现在 body 的旧档案？前端提交完整列表，以 body 为准
        next.custom_vendors = merged;
    }
    if (body.delete_custom_vendor != null) {
        const del = String(body.delete_custom_vendor || '').trim();
        if (isCustomVendorId(del)) {
            next.custom_vendors = (next.custom_vendors || []).filter((c) => c.id !== del);
            if (String(next.vendor) === del) next.vendor = 'deepseek';
        }
    }
    if (body.debounce_ms != null) next.debounce_ms = Number(body.debounce_ms);
    if (body.max_batch != null) next.max_batch = Number(body.max_batch);
    // batch_max_age_ms：缓冲滞留上限；故意不进会话指纹（改它不该切会话/丢记忆）
    if (body.batch_max_age_ms != null) next.batch_max_age_ms = Number(body.batch_max_age_ms);
    // 随机等待计时：同样不进指纹（改等待节奏不该切会话/丢记忆）
    if (body.random_wait_enabled != null) {
        next.random_wait_enabled = body.random_wait_enabled === true || body.random_wait_enabled === 'true';
    }
    if (body.random_wait_min_ms != null) next.random_wait_min_ms = Number(body.random_wait_min_ms);
    if (body.random_wait_max_ms != null) next.random_wait_max_ms = Number(body.random_wait_max_ms);
    // 「没人对你说话」否决概率：同样不进指纹（调沉默力度不该切会话/丢记忆）
    if (body.silence_veto_ratio != null) next.silence_veto_ratio = Number(body.silence_veto_ratio);
    // A① 压缩预算（同样不进指纹：调压缩节奏不该切会话/丢记忆）
    if (body.compact_threshold_ratio != null) next.compact_threshold_ratio = Number(body.compact_threshold_ratio);
    if (body.compact_retain_ratio != null) next.compact_retain_ratio = Number(body.compact_retain_ratio);
    if (body.kb_top_m != null) next.kb_top_m = Number(body.kb_top_m);
    if (body.reply_gap_ms != null) next.reply_gap_ms = Number(body.reply_gap_ms);
    if (body.system_prompt != null) {
        next.system_prompt = toStoredSystemPrompt(String(body.system_prompt), deps);
    }
    if (body.shut_up_limit != null) next.shut_up_limit = Number(body.shut_up_limit);
    if (body.action_min != null) next.action_min = Number(body.action_min);
    if (body.action_max != null) next.action_max = Number(body.action_max);
    if (body.price_prompt_per_million != null) next.price_prompt_per_million = Number(body.price_prompt_per_million);
    if (body.price_completion_per_million != null) next.price_completion_per_million = Number(body.price_completion_per_million);
    if (body.private_chat_enabled != null) {
        next.private_chat_enabled = body.private_chat_enabled === true || body.private_chat_enabled === 'true';
    }
    // tools_enabled 已废弃：忽略请求体，始终保持 false
    next.tools_enabled = false;
    // 自动模型轮替：三项都不进会话指纹（改轮替策略不该切会话/丢记忆）
    if (body.model_rotation_enabled != null) {
        next.model_rotation_enabled = body.model_rotation_enabled === true
            || body.model_rotation_enabled === 'true';
    }
    if (body.model_rotation_mode != null) {
        next.model_rotation_mode = normalizeRotationMode(body.model_rotation_mode);
    }
    if (body.model_rotation_limit != null) next.model_rotation_limit = Number(body.model_rotation_limit);
    // 模型视觉能力开关：开启后识图改由本模型看图，不走 PearAPI
    if (body.model_vision_enabled != null) {
        next.model_vision_enabled = body.model_vision_enabled === true || body.model_vision_enabled === 'true';
    }
    if (body.tools_max_rounds != null) next.tools_max_rounds = Number(body.tools_max_rounds);
    if (body.image_recognize != null && typeof body.image_recognize === 'object') {
        next.image_recognize = {
            ...(next.image_recognize || {}),
            ...(body.image_recognize as SmartChatConfig['image_recognize']),
        };
    }
    if (body.web_search != null && typeof body.web_search === 'object') {
        const ws = { ...(next.web_search || {}) };
        const incoming = body.web_search as Record<string, unknown>;
        const applyKey = (field: string) => {
            if (incoming[field] == null) return;
            const v = String(incoming[field] ?? '').trim();
            if (!v || v.includes('…')) return; // 脱敏占位不覆盖
            ws[field] = v;
        };
        applyKey('tavily_key');
        applyKey('serper_key');
        applyKey('bocha_key');
        applyKey('mcp_endpoint');
        // mcp 开关（免 Key，默认 true；仅在处理 web_search 时生效）
        if (incoming.mcp_enabled !== undefined && incoming.mcp_enabled !== null) {
            ws.mcp_enabled = incoming.mcp_enabled === true || incoming.mcp_enabled === 'true';
        }
        if (incoming.mcp_max_results !== undefined && incoming.mcp_max_results !== null) {
            const mr = Number(incoming.mcp_max_results);
            ws.mcp_max_results = Number.isFinite(mr) ? Math.min(8, Math.max(0, Math.floor(mr))) : 0;
        }
        // 显式清空
        for (const field of ['tavily_key', 'serper_key', 'bocha_key', 'mcp_endpoint'] as const) {
            if (incoming[`clear_${field}`] === true || incoming[`clear_${field}`] === 'true') {
                ws[field] = '';
            }
        }
        next.web_search = ws;
    }
    const newKey = String(body.api_key ?? '').trim();
    if (newKey && !newKey.includes('…')) {
        next.api_key = newKey;
    }
    return normalizeSmartChatConfig(next);
}

/** WebUI 只提交【你是谁】定义句；等于默认时存空串（不落盘）；自定义则把昵称槽写回 {{BOT_NICK}} */
function toStoredSystemPrompt(prompt: string, deps?: SmartChatDeps | null): string {
    let s = extractPersonaLine(String(prompt || ''));
    const nick = deps ? getBotNickname(deps) : BOT_NICK_FALLBACK;
    const resolvedDefault = applyBotNickToSystemPrompt(DEFAULT_PERSONA_LINE, nick);
    const resolvedFallback = applyBotNickToSystemPrompt(DEFAULT_PERSONA_LINE, BOT_NICK_FALLBACK);
    if (
        !s
        || s === resolvedDefault
        || s === resolvedFallback
        || s === DEFAULT_PERSONA_LINE
        || s === DEFAULT_SYSTEM_PROMPT
    ) {
        return '';
    }
    if (nick && nick !== BOT_NICK_FALLBACK) {
        s = s.split(`老成员「${nick}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
        s = s.split(`群友「${nick}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
        s = s.split(`熟人「${nick}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
        s = s.split(`名字就叫 ${nick}`).join(`名字就叫 ${BOT_NICK_PLACEHOLDER}`);
        s = s.split(`「${nick}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
    }
    s = s.split(`老成员「${BOT_NICK_FALLBACK}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
    s = s.split(`群友「${BOT_NICK_FALLBACK}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
    s = s.split(`熟人「${BOT_NICK_FALLBACK}」`).join(`「${BOT_NICK_PLACEHOLDER}」`);
    s = s.replace(/老成员「([^」]+)」/g, '「$1」');
    const shaped = clampPersonaText(
        s.replace(/你是群里的「[^」]+」/u, '你是群里的「{{BOT_NICK}}」'),
    );
    if (!shaped || shaped === DEFAULT_PERSONA_LINE) return '';
    return shaped;
}

export function registerSmartChatWebGetRoutes(
    base: { get: (path: string, handler: (...args: unknown[]) => unknown) => void },
    wrapPath: (p: string) => string,
    deps: SmartChatDeps,
    logger?: { error?: (...args: unknown[]) => void },
) {
    bindNvidiaRateDeps(deps);
    bindRotationDeps(deps);
    base.get(wrapPath('/smart-chat/config'), async (_req, res) => {
        try {
            await ensureBotIdentity(deps);
            const cfg = loadSmartChatConfig(deps);
            const web = configForWeb(cfg, deps);
            // 展示层替换昵称；磁盘仍可保留 {{BOT_NICK}}
            web.system_prompt = applyBotNickToSystemPrompt(cfg.system_prompt, getBotNickname(deps));
            res.json({ code: 0, data: web });
        } catch (e) {
            logger?.error?.('获取智能对话配置失败:', e);
            res.status(500).json({ code: -1, message: '获取智能对话配置失败' });
        }
    });

    base.get(wrapPath('/smart-chat/usage'), (_req, res) => {
        try {
            res.json({ code: 0, data: getUsageSummary(deps) });
        } catch (e) {
            logger?.error?.('获取智能对话用量失败:', e);
            res.status(500).json({ code: -1, message: '获取智能对话用量失败' });
        }
    });

    base.get(wrapPath('/smart-chat/balance'), async (req, res) => {
        try {
            const force = readForceFlag(req);
            const cfg = loadSmartChatConfig(deps);
            // fetchBalance 内部已对 force 做「清缓存」处理；此处显式带上 force，
            // 保证「用户主动刷新」不会搭车到别人正在飞的普通请求上（反之亦然）。
            const data = await fetchBalance(cfg, force, deps);
            try {
                res.setHeader?.('Cache-Control', 'no-store, no-cache, must-revalidate');
            } catch {
                /* ignore */
            }
            res.json({ code: 0, data: { ...data, forced: force } });
        } catch (e) {
            logger?.error?.('获取智能对话余额失败:', e);
            res.status(500).json({ code: -1, message: '获取智能对话余额失败' });
        }
    });

    base.get(wrapPath('/smart-chat/knowledge'), (req, res) => {
        try {
            const scopes = listKnowledgeScopes(deps);
            let scope = String(req?.query?.scope || '').trim();
            if (!scope || scope === 'global' || !scopes.includes(scope)) {
                scope = scopes[0] || '';
            }
            // 文本技能栏：只列本群自定义；宿主技已进 system，不占此列表
            const entries = scope
                ? listKnowledge(deps, scope)
                    .filter((e) => !isBuiltinSkillId(e.id))
                    .map((e) => ({ ...e, builtin: false }))
                : [];
            res.json({ code: 0, data: { scope, entries, scopes } });
        } catch (e) {
            logger?.error?.('获取技能树失败:', e);
            res.status(500).json({ code: -1, message: '获取技能树失败' });
        }
    });

    base.get(wrapPath('/smart-chat/tool-skills'), (_req, res) => {
        try {
            res.json({ code: 0, data: { tools: listMkApiToolSkillRows(deps) } });
        } catch (e) {
            logger?.error?.('获取工具技能失败:', e);
            res.status(500).json({ code: -1, message: '获取工具技能失败' });
        }
    });

    base.post(wrapPath('/smart-chat/tool-skills/toggle'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const code = String(body.code || '').trim();
            if (!code) {
                res.status(400).json({ code: -1, message: 'missing_code' });
                return;
            }
            const enabled = body.enabled !== false && body.enabled !== 'false' && body.enabled !== 0 && body.enabled !== '0';
            if (!setMkApiToolEnabled(deps, code, enabled)) {
                res.status(404).json({ code: -1, message: 'not_found' });
                return;
            }
            res.json({ code: 0, data: { code, enabled } });
        } catch (e) {
            logger?.error?.('切换工具技能失败:', e);
            res.status(500).json({ code: -1, message: '切换工具技能失败' });
        }
    });

    base.get(wrapPath('/smart-chat/sessions'), (req, res) => {
        try {
            const cfg = loadSmartChatConfig(deps);
            const ns = getActiveSessionNamespace(deps, cfg);
            const namespaces = listSessionNamespaces(deps);
            let list = listAllSessionRows(deps, cfg);
            const includeEmpty = String(req?.query?.includeEmpty || '') === '1'
                || String(req?.query?.include_empty || '') === '1';
            if (!includeEmpty) {
                list = list.filter((r) => sessionRowHasContent(r));
            }
            res.json({
                code: 0,
                data: {
                    list,
                    namespace: {
                        fingerprint: ns.fingerprint,
                        preview: ns.preview,
                        profiles: namespaces.profiles,
                        profile_count: namespaces.profiles.length,
                    },
                },
            });
        } catch (e) {
            logger?.error?.('获取会话列表失败:', e);
            res.status(500).json({ code: -1, message: '获取会话列表失败' });
        }
    });

    base.post(wrapPath('/smart-chat/sessions/prune'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const removeEmptyNamespaces = Boolean(body?.removeEmptyNamespaces);
            const result = pruneEmptySessions(deps, { removeEmptyNamespaces });
            res.json({ code: 0, data: result });
        } catch (e) {
            logger?.error?.('清理空会话失败:', e);
            res.status(500).json({ code: -1, message: '清理空会话失败' });
        }
    });

    base.get(wrapPath('/smart-chat/session'), (req, res) => {
        try {
            const chatId = String(req?.query?.chatId || '').trim();
            if (!chatId) {
                res.status(400).json({ code: -1, message: 'missing_chatId' });
                return;
            }
            if (!isSafeId(chatId)) {
                logger?.error?.(`[智能对话] 拒绝非法 chatId: ${chatId.slice(0, 80)}`);
                res.status(400).json({ code: -1, message: 'invalid_chatId' });
                return;
            }
            const fingerprint = String(req?.query?.fingerprint || '').trim();
            if (fingerprint && !isSafeFingerprint(fingerprint)) {
                logger?.error?.(`[智能对话] 拒绝非法 fingerprint: ${fingerprint.slice(0, 80)}`);
                res.status(400).json({ code: -1, message: 'invalid_fingerprint' });
                return;
            }
            const session = fingerprint
                ? loadSessionAtFingerprint(deps, chatId, fingerprint)
                : loadSession(deps, chatId, loadConfigForChat(deps, chatId));
            const buffer = fingerprint ? [] : loadChatBuffer(deps, chatId);
            res.json({
                code: 0,
                data: { chatId, fingerprint: fingerprint || undefined, session, bufferPending: buffer.length },
            });
        } catch (e) {
            logger?.error?.('获取会话详情失败:', e);
            res.status(500).json({ code: -1, message: '获取会话详情失败' });
        }
    });

    base.get(wrapPath('/smart-chat/web-search/status'), (_req, res) => {
        try {
            const cfg = loadSmartChatConfig(deps);
            const configured = listConfiguredProviders(cfg.web_search);
            const providers = (Object.keys(WEB_SEARCH_PROVIDER_META) as WebSearchProviderId[]).map((id) => ({
                id,
                ...WEB_SEARCH_PROVIDER_META[id],
                configured: configured.includes(id),
            }));
            res.json({
                code: 0,
                data: {
                    tools_max_rounds: cfg.tools_max_rounds,
                    web_search_ready: configured.length > 0,
                    configured,
                    providers,
                    note: '联网开关已迁至「聊天开关」分群/好友管理',
                },
            });
        } catch (e) {
            logger?.error?.('获取联网搜索状态失败:', e);
            res.status(500).json({ code: -1, message: '获取联网搜索状态失败' });
        }
    });

    base.get(wrapPath('/smart-chat/blacklist'), (req, res) => {
        try {
            const type = String(req?.query?.type || 'group') === 'user' ? 'user' : 'group';
            const ids = loadBlacklistIds(deps, type as BlacklistKind);
            res.json({ code: 0, data: { type, ids } });
        } catch (e) {
            logger?.error?.('获取黑户列表失败:', e);
            res.status(500).json({ code: -1, message: '获取黑户列表失败' });
        }
    });

    base.get(wrapPath('/smart-chat/switches'), (req, res) => {
        try {
            const type = String(req?.query?.type || 'group') === 'friend' ? 'friend' : 'group';
            const idsRaw = String(req?.query?.ids || '').trim();
            const ids = idsRaw
                ? idsRaw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_SWITCH_IDS)
                : Object.keys(listSmartChatSwitchMap(deps, type));
            const cfg = loadSmartChatConfig(deps);
            const nick = getBotNickname(deps);
            const globalLine = String(cfg.system_prompt || '').trim() || DEFAULT_PERSONA_LINE;
            const globalDisplay = applyBotNickToSystemPrompt(globalLine, nick);
            const map: Record<string, {
                enabled: boolean;
                ai_only: boolean;
                rounds: number;
                image_recognize: boolean;
                file_recognize: boolean;
                sticker_output: boolean;
                web_search: boolean;
                at_only: boolean;
                at_only_record: boolean;
                fake_think: boolean;
                allow_voice: boolean;
                system_prompt: string;
            }> = {};
            for (const id of ids) {
                const override = getSmartChatPersonaOverride(deps, type, id);
                if (type === 'group') {
                    map[id] = {
                        enabled: isSmartChatGroupEnabled(deps, id),
                        ai_only: isSmartChatAiOnlyGroup(deps, id),
                        rounds: getSmartChatGroupRounds(deps, id),
                        image_recognize: isSmartChatImageGroup(deps, id),
                        file_recognize: isSmartChatFileGroup(deps, id),
                        sticker_output: isSmartChatStickerGroup(deps, id),
                        web_search: isSmartChatToolsGroup(deps, id),
                        at_only: isSmartChatAtOnlyGroup(deps, id),
                        at_only_record: isSmartChatAtOnlyRecordGroup(deps, id),
                        fake_think: isSmartChatFakeThinkGroup(deps, id),
                        allow_voice: isSmartChatAllowVoiceGroup(deps, id),
                        system_prompt: override
                            ? applyBotNickToSystemPrompt(override, nick)
                            : '',
                    };
                } else {
                    map[id] = {
                        enabled: isSmartChatFriendEnabled(deps, id),
                        ai_only: isSmartChatAiOnlyFriend(deps, id),
                        rounds: getSmartChatFriendRounds(deps, id),
                        image_recognize: isSmartChatImageFriend(deps, id),
                        // 识别文件仅群聊
                        file_recognize: false,
                        sticker_output: isSmartChatStickerFriend(deps, id),
                        web_search: isSmartChatToolsFriend(deps, id),
                        at_only: isSmartChatAtOnlyFriend(deps, id),
                        at_only_record: isSmartChatAtOnlyRecordFriend(deps, id),
                        fake_think: isSmartChatFakeThinkFriend(deps, id),
                        allow_voice: isSmartChatAllowVoiceFriend(deps, id),
                        system_prompt: override
                            ? applyBotNickToSystemPrompt(override, nick)
                            : '',
                    };
                }
            }
            res.json({
                code: 0,
                data: {
                    type,
                    map,
                    global_system_prompt: globalDisplay,
                    sticker_gallery_ready: isAnyStickerGalleryReady(deps),
                },
            });
        } catch (e) {
            logger?.error?.('获取智能对话开关失败:', e);
            res.status(500).json({ code: -1, message: '获取智能对话开关失败' });
        }
    });

    base.get(wrapPath('/smart-chat/sticker/galleries'), (_req, res) => {
        try {
            res.json({ code: 0, data: listStickerGalleriesStatus(deps) });
        } catch (e) {
            logger?.error?.('获取表情图库失败:', e);
            res.status(500).json({ code: -1, message: '获取表情图库失败' });
        }
    });

    // 语音角色列表：代理 pearapi type=list（用配置里的自有密钥或内置体验密钥）
    base.get(wrapPath('/smart-chat/voice-roles'), async (_req, res) => {
        try {
            const cfg = loadSmartChatConfig(deps);
            const r = await fetchVoiceRoles(cfg);
            res.json({
                code: 0,
                data: {
                    ok: r.ok,
                    roles: r.roles,
                    error: r.error || '',
                    using_own_key: r.using_own_key,
                },
            });
        } catch (e) {
            logger?.error?.('获取语音角色失败:', e);
            res.status(500).json({ code: -1, message: '获取语音角色失败' });
        }
    });

    // QQ 自带 AI 语音角色列表：需要一个参考群号（get_ai_characters 是群作用域），
    // 通过宿主 botApi 代理 NapCat 动作；返回扁平化的角色列表。
    base.get(wrapPath('/smart-chat/voice-characters'), async (req, res) => {
        try {
            const gid = String(req?.query?.group_id || req?.query?.groupId || '').trim();
            const r = await fetchQQVoiceCharacters(deps, gid);
            res.json({
                code: 0,
                data: {
                    ok: r.ok,
                    characters: r.characters,
                    error: r.error || '',
                },
            });
        } catch (e) {
            logger?.error?.('获取QQ AI语音角色失败:', e);
            res.status(500).json({ code: -1, message: '获取QQ AI语音角色失败' });
        }
    });

    base.get(wrapPath('/smart-chat/sticker/install/progress'), (req, res) => {
        try {
            const jobId = String(req?.query?.jobId || '').trim();
            const galleryId = String(req?.query?.galleryId || '').trim();
            let p = jobId ? getStickerInstallProgress(jobId) : null;
            // 刷新/重进页面后前端可能只记得 galleryId；服务端任务仍在跑
            if (!p && galleryId) p = getActiveStickerInstallByGallery(galleryId);
            if (!p && !jobId && !galleryId) {
                res.status(400).json({ code: -1, message: 'jobId_or_galleryId_required' });
                return;
            }
            if (!p) {
                res.status(404).json({ code: -1, message: 'job_not_found' });
                return;
            }
            res.json({ code: 0, data: p });
        } catch (e) {
            logger?.error?.('获取表情图库安装进度失败:', e);
            res.status(500).json({ code: -1, message: '获取表情图库安装进度失败' });
        }
    });
}

export function registerSmartChatWebPostRoutes(
    base: { post: (path: string, handler: (...args: unknown[]) => unknown) => void },
    wrapPath: (p: string) => string,
    deps: SmartChatDeps,
    logger?: { error?: (...args: unknown[]) => void },
) {
    bindNvidiaRateDeps(deps);
    bindRotationDeps(deps);
    base.post(wrapPath('/smart-chat/config'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const current = loadSmartChatConfig(deps);
            const merged = mergeConfigFromBody(current, body, deps);
            // 端点校验：只允许 http(s)；且「换主机」必须显式重填 api_key，
            // 否则一次 POST 就能让下一次请求把已存密钥发到别处（见 endpointChangeNeedsKey 注释）
            if (!isHttpEndpoint(merged.base_url) || !isHttpEndpoint(merged.balance_url)) {
                res.status(400).json({ code: -1, message: 'invalid_endpoint_scheme' });
                return;
            }
            const keyInput = String(body.api_key ?? '').trim();
            // 逐档案收集「本次真的新填了密钥」的厂商 id：
            // 只用一个布尔会被「随便填一个无关档案的 key」蒙过去
            const customKeyFresh = new Set<string>();
            for (const row of Array.isArray(body.custom_vendors) ? body.custom_vendors : []) {
                const o = row as Record<string, unknown>;
                const id = String(o?.id ?? '').trim();
                const k = String(o?.api_key ?? '').trim();
                if (id && k && !k.includes('…')) customKeyFresh.add(id);
            }
            const endpointError = endpointChangeNeedsKey(current, merged, {
                topKeyFresh: Boolean(keyInput) && !keyInput.includes('…'),
                customKeyFresh,
            });
            if (endpointError) {
                logger?.error?.(`[智能对话] /config 拒绝端点变更：${endpointError}`);
                res.status(400).json({ code: -1, message: endpointError });
                return;
            }
            const saveMeta = saveSmartChatConfig(deps, merged);
            await ensureBotIdentity(deps);
            const web = configForWeb(merged, deps);
            web.system_prompt = applyBotNickToSystemPrompt(merged.system_prompt, getBotNickname(deps));
            res.json({
                code: 0,
                data: {
                    ...web,
                    fingerprint_changed: saveMeta.fingerprintChanged,
                    previous_fingerprint: saveMeta.previousFingerprint,
                },
            });
        } catch (e) {
            logger?.error?.('保存智能对话配置失败:', e);
            res.status(500).json({ code: -1, message: '保存智能对话配置失败' });
        }
    });

    base.post(wrapPath('/smart-chat/test'), async (_req, res) => {
        try {
            const cfg = loadSmartChatConfig(deps);
            // 「连通性测试」升级为真实模拟访问：用当前配置发一句「你好」，返回模型输出
            const r = await simulateChatAccess(cfg, deps);
            res.json({ code: r.ok ? 0 : -1, data: r, message: r.error || '' });
        } catch (e) {
            logger?.error?.('智能对话连通性测试失败:', e);
            res.status(500).json({ code: -1, message: '智能对话连通性测试失败' });
        }
    });

    /** 自定义厂商测试访问：不读插件 system，只发「你好」 */
    base.post(wrapPath('/smart-chat/probe'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const cfg = loadSmartChatConfig(deps);
            const resolvedKey = resolvePanelApiKey(body, cfg);
            if (resolvedKey.error) {
                logger?.error?.('[智能对话] /probe 拒绝：base_url 与已存端点不同，需显式提供 api_key');
                res.status(400).json({ code: -1, message: resolvedKey.error });
                return;
            }
            const apiKey = resolvedKey.apiKey;
            const r = await probeChatAccess({
                api_key: apiKey,
                base_url: String(body.base_url || ''),
                model: String(body.model || ''),
                chat_path: body.chat_path != null ? String(body.chat_path) : undefined,
                max_tokens: body.max_tokens != null ? Number(body.max_tokens) : undefined,
                temperature: body.temperature != null ? Number(body.temperature) : undefined,
                api_protocol: body.api_protocol != null ? String(body.api_protocol) : undefined,
                vendor: body.vendor != null ? String(body.vendor) : undefined,
                custom_vendors: cfg.custom_vendors,
            });
            res.json({ code: r.ok ? 0 : -1, data: r, message: r.error || '' });
        } catch (e) {
            logger?.error?.('智能对话测试访问失败:', e);
            res.status(500).json({ code: -1, message: '智能对话测试访问失败' });
        }
    });

    base.post(wrapPath('/smart-chat/models'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const cfg = loadSmartChatConfig(deps);
            const resolvedKey = resolvePanelApiKey(body, cfg);
            if (resolvedKey.error) {
                logger?.error?.('[智能对话] /models 拒绝：base_url 与已存端点不同，需显式提供 api_key');
                res.status(400).json({ code: -1, message: resolvedKey.error });
                return;
            }
            const apiKey = resolvedKey.apiKey;
            const r = await fetchModelList({
                api_key: apiKey,
                base_url: String(body.base_url || ''),
                api_protocol: body.api_protocol != null ? String(body.api_protocol) : undefined,
                chat_path: body.chat_path != null ? String(body.chat_path) : undefined,
            });
            res.json({ code: r.ok ? 0 : -1, data: r, message: r.error || '' });
        } catch (e) {
            logger?.error?.('拉取模型列表失败:', e);
            res.status(500).json({ code: -1, message: '拉取模型列表失败' });
        }
    });

    // 保存语音输出全局设置（密钥/角色/格式/限长）；返回掩码后的 voice 供前端回显
    base.post(wrapPath('/smart-chat/voice-config'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const current = loadSmartChatConfig(deps);
            const incoming = body && typeof body.voice === 'object' && body.voice
                ? body.voice as Record<string, unknown>
                : (body as Record<string, unknown>);
            const nextVoice: Record<string, unknown> = { ...(current.voice || {}) };
            if (incoming.engine != null) nextVoice.engine = String(incoming.engine);
            if (incoming.dub != null) nextVoice.dub = String(incoming.dub);
            if (incoming.format != null) nextVoice.format = String(incoming.format);
            if (incoming.qq_character != null) nextVoice.qq_character = String(incoming.qq_character);
            if (incoming.qq_ref_group != null) nextVoice.qq_ref_group = String(incoming.qq_ref_group);
            if (incoming.max_chars != null) nextVoice.max_chars = Number(incoming.max_chars);
            // api_key：空串=清空改回内置密钥；掩码串（含 … / *）视为「未改动」不覆盖
            if (incoming.api_key != null) {
                const k = String(incoming.api_key).trim();
                const masked = /[…*]/.test(k);
                if (!masked) nextVoice.api_key = k;
            }
            const merged = normalizeSmartChatConfig({ ...current, voice: nextVoice });
            saveSmartChatConfig(deps, merged);
            const web = configForWeb(merged, deps);
            res.json({ code: 0, data: { ok: true, voice: web.voice } });
        } catch (e) {
            logger?.error?.('保存语音配置失败:', e);
            res.status(500).json({ code: -1, message: '保存语音配置失败' });
        }
    });

    base.post(wrapPath('/smart-chat/knowledge/upsert'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const scope = String(body.scope || '').trim();
            if (!scope || scope === 'global' || !/^\d{5,12}$/.test(scope)) {
                res.status(400).json({ code: -1, message: 'scope_must_be_group_id' });
                return;
            }
            const title = String(body.title || '').trim();
            const content = String(body.content || '').trim();
            if (!title || !content) {
                res.status(400).json({ code: -1, message: 'title_and_content_required' });
                return;
            }
            const entry = upsertKnowledge(deps, scope, {
                id: body.id ? String(body.id) : undefined,
                title,
                content,
                tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
                enabled: body.enabled !== undefined ? body.enabled !== false && body.enabled !== 'false' : undefined,
            });
            res.json({ code: 0, data: entry });
        } catch (e) {
            logger?.error?.('保存技能失败:', e);
            res.status(500).json({ code: -1, message: '保存技能失败' });
        }
    });

    base.post(wrapPath('/smart-chat/knowledge/toggle'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const scope = String(body.scope || '').trim();
            if (!scope || scope === 'global' || !/^\d{5,12}$/.test(scope)) {
                res.status(400).json({ code: -1, message: 'scope_must_be_group_id' });
                return;
            }
            const id = String(body.id || '').trim();
            if (!id) {
                res.status(400).json({ code: -1, message: 'missing_id' });
                return;
            }
            const enabled = body.enabled !== false && body.enabled !== 'false' && body.enabled !== 0 && body.enabled !== '0';
            const entry = setKnowledgeEnabled(deps, scope, id, enabled);
            if (!entry) {
                res.status(404).json({ code: -1, message: 'not_found' });
                return;
            }
            res.json({ code: 0, data: entry });
        } catch (e) {
            logger?.error?.('切换技能开关失败:', e);
            res.status(500).json({ code: -1, message: '切换技能开关失败' });
        }
    });

    base.post(wrapPath('/smart-chat/knowledge/delete'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const scope = String(body.scope || '').trim();
            if (!scope || scope === 'global' || !/^\d{5,12}$/.test(scope)) {
                res.status(400).json({ code: -1, message: 'scope_must_be_group_id' });
                return;
            }
            const id = String(body.id || '').trim();
            if (!id) {
                res.status(400).json({ code: -1, message: 'missing_id' });
                return;
            }
            const ok = deleteKnowledge(deps, scope, id);
            res.json({ code: ok ? 0 : -1, message: ok ? 'ok' : 'not_found' });
        } catch (e) {
            logger?.error?.('删除技能失败:', e);
            res.status(500).json({ code: -1, message: '删除技能失败' });
        }
    });

    base.post(wrapPath('/smart-chat/session/clear'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const chatId = String(body.chatId || '').trim();
            if (!chatId) {
                res.status(400).json({ code: -1, message: 'missing_chatId' });
                return;
            }
            if (!isSafeId(chatId)) {
                logger?.error?.(`[智能对话] 拒绝非法 chatId(clear): ${chatId.slice(0, 80)}`);
                res.status(400).json({ code: -1, message: 'invalid_chatId' });
                return;
            }
            const fingerprint = String(body.fingerprint || '').trim();
            if (fingerprint && !isSafeFingerprint(fingerprint)) {
                logger?.error?.(`[智能对话] 拒绝非法 fingerprint(clear): ${fingerprint.slice(0, 80)}`);
                res.status(400).json({ code: -1, message: 'invalid_fingerprint' });
                return;
            }
            if (fingerprint) {
                clearSessionAtFingerprint(deps, chatId, fingerprint);
                const ns = getActiveSessionNamespace(deps);
                if (fingerprint === ns.fingerprint) clearChatBuffer(deps, chatId);
            } else {
                clearSession(deps, chatId, loadConfigForChat(deps, chatId));
                clearChatBuffer(deps, chatId);
            }
            res.json({ code: 0, message: 'ok' });
        } catch (e) {
            logger?.error?.('清空会话失败:', e);
            res.status(500).json({ code: -1, message: '清空会话失败' });
        }
    });

    base.post(wrapPath('/smart-chat/session/clear-others'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const chatId = String(body.chatId || '').trim();
            if (!chatId) {
                res.status(400).json({ code: -1, message: 'missing_chatId' });
                return;
            }
            if (!isSafeId(chatId)) {
                logger?.error?.(`[智能对话] 拒绝非法 chatId(clear-others): ${chatId.slice(0, 80)}`);
                res.status(400).json({ code: -1, message: 'invalid_chatId' });
                return;
            }
            const keep = String(body.keepFingerprint || body.fingerprint || '').trim();
            if (keep && !isSafeFingerprint(keep)) {
                logger?.error?.(`[智能对话] 拒绝非法 keepFingerprint: ${keep.slice(0, 80)}`);
                res.status(400).json({ code: -1, message: 'invalid_fingerprint' });
                return;
            }
            const r = purgeOtherSessionData(deps, chatId, keep);
            res.json({ code: 0, data: r, message: 'ok' });
        } catch (e) {
            logger?.error?.('删除其他会话数据失败:', e);
            res.status(500).json({ code: -1, message: '删除其他会话数据失败' });
        }
    });

    base.post(wrapPath('/smart-chat/usage/clear'), async (_req, res) => {
        try {
            clearUsageLedger(deps);
            res.json({ code: 0, message: 'ok' });
        } catch (e) {
            logger?.error?.('清空用量账本失败:', e);
            res.status(500).json({ code: -1, message: '清空用量账本失败' });
        }
    });

    base.post(wrapPath('/smart-chat/web-search/test'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const provider = String(body.provider || '').trim() as WebSearchProviderId;
            if (!['tavily', 'serper', 'bocha', 'mcp'].includes(provider)) {
                res.status(400).json({ code: -1, message: 'invalid_provider' });
                return;
            }
            const cfg = loadSmartChatConfig(deps);
            const r = await testWebSearchProvider(cfg, provider);
            res.json({
                code: r.ok ? 0 : -1,
                data: {
                    provider: r.provider,
                    ok: r.ok,
                    error: r.error || null,
                    hit_count: r.hits?.length || 0,
                    may_consume_quota: Boolean(r.mayConsumeQuota ?? r.meta?.testMayConsume),
                    meta: r.meta,
                    sample: r.hits?.[0] || null,
                },
                message: r.ok ? 'ok' : (r.error || 'test_failed'),
            });
        } catch (e) {
            logger?.error?.('联网搜索密钥测试失败:', e);
            res.status(500).json({ code: -1, message: '联网搜索密钥测试失败' });
        }
    });

    const setSmartChatSwitchHandler = async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const type = String(body.type || 'group') === 'friend' ? 'friend' : 'group';
            const id = String(body.id || '').trim();
            if (!id) {
                res.status(400).json({ code: -1, message: 'id_required' });
                return;
            }
            const cfg = loadSmartChatConfig(deps);
            const fpBefore = sessionConfigFingerprint(
                configWithEffectivePersona(cfg, resolveEffectivePersonaLine(deps, type, id, cfg)),
            );
            if (body.enabled != null) {
                const on = body.enabled === true || body.enabled === 'true' || body.enabled === '开启' || body.enabled === 1;
                if (type === 'group') setSmartChatGroupEnabled(deps, id, on);
                else setSmartChatFriendEnabled(deps, id, on);
            }
            if (body.ai_only != null) {
                const on = body.ai_only === true || body.ai_only === 'true' || body.ai_only === '开启' || body.ai_only === 1;
                if (type === 'group') setSmartChatAiOnlyGroup(deps, id, on);
                else setSmartChatAiOnlyFriend(deps, id, on);
            }
            if (body.rounds != null) {
                const rounds = normalizeSmartChatRounds(body.rounds);
                if (type === 'group') setSmartChatGroupRounds(deps, id, rounds);
                else setSmartChatFriendRounds(deps, id, rounds);
            }
            if (body.image_recognize != null) {
                const on = body.image_recognize === true
                    || body.image_recognize === 'true'
                    || body.image_recognize === '开启'
                    || body.image_recognize === 1;
                if (type === 'group') setSmartChatImageGroup(deps, id, on);
                else setSmartChatImageFriend(deps, id, on);
            }
            // 识别文件：仅群聊落盘，私聊直接忽略
            if (body.file_recognize != null && type === 'group') {
                const on = body.file_recognize === true
                    || body.file_recognize === 'true'
                    || body.file_recognize === '开启'
                    || body.file_recognize === 1;
                setSmartChatFileGroup(deps, id, on);
            }
            let sticker_rejected = false;
            if (body.sticker_output != null) {
                const on = body.sticker_output === true
                    || body.sticker_output === 'true'
                    || body.sticker_output === '开启'
                    || body.sticker_output === 1;
                const ok = type === 'group'
                    ? setSmartChatStickerGroup(deps, id, on)
                    : setSmartChatStickerFriend(deps, id, on);
                if (on && !ok) sticker_rejected = true;
            }
            if (body.web_search != null) {
                const on = body.web_search === true
                    || body.web_search === 'true'
                    || body.web_search === '开启'
                    || body.web_search === 1;
                if (type === 'group') setSmartChatToolsGroup(deps, id, on);
                else setSmartChatToolsFriend(deps, id, on);
            }
            if (body.at_only != null) {
                const on = body.at_only === true
                    || body.at_only === 'true'
                    || body.at_only === '开启'
                    || body.at_only === 1;
                if (type === 'group') setSmartChatAtOnlyGroup(deps, id, on);
                else setSmartChatAtOnlyFriend(deps, id, on);
            }
            if (body.at_only_record != null) {
                const on = body.at_only_record === true
                    || body.at_only_record === 'true'
                    || body.at_only_record === '开启'
                    || body.at_only_record === 1;
                if (type === 'group') setSmartChatAtOnlyRecordGroup(deps, id, on);
                else setSmartChatAtOnlyRecordFriend(deps, id, on);
            }
            if (body.fake_think != null) {
                const on = body.fake_think === true
                    || body.fake_think === 'true'
                    || body.fake_think === '开启'
                    || body.fake_think === 1;
                if (type === 'group') setSmartChatFakeThinkGroup(deps, id, on);
                else setSmartChatFakeThinkFriend(deps, id, on);
            }
            if (body.allow_voice != null) {
                const on = body.allow_voice === true
                    || body.allow_voice === 'true'
                    || body.allow_voice === '开启'
                    || body.allow_voice === 1;
                if (type === 'group') setSmartChatAllowVoiceGroup(deps, id, on);
                else setSmartChatAllowVoiceFriend(deps, id, on);
            }
            if (body.system_prompt != null) {
                const raw = String(body.system_prompt ?? '');
                if (!raw.trim()) {
                    setSmartChatPersonaOverride(deps, type, id, '');
                } else {
                    const stored = toStoredSystemPrompt(raw, deps);
                    const globalLine = String(cfg.system_prompt || '').trim() || DEFAULT_PERSONA_LINE;
                    // 空/等于全局有效人设 → 跟随全局（不写独立人设）
                    if (!stored || stored === globalLine) {
                        setSmartChatPersonaOverride(deps, type, id, '');
                    } else {
                        setSmartChatPersonaOverride(deps, type, id, stored);
                    }
                }
            }
            const enabled = type === 'group'
                ? isSmartChatGroupEnabled(deps, id)
                : isSmartChatFriendEnabled(deps, id);
            const ai_only = type === 'group'
                ? isSmartChatAiOnlyGroup(deps, id)
                : isSmartChatAiOnlyFriend(deps, id);
            const rounds = type === 'group'
                ? getSmartChatGroupRounds(deps, id)
                : getSmartChatFriendRounds(deps, id);
            const image_recognize = type === 'group'
                ? isSmartChatImageGroup(deps, id)
                : isSmartChatImageFriend(deps, id);
            const file_recognize = type === 'group' ? isSmartChatFileGroup(deps, id) : false;
            const sticker_output = type === 'group'
                ? isSmartChatStickerGroup(deps, id)
                : isSmartChatStickerFriend(deps, id);
            const web_search = type === 'group'
                ? isSmartChatToolsGroup(deps, id)
                : isSmartChatToolsFriend(deps, id);
            const at_only = type === 'group'
                ? isSmartChatAtOnlyGroup(deps, id)
                : isSmartChatAtOnlyFriend(deps, id);
            const at_only_record = type === 'group'
                ? isSmartChatAtOnlyRecordGroup(deps, id)
                : isSmartChatAtOnlyRecordFriend(deps, id);
            const fake_think = type === 'group'
                ? isSmartChatFakeThinkGroup(deps, id)
                : isSmartChatFakeThinkFriend(deps, id);
            const allow_voice = type === 'group'
                ? isSmartChatAllowVoiceGroup(deps, id)
                : isSmartChatAllowVoiceFriend(deps, id);
            const override = getSmartChatPersonaOverride(deps, type, id);
            const nick = getBotNickname(deps);
            const fpAfter = sessionConfigFingerprint(
                configWithEffectivePersona(cfg, resolveEffectivePersonaLine(deps, type, id, cfg)),
            );
            res.json({
                code: sticker_rejected ? -1 : 0,
                data: {
                    type,
                    id,
                    enabled,
                    ai_only,
                    rounds,
                    image_recognize,
                    file_recognize,
                    sticker_output,
                    web_search,
                    at_only,
                    at_only_record,
                    fake_think,
                    allow_voice,
                    system_prompt: override
                        ? applyBotNickToSystemPrompt(override, nick)
                        : '',
                    global_system_prompt: applyBotNickToSystemPrompt(
                        String(cfg.system_prompt || '').trim() || DEFAULT_PERSONA_LINE,
                        nick,
                    ),
                    persona_fingerprint_changed: fpBefore !== fpAfter,
                    sticker_gallery_ready: isAnyStickerGalleryReady(deps),
                },
                message: sticker_rejected ? '本机表情图库不可用，无法开启表情输出' : 'ok',
            });
        } catch (e) {
            logger?.error?.('保存智能对话开关失败:', e);
            res.status(500).json({ code: -1, message: '保存智能对话开关失败' });
        }
    };
    // 兼容：前端可能打 /switches 或 /switches/set
    base.post(wrapPath('/smart-chat/switches/set'), setSmartChatSwitchHandler);
    base.post(wrapPath('/smart-chat/switches'), setSmartChatSwitchHandler);

    base.post(wrapPath('/smart-chat/sticker/install'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const galleryId = String(body.id || body.galleryId || 'feibi').trim();
            // 安装源：缺省 kakake（与历史行为一致）；非法值由后端兜底成默认源
            const source = body.source || body.mode || body.from;
            const progress = await startStickerGalleryInstall(deps, galleryId, source);
            res.json({ code: 0, data: progress });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger?.error?.('安装表情图库失败:', e);
            res.status(400).json({ code: -1, message: msg || '安装表情图库失败' });
        }
    });

    base.post(wrapPath('/smart-chat/sticker/refresh-skill'), async (_req, res) => {
        try {
            ensureBuiltinKnowledge(deps);
            res.json({
                code: 0,
                data: listStickerGalleriesStatus(deps),
                message: 'ok',
            });
        } catch (e) {
            logger?.error?.('刷新表情技能失败:', e);
            res.status(500).json({ code: -1, message: '刷新表情技能失败' });
        }
    });

    base.post(wrapPath('/smart-chat/switches/bulk'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const type = String(body.type || 'group') === 'friend' ? 'friend' : 'group';
            const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === '开启' || body.enabled === 1;
            const ids = Array.isArray(body.ids)
                ? body.ids.map(String).map((s) => s.trim()).filter(Boolean).slice(0, MAX_SWITCH_IDS)
                : [];
            const n = bulkSetSmartChatEnabled(deps, type, ids, enabled);
            res.json({ code: 0, data: { type, enabled, count: n } });
        } catch (e) {
            logger?.error?.('批量保存智能对话开关失败:', e);
            res.status(500).json({ code: -1, message: '批量保存智能对话开关失败' });
        }
    });

    base.post(wrapPath('/smart-chat/blacklist'), async (req, res) => {
        try {
            const body = await parsePostBody(req);
            const type: BlacklistKind = String(body.type || 'group') === 'user' ? 'user' : 'group';
            const action = String(body.action || 'add').trim();
            const rawIds = Array.isArray(body.ids)
                ? body.ids
                : String(body.id || body.ids || '')
                    .split(/[,，\s\n]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
            const ids = rawIds.map(String).map((s) => s.trim()).filter(Boolean);
            let next: string[] = [];
            if (action === 'set') {
                next = saveBlacklistIds(deps, type, ids);
            } else if (action === 'remove') {
                next = removeBlacklistIds(deps, type, ids);
            } else {
                next = addBlacklistIds(deps, type, ids);
            }
            res.json({ code: 0, data: { type, ids: next }, message: 'ok' });
        } catch (e) {
            logger?.error?.('保存黑户失败:', e);
            res.status(500).json({ code: -1, message: '保存黑户失败' });
        }
    });
}
