// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — token 计量与压缩预算
//
// 为什么要它：压缩原来只看**消息条数**（96 条），12 条长消息和 12 条「在吗」等价，
// 于是要么该压没压（真实 token 早就顶到窗口），要么不该压先压（把短消息压掉丢信息）。
// 这里给一个厂商无关的估算器 + 阈值/保留比例，压缩按 token 预算走，
// 条数阈值退化为「硬阀」（防文件无限膨胀）。
//
// 估算口径与 `smart-chat-nvidia-context.ts` 保持一致（CJK 按 1 字≈1 token，
// 其余按 4 字符≈1 token），只是不再绑死某个厂商。
// ---------------------------------------------------------------------------

export interface TokenMessageLike {
    role?: string;
    content?: unknown;
    tool_calls?: unknown;
    name?: string;
}

/**
 * 估算系数（**实测标定，不是拍脑袋**）：
 * 用 deepseek-v4-flash 真实请求对照 usage.prompt_tokens：
 * 同一份内容「CJK 1 token/字 + ASCII 4 字符/token」估 40459，实际 26505 → 0.655。
 * 故 CJK 定为 0.65 token/字（中文 tokenizer 大约 1.5 字/token）。
 * 旧口径是「总长/2.5」：对纯中文会**低估**（实测 17538 vs 26505），
 * 触发点因此偏晚 —— 这正是要换成字符分类口径的原因。
 */
export const CJK_TOKENS_PER_CHAR = 0.65;
export const ASCII_CHARS_PER_TOKEN = 4;

/** 单段文本估算：CJK/全角按 0.65 token/字，其余按 4 字符≈1 token */
export function estimateTextTokens(text: unknown): number {
    const s = String(text ?? '');
    if (!s) return 0;
    let cjk = 0;
    for (const ch of s) {
        const code = ch.codePointAt(0) || 0;
        if (
            (code >= 0x3000 && code <= 0x303f) // CJK 标点
            || (code >= 0x3400 && code <= 0x4dbf)
            || (code >= 0x4e00 && code <= 0x9fff)
            || (code >= 0xf900 && code <= 0xfaff)
            || (code >= 0xff00 && code <= 0xffef) // 全角
        ) {
            cjk += 1;
        }
    }
    const rest = s.length - cjk;
    return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + rest / ASCII_CHARS_PER_TOKEN);
}

/** 一轮消息估算：正文 + 角色/名字/工具调用的固定开销 */
export function estimateMessagesTokens(messages: TokenMessageLike[]): number {
    let total = 0;
    for (const m of messages || []) {
        total += 4; // 每条消息的角色/分隔符开销
        total += estimateTextTokens(m?.content);
        if (m?.name) total += estimateTextTokens(m.name);
        if (m?.tool_calls) total += estimateTextTokens(JSON.stringify(m.tool_calls));
    }
    return total;
}

export interface ContextWindowInfo {
    window: number;
    source: 'vendor-model' | 'vendor-default' | 'fallback';
}

/**
 * 上游上下文窗口（token）。
 * - deepseek：现行 API 文档口径 128K
 * - nvidia：用 NIM 的档位表（`nvidiaContextBudget`，已按模型 id 分档）
 * - 其它/自定义线路：保守 64K（宁可早压，也别等上游报 context_length）
 *
 * 注意：窗口只用来算触发点，比例本身还有 0.8 的安全边际，所以即便某条线路的窗口
 * 估偏，效果只是「压得早一点/晚一点」，不会算错预算。
 */
export function resolveContextWindow(vendor: string, model: string, nvidiaBudget?: number): ContextWindowInfo {
    const v = String(vendor || '').trim().toLowerCase();
    if (v === 'deepseek') return { window: 128_000, source: 'vendor-default' };
    if (v === 'nvidia') {
        const w = Number(nvidiaBudget) || 0;
        return w > 0 ? { window: w, source: 'vendor-model' } : { window: 128_000, source: 'vendor-default' };
    }
    return { window: 64_000, source: 'fallback' };
}

/** 压缩策略默认比例（可用配置覆盖） */
export const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.8;
export const DEFAULT_COMPACT_RETAIN_RATIO = 0.16;

export interface CompactionBudget {
    /** 已路由上下文窗口（token） */
    window: number;
    /** 达到该估算值即可触发压缩 */
    thresholdTokens: number;
    /** 压缩后尾部保留的 token 预算（verbatim） */
    retainTokens: number;
    thresholdRatio: number;
    retainRatio: number;
    source: string;
}

export function clampRatio(raw: unknown, min: number, max: number, fallback: number): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 由配置解析压缩预算。
 * retainRatio 必须严格小于 thresholdRatio，否则写反了会自动兜正（不报错、不静默丢配置）。
 */
export function resolveCompactionBudget(
    config: Record<string, unknown> | null | undefined,
    opts: { vendor?: string; model?: string; nvidiaBudget?: number } = {},
): CompactionBudget {
    const thresholdRatio = clampRatio(
        config?.compact_threshold_ratio,
        0.3,
        0.95,
        DEFAULT_COMPACT_THRESHOLD_RATIO,
    );
    let retainRatio = clampRatio(
        config?.compact_retain_ratio,
        0.05,
        0.5,
        DEFAULT_COMPACT_RETAIN_RATIO,
    );
    if (retainRatio >= thresholdRatio) retainRatio = Math.max(0.05, thresholdRatio / 4);
    const info = resolveContextWindow(
        String(opts.vendor ?? config?.vendor ?? ''),
        String(opts.model ?? config?.model ?? ''),
        opts.nvidiaBudget,
    );
    return {
        window: info.window,
        thresholdTokens: Math.floor(info.window * thresholdRatio),
        retainTokens: Math.floor(info.window * retainRatio),
        thresholdRatio,
        retainRatio,
        source: info.source,
    };
}

/**
 * 从尾部往前累计，返回「保留多少条」用掉不超过 retainTokens 的 verbatim 预算。
 * 至少留 minKeep 条、最多 maxKeep 条；最后一条本身超预算也照留（不然会压成空历史）。
 */
export function keepTailForTokens(
    messages: TokenMessageLike[],
    retainTokens: number,
    minKeep = 4,
    maxKeep = 96,
): number {
    const list = messages || [];
    if (!list.length) return 0;
    let used = 0;
    let keep = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const cost = estimateMessagesTokens([list[i]]);
        if (keep >= minKeep && used + cost > retainTokens) break;
        used += cost;
        keep += 1;
        if (keep >= maxKeep) break;
    }
    return Math.max(1, Math.min(list.length, Math.max(minKeep, keep)));
}
