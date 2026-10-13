// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 配置读写
// ---------------------------------------------------------------------------

import type {
    SmartChatConfig,
    SmartChatCustomVendor,
    SmartChatDeps,
    SmartChatImageRecognizeSettings,
    SmartChatApiProtocol,
    SmartChatRotationMode,
    SmartChatVendorId,
} from './smart-chat-types';
import {
    DEFAULT_PERSONA_LINE,
    DEFAULT_SYSTEM_PROMPT,
    LEGACY_SYSTEM_PROMPTS,
    SMART_CHAT_ROOT,
    clampPersonaText,
    extractPersonaLine,
    looksLikeFullSystemPrompt,
} from './smart-chat-types';
import { fingerprintPreview, sessionConfigFingerprint } from './smart-chat-fingerprint';
import { getBotNickname, readBotIdentity, resolvedDefaultSystemPrompt } from './smart-chat-identity';
import {
    DEFAULT_COMPACT_RETAIN_RATIO,
    DEFAULT_COMPACT_THRESHOLD_RATIO,
    clampRatio,
} from './smart-chat-token-meter';

const CONFIG_FILE = `${SMART_CHAT_ROOT}config.json`;

/**
 * 库存整段稿的比对基准：**必须 trim 后再比**。
 *
 * `assembleSystemPromptBase()` 拼出来的整段稿末尾带 `\n`（实测 length=1215），
 * 而 `isStockPersonaLine()` 会先把入参 trim 掉；拿 trim 后的串去比未 trim 的常量，
 * 这两个分支永远不成立 —— 结果「整段现行默认全文」被当成自定义人设：
 * 截成 1200 字写回磁盘、人设与配置指纹一起变。LEGACY 表同样有带尾部空白的条目，
 * 所以按 trim 后全等来判。
 */
const STOCK_FULL_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT.trim();
const LEGACY_SYSTEM_PROMPTS_TRIMMED = LEGACY_SYSTEM_PROMPTS.map((x) => String(x).trim());

/** 上一版整段默认人设 → 抽成现行可编辑定义句 */
function isUpgradableStockPresencePrompt(prompt: string): boolean {
    const p = String(prompt || '');
    if (p === DEFAULT_PERSONA_LINE) return false;
    if (p.trim() === STOCK_FULL_SYSTEM_PROMPT) return true;
    if (!p.includes('【你是谁】')) return false;
    // 仍是整段库存稿（含已「最新」的完整稿）→ 迁到只存定义句
    if (looksLikeFullSystemPrompt(p) && (
        p.includes('{{BOT_NICK}}')
        || p.includes('老成员「')
        || p.includes('目标手感：真能当一个普通群友在聊天')
    )) return true;
    return (
        p.includes('老成员「MK」')
        || p.includes('你是群里的老成员「')
        || p.includes('别因为写了「两人互聊」或「人话很短」')
        || p.includes('host-state 的场况/沉默提示只是观察备注')
        || (p.includes('先评定：这批有没有必要回') && p.includes('{{BOT_NICK}}'))
        || p.includes('每轮先两步想，再输出')
        || (p.includes('先调联网工具再答') && p.includes('【你是谁】'))
    );
}

/**
 * 是否「未自定义」库存人设（应不落盘）。
 * 空、现行默认定义句、旧整段默认、LEGACY 命中均算库存。
 * 整段稿先抽【你是谁】再判，避免误伤自定义长稿。
 */
export function isStockPersonaLine(prompt: string): boolean {
    const p = String(prompt || '').trim();
    if (!p) return true;
    if (p === DEFAULT_PERSONA_LINE) return true;
    // 库存整段稿与 LEGACY 表都要按「trim 后全等」判（见 STOCK_FULL_SYSTEM_PROMPT 注释）
    if (p === STOCK_FULL_SYSTEM_PROMPT) return true;
    if (LEGACY_SYSTEM_PROMPTS_TRIMMED.includes(p)) return true;
    if (looksLikeFullSystemPrompt(p) || isUpgradableStockPresencePrompt(p)) {
        const line = canonicalizePersonaLine(extractPersonaLine(p));
        return !line;
    }
    return canonicalizePersonaLine(p) === '';
}

/**
 * 磁盘语义：自定义非空句；库存/空 → ''（不落盘）。
 * 内存请再用 resolvePersonaLineForMemory。
 */
export function normalizeStoredPersonaPrompt(prompt: string): string {
    const p = String(prompt || '').trim();
    if (!p || isStockPersonaLine(p)) return '';
    // 整段旧稿（自定义长稿）：只留下【你是谁】定义句
    if (looksLikeFullSystemPrompt(p) || isUpgradableStockPresencePrompt(p)) {
        const line = canonicalizePersonaLine(extractPersonaLine(p));
        return !line || line === DEFAULT_PERSONA_LINE ? '' : line;
    }
    const line = canonicalizePersonaLine(p);
    return !line || line === DEFAULT_PERSONA_LINE ? '' : line;
}

/** 运行时有效人设：空/库存 → DEFAULT_PERSONA_LINE */
export function resolvePersonaLineForMemory(prompt: string): string {
    const disk = normalizeStoredPersonaPrompt(prompt);
    return disk || DEFAULT_PERSONA_LINE;
}

function canonicalizePersonaLine(line: string): string {
    const s = clampPersonaText(line);
    if (!s) return '';
    const shaped = clampPersonaText(
        s.replace(/你是群里的「[^」]+」/u, '你是群里的「{{BOT_NICK}}」'),
    );
    if (!shaped || shaped === DEFAULT_PERSONA_LINE) return '';
    return shaped;
}

/** 写出 config.json：默认人设省略 system_prompt 键 */
export function configObjectForDisk(cfg: SmartChatConfig): Record<string, unknown> {
    const normalized = normalizeSmartChatConfig(cfg as unknown as Record<string, unknown>);
    const out: Record<string, unknown> = { ...normalized };
    const diskPersona = normalizeStoredPersonaPrompt(String(normalized.system_prompt || ''));
    if (!diskPersona) delete out.system_prompt;
    else out.system_prompt = diskPersona;
    return out;
}

/** 保存时对比：若会话绑定指纹变化，调用方可用于提示 */
let lastSavedFingerprint: string | null = null;

export function peekLastSavedFingerprint(): string | null {
    return lastSavedFingerprint;
}

export const SMART_CHAT_MODELS_DEEPSEEK = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
/** @deprecated 兼容旧引用：等同深度求索模型列表 */
export const SMART_CHAT_MODELS = SMART_CHAT_MODELS_DEEPSEEK;

/** 英伟达 NIM（OpenAI 兼容 integrate.api.nvidia.com）— 高上下文聊天向 */
export const SMART_CHAT_MODELS_NVIDIA = [
    'deepseek-ai/deepseek-v4-flash-0731',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'moonshotai/kimi-k2.6',
    'meta/llama-3.3-70b-instruct',
    'google/gemma-4-31b-it',
    'google/diffusiongemma-26b-a4b-it',
] as const;

/** NIM 上已 EOL / 更名的模型 → 当前可用 ID */
const NVIDIA_EOL_MODEL_ALIASES: Record<string, string> = {
    'deepseek-ai/deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash-0731',
    'deepseek-ai/deepseek-v4-pro': 'deepseek-ai/deepseek-v4-flash-0731',
    'moonshotai/kimi-k2-instruct': 'moonshotai/kimi-k2.6',
    'z-ai/glm-5.2': 'deepseek-ai/deepseek-v4-flash-0731',
};

export type SmartChatModelId =
    | (typeof SMART_CHAT_MODELS_DEEPSEEK)[number]
    | (typeof SMART_CHAT_MODELS_NVIDIA)[number]
    | string;

/** 已移除的内置「幻城」默认地址；加载时若仍指向此处则对齐到当前内置预设 */
const REMOVED_BUILTIN_BASE_HOSTS = ['hcnsec.cn', 'iamhc.cn'];

export interface SmartChatVendorPreset {
    id: string;
    name: string;
    website: string;
    docs?: string;
    base_url: string;
    balance_url: string;
    /** OpenAI 兼容对话路径（挂在 base_url 后） */
    chat_path: string;
    models: readonly string[];
    default_model: string;
    model_labels?: Record<string, string>;
    /** 自定义厂商标记 */
    custom?: boolean;
    api_protocol?: SmartChatApiProtocol;
}

export function isBuiltinVendorId(v: string): v is SmartChatVendorId {
    return v === 'deepseek' || v === 'nvidia';
}

function isRemovedBuiltinVendorHost(url: string): boolean {
    const u = String(url || '').toLowerCase();
    return REMOVED_BUILTIN_BASE_HOSTS.some((h) => u.includes(h));
}

export function isCustomVendorId(v: string): boolean {
    return /^custom_[a-zA-Z0-9_-]{1,64}$/.test(String(v || '').trim());
}

/** 只接受 http/https（配置里的 base_url/balance_url 会被直接 fetch，别放别的协议进来） */
export function isHttpEndpoint(raw: unknown): boolean {
    const s = String(raw ?? '').trim();
    if (!s) return true;
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

export function hostOfEndpoint(raw: unknown): string {
    try {
        return new URL(String(raw ?? '').trim()).host.toLowerCase();
    } catch {
        return '';
    }
}

export interface EndpointKeyEvidence {
    /** 本次请求里顶层 api_key 是真值（非空且不是 `sk-a…z` 这种掩码） */
    topKeyFresh: boolean;
    /** 本次请求里**新填了**密钥的自定义厂商 id（逐个判定，避免「填一个无关档案的 key」蒙过检查） */
    customKeyFresh: Set<string>;
}

/**
 * 端点换主机时是否必须重新提供密钥。
 *
 * 为什么需要：`base_url` / `balance_url` / 自定义厂商档案都由面板请求体决定，而已存密钥
 * 是**密文形态**回传给前端的（提交回来是 `sk-a…z123` 这种掩码）。于是只要
 * 「POST /config 把端点改成自己主机」→ 下一次聊天请求就会把明文密钥送到对方服务器；
 * `balance_url` 同理（再点一次「刷新余额」即可）。没有这道闸，一次 POST 就能拿到密钥。
 *
 * 规则（逐端点判定）：
 * - 目标主机与改前相同 → 放行（改路径/端口无感）
 * - 目标主机是**改前**就已知的端点（厂商预设，或已存的自定义厂商档案）→ 放行（换厂商不受影响）
 * - 其余换主机 → 该端点所属作用域必须本次显式重填密钥
 *
 * 注意：已知端点只取 `prev`（改前）的档案 —— 用合并后的档案会把攻击者刚提交的域名
 * 也算成「已知端点」，等于自废这道闸。
 */
export function endpointChangeNeedsKey(
    prev: Pick<SmartChatConfig, 'base_url' | 'balance_url' | 'vendor' | 'custom_vendors'>,
    next: Pick<SmartChatConfig, 'base_url' | 'balance_url' | 'vendor' | 'custom_vendors'>,
    evidence: EndpointKeyEvidence,
): string | null {
    const preset = SMART_CHAT_VENDOR_PRESETS[next.vendor as SmartChatVendorId];
    const prevProfiles = new Map((prev.custom_vendors || []).map((c) => [c.id, c]));
    const prevCustom = prevProfiles.get(String(next.vendor)) || prevProfiles.get(String(prev.vendor));
    const knownHosts = new Set(
        [
            preset?.base_url,
            preset?.balance_url,
            prevCustom?.base_url,
            prevCustom?.balance_url,
        ].map((u) => hostOfEndpoint(u)).filter(Boolean),
    );

    const judge = (before: unknown, after: unknown, label: string, fresh: boolean): string | null => {
        const beforeHost = hostOfEndpoint(before);
        const afterHost = hostOfEndpoint(after);
        if (!afterHost || afterHost === beforeHost) return null;
        if (fresh || knownHosts.has(afterHost)) return null;
        return `${label}_host_change_requires_api_key`;
    };

    const topError = judge(prev.base_url, next.base_url, 'base_url', evidence.topKeyFresh)
        || judge(prev.balance_url, next.balance_url, 'balance_url', evidence.topKeyFresh);
    if (topError) return topError;

    for (const c of next.custom_vendors || []) {
        const before = prevProfiles.get(c.id);
        if (!before) continue; // 新增档案必须自带密钥，不存在「已存密钥被搬走」的问题
        const fresh = evidence.customKeyFresh.has(c.id);
        const err = judge(before.base_url, c.base_url, `custom_${c.id}_base_url`, fresh)
            || judge(before.balance_url, c.balance_url, `custom_${c.id}_balance_url`, fresh);
        if (err) return err;
    }
    return null;
}

export function normalizeCustomVendors(raw: unknown): SmartChatCustomVendor[] {
    if (!Array.isArray(raw)) return [];
    const out: SmartChatCustomVendor[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const o = row as Record<string, unknown>;
        let id = String(o.id || '').trim();
        if (!isCustomVendorId(id)) {
            id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        }
        if (seen.has(id)) continue;
        const name = String(o.name || '').trim().slice(0, 48);
        const base_url = String(o.base_url || '').trim().replace(/\/+$/, '');
        const model = String(o.model || '').trim().slice(0, 128);
        // 非 http(s) 的一律不要：这些 URL 会被直接 fetch，放进来就是协议走私面
        if (!name || !base_url || !model || !isHttpEndpoint(base_url)) continue;
        seen.add(id);
        const rawBalance = String(o.balance_url || '').trim();
        const balance_url = isHttpEndpoint(rawBalance) ? rawBalance : '';
        const rawPath = o.chat_path != null ? String(o.chat_path).trim() : '';
        const api_protocol = String(o.api_protocol || '').trim().toLowerCase() === 'anthropic'
            ? 'anthropic'
            : 'openai';
        out.push({
            id,
            name,
            api_key: String(o.api_key || '').trim(),
            base_url,
            ...(balance_url ? { balance_url } : {}),
            model,
            temperature: clampNum(o.temperature, 0, 2, 0.7),
            max_tokens: clampNum(o.max_tokens, 64, 16384, 2048),
            chat_path: rawPath,
            api_protocol,
        });
    }
    return out;
}

export const SMART_CHAT_VENDOR_PRESETS: Record<SmartChatVendorId, SmartChatVendorPreset> = {
    deepseek: {
        id: 'deepseek',
        name: '深度求索',
        website: 'https://platform.deepseek.com/',
        docs: 'https://api-docs.deepseek.com/',
        base_url: 'https://api.deepseek.com',
        balance_url: 'https://api.deepseek.com/user/balance',
        chat_path: '/v1/chat/completions',
        models: SMART_CHAT_MODELS_DEEPSEEK,
        default_model: 'deepseek-v4-flash',
        model_labels: {
            'deepseek-v4-flash': 'deepseek-v4-flash（更快更省）',
            'deepseek-v4-pro': 'deepseek-v4-pro（更强）',
        },
    },
    nvidia: {
        id: 'nvidia',
        name: '英伟达 NIM',
        website: 'https://build.nvidia.com/',
        docs: 'https://docs.api.nvidia.com/nim/',
        base_url: 'https://integrate.api.nvidia.com/v1',
        /** 官方无余额接口；留空，额度页展示本地 RPM 统计 */
        balance_url: '',
        chat_path: '/chat/completions',
        models: SMART_CHAT_MODELS_NVIDIA,
        default_model: 'deepseek-ai/deepseek-v4-flash-0731',
        model_labels: {
            'deepseek-ai/deepseek-v4-flash-0731': 'deepseek-v4-flash-0731（1M · 官方最新）',
            'nvidia/nemotron-3-ultra-550b-a55b': 'nemotron-3-ultra（1M）',
            'nvidia/nemotron-3-super-120b-a12b': 'nemotron-3-super（1M）',
            'nvidia/nemotron-3.5-lightning-30b-a3b': 'nemotron-3.5-lightning（快）',
            'openai/gpt-oss-120b': 'gpt-oss-120b（128K）',
            'openai/gpt-oss-20b': 'gpt-oss-20b（128K）',
            'moonshotai/kimi-k2.6': 'kimi-k2.6（128K）',
            'meta/llama-3.3-70b-instruct': 'llama-3.3-70b（128K）',
            'google/gemma-4-31b-it': 'gemma-4-31b（128K）',
            'google/diffusiongemma-26b-a4b-it': 'diffusiongemma-26b（128K）',
        },
    },
};

export function normalizeSmartChatVendor(raw: unknown, hintBaseUrl?: string): SmartChatVendorId {
    const v = String(raw || '').trim().toLowerCase();
    // 已移除内置幻城：旧 vendor / 别名一律落到 deepseek（需继续用请加自定义厂商）
    if (v === 'hcnsec' || v === '幻城' || v === 'xinjiang' || v === 'iamhc') return 'deepseek';
    if (v === 'nvidia' || v === 'nim' || v === '英伟达' || v === 'nvidia-nim' || v === 'nvidianim') return 'nvidia';
    if (v === 'deepseek' || v === '深度求索') return 'deepseek';
    const base = String(hintBaseUrl || '').toLowerCase();
    if (isRemovedBuiltinVendorHost(base)) return 'deepseek';
    if (base.includes('nvidia.com') || base.includes('integrate.api.nvidia')) return 'nvidia';
    return 'deepseek';
}

/** 解析配置里的 vendor 字段：优先保留合法 custom_*，否则收敛到内置厂商 */
export function resolveConfigVendorId(
    rawVendor: unknown,
    hintBaseUrl: string | undefined,
    customs: SmartChatCustomVendor[],
): string {
    const v = String(rawVendor || '').trim();
    if (isCustomVendorId(v) && customs.some((c) => c.id === v)) return v;
    return normalizeSmartChatVendor(v, hintBaseUrl);
}

export function getVendorPreset(
    vendor: string,
    customs: SmartChatCustomVendor[] = [],
): SmartChatVendorPreset {
    if (isBuiltinVendorId(vendor)) {
        return SMART_CHAT_VENDOR_PRESETS[vendor] || SMART_CHAT_VENDOR_PRESETS.deepseek;
    }
    const c = customs.find((x) => x.id === vendor);
    if (c) {
        return {
            id: c.id,
            name: c.name,
            website: '',
            docs: '',
            base_url: c.base_url,
            balance_url: String(c.balance_url || '').trim(),
            chat_path: c.chat_path || '',
            models: [c.model],
            default_model: c.model,
            custom: true,
            api_protocol: c.api_protocol || 'openai',
        };
    }
    return SMART_CHAT_VENDOR_PRESETS.deepseek;
}

export function resolveChatPreset(config: SmartChatConfig): SmartChatVendorPreset {
    return getVendorPreset(String(config.vendor || ''), config.custom_vendors || []);
}

export function normalizeSmartChatModel(
    raw: unknown,
    vendor: string = 'deepseek',
    customs: SmartChatCustomVendor[] = [],
): string {
    let m = String(raw || '').trim();
    if (isCustomVendorId(vendor) || getVendorPreset(vendor, customs).custom) {
        return m || getVendorPreset(vendor, customs).default_model;
    }
    const preset = getVendorPreset(vendor);
    if (vendor === 'nvidia' || normalizeSmartChatVendor(vendor) === 'nvidia') {
        const aliased = NVIDIA_EOL_MODEL_ALIASES[m] || NVIDIA_EOL_MODEL_ALIASES[m.toLowerCase()];
        if (aliased) m = aliased;
    }
    if (preset.models.includes(m)) return m;
    const lower = m.toLowerCase();
    const hit = preset.models.find((x) => x.toLowerCase() === lower);
    if (hit) return hit;
    return preset.default_model;
}

export function defaultWebSearchKeys() {
    return {
        tavily_key: '',
        serper_key: '',
        bocha_key: '',
    };
}

export function defaultImageRecognizeSettings(): SmartChatImageRecognizeSettings {
    return {
        timeout_sec: 30,
        queue_normal: 3,
        queue_at: 3,
        per_msg_normal: 3,
        per_msg_at: 2,
    };
}

/**
 * 第三方配音的默认角色。
 *
 * 留空时不再回退成「按文本发送」，而是用这个角色 —— 用户装了插件、打开语音开关
 * 就能直接听到合成语音，不必先去后台挑角色。想换的话在后台选别的即可。
 * 注意只在**第三方（pearapi）**引擎下兜底：QQAI 用 character id，语义不同。
 */
export const DEFAULT_VOICE_DUB = '病娇少女';

/** 语音输出默认值：默认角色「病娇少女」，格式 ogg，限长 150 */
export function defaultVoiceSettings() {
    return {
        engine: 'pearapi',
        api_key: '',
        dub: DEFAULT_VOICE_DUB,
        format: 'ogg',
        qq_character: '',
        qq_ref_group: '',
        max_chars: 150,
    };
}

export function defaultSmartChatConfig(): SmartChatConfig {
    const preset = SMART_CHAT_VENDOR_PRESETS.deepseek;
    return {
        vendor: 'deepseek',
        api_key: '',
        base_url: preset.base_url,
        balance_url: preset.balance_url,
        model: preset.default_model,
        temperature: 0.7,
        max_tokens: 2048,
        debounce_ms: 8000,
        max_batch: 12,
        batch_max_age_ms: 120000,
        random_wait_enabled: true,
        random_wait_min_ms: 60000,
        random_wait_max_ms: 1800000,
        // 与默认值一致；改动请同步 smart-chat-token-meter.ts 的 DEFAULT_*
        compact_threshold_ratio: DEFAULT_COMPACT_THRESHOLD_RATIO,
        compact_retain_ratio: DEFAULT_COMPACT_RETAIN_RATIO,
        // 与 smart-chat-silence.ts::DEFAULT_SILENCE_VETO_RATIO 保持一致
        // （不 import 是为了避免 config → silence → sticker → config 的循环引用）
        silence_veto_ratio: 0.35,
        kb_top_m: 3,
        style_pack_enabled: true,
        style_pack_id: 'groupie',
        system_prompt: DEFAULT_PERSONA_LINE,
        reply_gap_ms: 1200,
        shut_up_limit: 5,
        action_min: 0,
        action_max: 3,
        price_prompt_per_million: 0,
        price_completion_per_million: 0,
        private_chat_enabled: true,
        tools_enabled: false,
        tools_max_rounds: 3,
        web_search: defaultWebSearchKeys(),
        image_recognize: defaultImageRecognizeSettings(),
        voice: defaultVoiceSettings(),
        custom_vendors: [],
        model_rotation_enabled: false,
        model_rotation_mode: 'same_vendor',
        model_rotation_limit: 3,
    };
}

/** 轮替方式归一化：非法值一律回落到最保守的「仅本厂商内轮替」 */
export function normalizeRotationMode(raw: unknown): SmartChatRotationMode {
    const v = String(raw || '').trim().toLowerCase();
    if (v === 'other_vendor_default' || v === 'other_vendor_any') return v;
    return 'same_vendor';
}

function normalizeWebSearchKeys(raw: unknown) {
    const d = defaultWebSearchKeys();
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
        tavily_key: String(o.tavily_key ?? d.tavily_key).trim(),
        serper_key: String(o.serper_key ?? d.serper_key).trim(),
        bocha_key: String(o.bocha_key ?? d.bocha_key).trim(),
    };
}

function normalizeImageRecognizeSettings(raw: unknown): SmartChatImageRecognizeSettings {    const d = defaultImageRecognizeSettings();
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    let timeoutSec = d.timeout_sec;
    if (o.timeout_sec != null) timeoutSec = Number(o.timeout_sec);
    else if (o.timeout_ms != null) timeoutSec = Number(o.timeout_ms) / 1000;
    return {
        timeout_sec: clampNum(timeoutSec, 5, 120, d.timeout_sec),
        queue_normal: clampNum(o.queue_normal ?? o.queue_limit, 1, 20, d.queue_normal),
        queue_at: clampNum(o.queue_at ?? o.queue_limit, 1, 20, d.queue_at),
        per_msg_normal: clampNum(o.per_msg_normal, 1, 10, d.per_msg_normal),
        per_msg_at: clampNum(o.per_msg_at, 1, 10, d.per_msg_at),
    };
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
    const n = Number(v);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 语音设置归一化：格式仅 ogg/mp3，限长 30–150（接口按 30 字计费，硬顶 150）
 *
 * dub（第三方配音角色）留空时兜底为 DEFAULT_VOICE_DUB。这里必须兜底、
 * 不能只改 defaultVoiceSettings()：老用户存过的配置里 dub 就是空串，
 * 只改默认值的话他们升级后仍然是「按文本发送」，感知不到这次改动。
 */
function normalizeVoiceSettings(raw: unknown) {
    const d = defaultVoiceSettings();
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const fmt = String(o.format ?? d.format).trim().toLowerCase();
    const engine = String(o.engine ?? d.engine).trim().toLowerCase();
    // 空串 / 纯空白 / undefined 一律视为「未配置」→ 采用默认角色
    const dubRaw = String(o.dub ?? '').trim();
    return {
        engine: engine === 'qqai' ? 'qqai' : 'pearapi',
        api_key: String(o.api_key ?? d.api_key).trim(),
        dub: dubRaw || DEFAULT_VOICE_DUB,
        format: fmt === 'mp3' ? 'mp3' : 'ogg',
        qq_character: String(o.qq_character ?? d.qq_character).trim(),
        qq_ref_group: String(o.qq_ref_group ?? d.qq_ref_group).trim().replace(/[^0-9]/g, ''),
        max_chars: Math.round(clampNum(o.max_chars, 30, 150, d.max_chars)),
    };
}

/** 行为限制：0–10，min≤max，禁止 max=0（即禁止 0-0） */
export function normalizeActionRange(
    minRaw: unknown,
    maxRaw: unknown,
    fallbackMin: number,
    fallbackMax: number,
): { action_min: number; action_max: number } {
    let min = clampNum(minRaw, 0, 10, fallbackMin);
    let max = clampNum(maxRaw, 0, 10, fallbackMax);
    if (max < 1) max = Math.max(1, fallbackMax);
    if (min > max) min = max;
    return { action_min: min, action_max: max };
}

export function normalizeSmartChatConfig(raw: Record<string, unknown> | null | undefined): SmartChatConfig {
    const d = defaultSmartChatConfig();
    if (!raw || typeof raw !== 'object') return d;
    // 磁盘缺省/空 → 内存填现行 DEFAULT；自定义句原样（已 normalize）
    const systemPrompt = resolvePersonaLineForMemory(
        raw.system_prompt != null ? String(raw.system_prompt) : '',
    );
    const range = normalizeActionRange(raw.action_min, raw.action_max, d.action_min, d.action_max);
    const hintBase = String(raw.base_url ?? d.base_url);
    const custom_vendors = normalizeCustomVendors(raw.custom_vendors);
    const vendor = resolveConfigVendorId(raw.vendor, hintBase, custom_vendors);
    const preset = getVendorPreset(vendor, custom_vendors);
    const isCustom = Boolean(preset.custom);
    // 厂商切换后若仍是对方默认 URL，自动对齐预设；用户自定义 URL 则保留
    let base_url = String(raw.base_url ?? d.base_url).replace(/\/+$/, '');
    let balance_url = String(raw.balance_url ?? d.balance_url).trim();
    if (!isCustom) {
        const otherBases = Object.values(SMART_CHAT_VENDOR_PRESETS)
            .filter((p) => p.id !== vendor)
            .map((p) => p.base_url);
        const otherBalances = Object.values(SMART_CHAT_VENDOR_PRESETS)
            .filter((p) => p.id !== vendor)
            .map((p) => p.balance_url);
        if (!base_url || otherBases.includes(base_url) || isRemovedBuiltinVendorHost(base_url)) {
            base_url = preset.base_url;
        }
        if (
            !balance_url
            || otherBalances.includes(balance_url)
            || isRemovedBuiltinVendorHost(balance_url)
        ) {
            balance_url = preset.balance_url;
        }
    } else if (!base_url) {
        base_url = preset.base_url;
    }

    let api_key = String(raw.api_key ?? d.api_key);
    let model = normalizeSmartChatModel(raw.model ?? d.model, vendor, custom_vendors);
    let temperature = clampNum(raw.temperature, 0, 2, d.temperature);
    let max_tokens = clampNum(raw.max_tokens, 64, 16384, d.max_tokens);
    // 当前选中自定义厂商时，用档案补全空字段，并回写档案
    const customs = custom_vendors.map((c) => ({ ...c }));
    if (isCustom) {
        const idx = customs.findIndex((c) => c.id === vendor);
        if (idx >= 0) {
            const cur = customs[idx];
            if (!api_key) api_key = cur.api_key;
            if (!base_url) base_url = cur.base_url;
            if (!model) model = cur.model;
            // 顶层未填 balance_url 时用档案；有填则写回档案
            if (!balance_url) balance_url = String(cur.balance_url || '').trim();
            const nextBal = balance_url.trim();
            customs[idx] = {
                ...cur,
                api_key: api_key || cur.api_key,
                base_url: base_url || cur.base_url,
                model: model || cur.model,
                temperature,
                max_tokens,
                ...(nextBal ? { balance_url: nextBal } : { balance_url: undefined }),
            };
            if (!nextBal) delete customs[idx].balance_url;
        }
    }

    // 随机等待：先各自 clamp，再保证 min ≤ max（写反了自动兜正，不报错也不静默丢配置）
    const randMinRaw = clampNum(raw.random_wait_min_ms, 1000, 3600000, d.random_wait_min_ms);
    const randMaxRaw = clampNum(raw.random_wait_max_ms, 1000, 3600000, d.random_wait_max_ms);
    const random_wait_min_ms = Math.min(randMinRaw, randMaxRaw);
    const random_wait_max_ms = Math.max(randMinRaw, randMaxRaw);

    // A① 压缩预算：各自 clamp，再保证 retain < threshold（写反了自动兜正）
    const compact_threshold_ratio = clampRatio(
        raw.compact_threshold_ratio,
        0.3,
        0.95,
        d.compact_threshold_ratio,
    );
    let compact_retain_ratio = clampRatio(
        raw.compact_retain_ratio,
        0.05,
        0.5,
        d.compact_retain_ratio,
    );
    if (compact_retain_ratio >= compact_threshold_ratio) {
        compact_retain_ratio = Math.max(0.05, compact_threshold_ratio / 4);
    }

    return {
        vendor,
        api_key,
        base_url,
        balance_url,
        model,
        temperature,
        max_tokens,
        debounce_ms: clampNum(raw.debounce_ms, 1000, 120000, d.debounce_ms),
        max_batch: clampNum(raw.max_batch, 1, 25, d.max_batch),
        batch_max_age_ms: clampNum(raw.batch_max_age_ms, 10000, 1800000, d.batch_max_age_ms),
        random_wait_enabled: raw.random_wait_enabled !== false && raw.random_wait_enabled !== 'false',
        random_wait_min_ms,
        random_wait_max_ms,
        silence_veto_ratio: clampNum(raw.silence_veto_ratio, 0, 1, d.silence_veto_ratio),
        compact_threshold_ratio,
        compact_retain_ratio,
        kb_top_m: clampNum(raw.kb_top_m, 0, 20, d.kb_top_m),
        style_pack_enabled: raw.style_pack_enabled !== false && raw.style_pack_enabled !== 'false',
        style_pack_id: String(raw.style_pack_id ?? d.style_pack_id).trim() || d.style_pack_id,
        system_prompt: systemPrompt,
        reply_gap_ms: clampNum(raw.reply_gap_ms, 400, 8000, d.reply_gap_ms),
        shut_up_limit: clampNum(raw.shut_up_limit, 1, 50, d.shut_up_limit),
        action_min: range.action_min,
        action_max: range.action_max,
        price_prompt_per_million: clampNum(raw.price_prompt_per_million, 0, 9999, d.price_prompt_per_million),
        price_completion_per_million: clampNum(raw.price_completion_per_million, 0, 9999, d.price_completion_per_million),
        private_chat_enabled: raw.private_chat_enabled !== false && raw.private_chat_enabled !== 'false',
        // 已迁至分群/好友「联网搜索」；全局字段固定 false，避免旧配置误判默认开启
        tools_enabled: false,
        tools_max_rounds: clampNum(raw.tools_max_rounds, 1, 5, d.tools_max_rounds),
        web_search: normalizeWebSearchKeys(raw.web_search),
        image_recognize: normalizeImageRecognizeSettings(raw.image_recognize),
        voice: normalizeVoiceSettings(raw.voice),
        custom_vendors: customs,
        model_rotation_enabled: raw.model_rotation_enabled === true || raw.model_rotation_enabled === 'true',
        model_rotation_mode: normalizeRotationMode(raw.model_rotation_mode ?? d.model_rotation_mode),
        // 0 = 不限；上限 20 次，防止误填导致长时间反复重试
        model_rotation_limit: Math.round(clampNum(raw.model_rotation_limit, 0, 20, d.model_rotation_limit)),
    };
}

export function loadSmartChatConfig(deps: SmartChatDeps): SmartChatConfig {
    const raw = deps.readA(CONFIG_FILE);
    if (!raw) return defaultSmartChatConfig();
    try {
        const parsed = JSON.parse(raw);
        const hadKey = Object.prototype.hasOwnProperty.call(parsed || {}, 'system_prompt');
        const beforePrompt = hadKey ? String(parsed?.system_prompt ?? '') : '';
        const cfg = normalizeSmartChatConfig(parsed);
        const diskPersona = normalizeStoredPersonaPrompt(beforePrompt);
        // 旧默认全文 / 库存句 / 空键 → 迁移删键；自定义句形状变化才回写
        const shouldMigrate =
            (hadKey && !diskPersona)
            || (hadKey && diskPersona && diskPersona !== beforePrompt);
        if (shouldMigrate) {
            try {
                deps.writeA(CONFIG_FILE, JSON.stringify(configObjectForDisk(cfg), null, 2));
            } catch {
                /* ignore */
            }
        }
        return cfg;
    } catch {
        return defaultSmartChatConfig();
    }
}

export function saveSmartChatConfig(deps: SmartChatDeps, cfg: SmartChatConfig): { fingerprint: string; fingerprintChanged: boolean; previousFingerprint: string | null } {
    const normalized = normalizeSmartChatConfig(cfg as unknown as Record<string, unknown>);
    const prev = lastSavedFingerprint ?? sessionConfigFingerprint(loadSmartChatConfig(deps));
    const fp = sessionConfigFingerprint(normalized);
    deps.writeA(CONFIG_FILE, JSON.stringify(configObjectForDisk(normalized), null, 2));
    const fingerprintChanged = Boolean(prev) && prev !== fp;
    lastSavedFingerprint = fp;
    return { fingerprint: fp, fingerprintChanged, previousFingerprint: prev === fp ? null : prev };
}

export function maskApiKey(key: string): string {
    const k = String(key || '').trim();
    if (!k) return '';
    if (k.length <= 8) return '****';
    return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export function configForWeb(cfg: SmartChatConfig, deps?: SmartChatDeps | null): SmartChatConfig & {
    api_key_masked: string;
    api_key_set: boolean;
    session_fingerprint: string;
    session_fingerprint_preview: string;
    web_search_masked: Record<string, string | boolean>;
    web_search_ready: boolean;
    vendor_meta: SmartChatVendorPreset;
    vendors: Array<Pick<SmartChatVendorPreset, 'id' | 'name' | 'website' | 'docs'>>;
    /** 当前代码内置默认【你是谁】定义句（供 WebUI「恢复默认」）；已替换登录昵称 */
    default_system_prompt: string;
    /** 智能对话缓存的登录昵称（identity.json） */
    bot_nickname: string;
    bot_user_id: string;
    custom_vendors: Array<SmartChatCustomVendor & { api_key_set: boolean; api_key_masked: string }>;
} {
    const fp = sessionConfigFingerprint(cfg);
    lastSavedFingerprint = fp;
    const ws = cfg.web_search || defaultWebSearchKeys();
    const web_search_masked = {
        tavily_key: ws.tavily_key ? maskApiKey(ws.tavily_key) : '',
        tavily_set: Boolean(ws.tavily_key),
        serper_key: ws.serper_key ? maskApiKey(ws.serper_key) : '',
        serper_set: Boolean(ws.serper_key),
        bocha_key: ws.bocha_key ? maskApiKey(ws.bocha_key) : '',
        bocha_set: Boolean(ws.bocha_key),
    };
    const customs = cfg.custom_vendors || [];
    const vendor_meta = getVendorPreset(cfg.vendor || 'deepseek', customs);
    const voice = cfg.voice || defaultVoiceSettings();
    const voice_web = {
        // 内置体验密钥永不下发；这里只暴露「用户是否填了自有密钥」+ 掩码
        engine: voice.engine === 'qqai' ? 'qqai' : 'pearapi',
        api_key: voice.api_key ? maskApiKey(voice.api_key) : '',
        api_key_set: Boolean(String(voice.api_key || '').trim()),
        dub: voice.dub || '',
        format: voice.format === 'mp3' ? 'mp3' : 'ogg',
        qq_character: voice.qq_character || '',
        qq_ref_group: voice.qq_ref_group || '',
        max_chars: Number(voice.max_chars) || 150,
    };
    const bot_nickname = deps ? getBotNickname(deps) : '';
    const bot_user_id = deps ? String(readBotIdentity(deps)?.user_id || '').trim() : '';
    const custom_vendors = customs.map((c) => ({
        ...c,
        api_key_set: Boolean(String(c.api_key || '').trim()),
        api_key_masked: maskApiKey(c.api_key),
        api_key: c.api_key ? maskApiKey(c.api_key) : '',
    }));
    return {
        ...cfg,
        api_key_masked: maskApiKey(cfg.api_key),
        api_key_set: Boolean(String(cfg.api_key || '').trim()),
        api_key: cfg.api_key ? maskApiKey(cfg.api_key) : '',
        web_search: {
            tavily_key: web_search_masked.tavily_key,
            serper_key: web_search_masked.serper_key,
            bocha_key: web_search_masked.bocha_key,
        },
        web_search_masked,
        voice: voice_web,
        default_system_prompt: deps ? resolvedDefaultSystemPrompt(deps) : DEFAULT_PERSONA_LINE,
        bot_nickname,
        bot_user_id,
        web_search_ready: Boolean(ws.tavily_key || ws.serper_key || ws.bocha_key),
        session_fingerprint: fp,
        session_fingerprint_preview: fingerprintPreview(fp),
        vendor_meta,
        vendors: Object.values(SMART_CHAT_VENDOR_PRESETS).map((p) => ({
            id: p.id,
            name: p.name,
            website: p.website,
            docs: p.docs,
        })),
        custom_vendors,
    };
}
