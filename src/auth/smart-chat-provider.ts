// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — Provider（OpenAI 兼容 chat/completions + tools）
// ---------------------------------------------------------------------------

import type { CompletionUsage, SmartChatConfig } from './smart-chat-types';
import { isBuiltinVendorId, normalizeSmartChatVendor, resolveChatPreset } from './smart-chat-config';
import {
    ANTHROPIC_API_VERSION,
    buildChatUrl,
    resolveApiProtocol,
    resolveEffectiveChatPath,
} from './smart-chat-api-url';
import { noteNvidiaRequest } from './smart-chat-nvidia-rate';
import { bindRotationDeps, runChatWithRotation } from './smart-chat-rotation';

export { bindRotationDeps };

export interface ToolCallResult {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

export interface CompletionResult {
    ok: boolean;
    content?: string;
    /** 上游原生思考文本（reasoning / reasoning_content / thinking 块）；不进群聊，仅供落盘复盘 */
    reasoning?: string;
    tool_calls?: ToolCallResult[];
    usage?: CompletionUsage;
    error?: string;
    status?: number;
    raw?: string;
    /** 自动模型轮替：实际成功的厂商 / 模型（未轮替时不存在） */
    rotated_vendor?: string;
    rotated_model?: string;
    rotated_from?: string;
    rotation_attempts?: number;
    rotation_log?: string[];
}

/**
 * 模型是否自带原生思考（reasoning）能力：按模型名启发式判断。
 * 命中则「伪装思考」自动跳过注入（auto-skip），避免与原生思考叠加。
 * nvidia 内置线路在 provider 里显式关掉 thinking，视为无原生思考。
 */
export function modelHasNativeThinking(config: { model?: string; vendor?: string }): boolean {
    const vendor = String(config?.vendor || '').trim().toLowerCase();
    const model = String(config?.model || '').trim().toLowerCase();
    if (!model) return false;
    // nvidia 内置线路：body.chat_template_kwargs.thinking=false，等于关掉原生思考
    if (vendor === 'nvidia') return false;
    return /reasoner|deepseek-r1|deepseek-v3\.1|\bo1\b|\bo1-|\bo3\b|\bo3-|o4-mini|\bqwq\b|qwen[\w.-]*think|glm[\w.-]*think|-r1\b|reasoning|thinking|grok[\w.-]*reason/i.test(model);
}

export type ChatMessage =
    | { role: string; content: string | null; tool_calls?: ToolCallResult[] }
    | { role: 'tool'; tool_call_id: string; content: string };

/**
 * 中转站/网关偶发抽风（403/429/5xx/超时）值得短退避重试；
 * 401 / 明确无效密钥 / 余额不足这类是真·致命，不在此列。
 */
const RETRYABLE_HTTP_STATUSES = new Set([403, 408, 409, 425, 429, 500, 502, 503, 504]);
function isRetryableStatus(status: number): boolean {
    return RETRYABLE_HTTP_STATUSES.has(Number(status));
}

/** DeepSeek 等模型偶发把工具调用写成正文 DSML/XML，而不是 API tool_calls */
const DSML_PIPE = '[|｜]{0,4}';

export function looksLikeToolMarkup(raw: string | null | undefined): boolean {
    const t = String(raw || '');
    if (!t.trim()) return false;
    if (/DSML/i.test(t) && /(?:tool_calls|invoke|parameter)/i.test(t)) return true;
    if (/<\/?tool_calls?\b/i.test(t)) return true;
    if (/<invoke\b[^>]*\bname\s*=/i.test(t) && /<\/?parameter\b/i.test(t)) return true;
    return false;
}

/** 去掉 DSML / tool XML，留下可读正文（若有） */
export function stripToolMarkup(raw: string | null | undefined): string {
    let s = String(raw || '');
    // <｜｜DSML｜｜tag>...</｜｜DSML｜｜tag> 或 <|DSML|...>
    const openClose = new RegExp(
        `<\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*[\\w-]+\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*[\\w-]+\\s*>`,
        'gi',
    );
    const selfOrOpen = new RegExp(
        `<\\s*/?\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*[\\w-]*\\b[^>]*>`,
        'gi',
    );
    s = s.replace(openClose, ' ');
    s = s.replace(selfOrOpen, ' ');
    s = s.replace(/<\/?(?:tool_calls?|invoke|parameter)\b[^>]*>/gi, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/**
 * 从正文里抠出 DSML / XML 风格工具调用，转成 OpenAI tool_calls。
 */
export function parseEmbeddedToolCalls(raw: string | null | undefined): ToolCallResult[] {
    const text = String(raw || '');
    if (!text.trim()) return [];
    const out: ToolCallResult[] = [];
    const invokeRe = new RegExp(
        `(?:<\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*invoke|<invoke)\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)(?:<\\s*/\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*invoke\\s*>|</invoke>)`,
        'gi',
    );
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = invokeRe.exec(text)) && out.length < 8) {
        const name = String(m[1] || '').trim();
        const body = m[2] || '';
        if (!name) continue;
        const args: Record<string, unknown> = {};
        const paramRe = new RegExp(
            `(?:<\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*parameter|<parameter)\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)(?:<\\s*/\\s*${DSML_PIPE}\\s*DSML\\s*${DSML_PIPE}\\s*parameter\\s*>|</parameter>)`,
            'gi',
        );
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(body))) {
            const key = String(pm[1] || '').trim();
            let val = String(pm[2] || '').trim();
            if (!key) continue;
            if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
            if (/^(true|false)$/i.test(val)) args[key] = /^true$/i.test(val);
            else if (/^-?\d+(\.\d+)?$/.test(val)) args[key] = Number(val);
            else args[key] = val;
        }
        idx += 1;
        out.push({
            id: `dsml_${Date.now()}_${idx}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        });
    }
    return out;
}

/** 若 API 未给 tool_calls 但正文是 DSML，则补齐；并清掉不应外发的工具标记 */
export function normalizeCompletionTools(result: CompletionResult): CompletionResult {
    if (!result?.ok) return result;
    let content = result.content;
    let tool_calls = result.tool_calls;
    if ((!tool_calls || !tool_calls.length) && looksLikeToolMarkup(content)) {
        const parsed = parseEmbeddedToolCalls(content);
        if (parsed.length) tool_calls = parsed;
    }
    if (looksLikeToolMarkup(content)) {
        const stripped = stripToolMarkup(content);
        content = stripped || undefined;
    }
    return {
        ...result,
        content,
        tool_calls: tool_calls?.length ? tool_calls : undefined,
    };
}

/**
 * usage 里的前缀缓存计数：各家字段名不同，一次全认。
 * - DeepSeek 原生：prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - OpenAI 及多数中转/网关：prompt_tokens_details.cached_tokens（嵌套）
 * - Anthropic 风格网关：cache_read_input_tokens
 * 只认了扁平字段时，走 OpenAI 形状的上游会永远记 0，把「前缀没稳」和
 * 「上游没报」混成一件事 —— 16 代 38 次请求全是 cache_fields_reported=false。
 */
function extractCacheTokens(usageRaw?: Record<string, unknown> | null): {
    hit: number;
    miss: number;
    reported: boolean;
} {
    if (!usageRaw || typeof usageRaw !== 'object') return { hit: 0, miss: 0, reported: false };
    const details = (usageRaw as Record<string, unknown>).prompt_tokens_details;
    const nested = details && typeof details === 'object' ? (details as Record<string, unknown>) : null;
    const num = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const has = (obj: Record<string, unknown> | null, key: string): boolean =>
        Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));

    const hit =
        num(usageRaw.prompt_cache_hit_tokens)
        || num(usageRaw.cached_tokens)
        || num(nested?.cached_tokens)
        || num(usageRaw.cache_read_input_tokens);
    const promptAll = num(usageRaw.prompt_tokens);
    const miss =
        num(usageRaw.prompt_cache_miss_tokens)
        || (hit > 0 && promptAll > hit ? promptAll - hit : 0);
    const reported =
        has(usageRaw, 'prompt_cache_hit_tokens')
        || has(usageRaw, 'prompt_cache_miss_tokens')
        || has(usageRaw, 'cached_tokens')
        || has(usageRaw, 'cache_read_input_tokens')
        || has(nested, 'cached_tokens');
    return { hit, miss, reported };
}

function mergeUsage(a?: CompletionUsage, b?: CompletionUsage): CompletionUsage | undefined {
    if (!a && !b) return undefined;
    if (!a) return b;
    if (!b) return a;
    return {
        prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
        completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
        total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
        prompt_cache_hit_tokens: (a.prompt_cache_hit_tokens || 0) + (b.prompt_cache_hit_tokens || 0) || undefined,
        prompt_cache_miss_tokens: (a.prompt_cache_miss_tokens || 0) + (b.prompt_cache_miss_tokens || 0) || undefined,
        cache_fields_reported: Boolean(a.cache_fields_reported || b.cache_fields_reported) || undefined,
    };
}

/** 对话请求墙钟超时：NIM 大模型（尤其 DeepSeek V4）冷启动/排队更慢 */
export function resolveChatCompletionTimeoutMs(vendor: string): number {
    return vendor === 'nvidia' ? 180_000 : 90_000;
}

export interface UpstreamTextResponse {
    ok: boolean;
    status: number;
    headers: Headers;
    text: string;
}

/**
 * 单次上游请求：**同一个截止时间既覆盖 fetch，也覆盖响应体读取**。
 *
 * 为什么必须覆盖读体：原实现拿到响应头就 clearTimeout，随后 `await resp.text()` 再无
 * 任何超时/中止。中转站「先返头、body 挂着不结束」时这个 await 永不 settle，
 * flushChat 的 busyChats 会一直为真（`smart-chat-flush.ts` 的并发门），
 * 于是该会话此后每条消息都只入缓冲、永不回复，只能重启进程。
 *
 * 注意：init.signal 会被本函数的 controller 覆盖（调用方不需要自带 signal）。
 * 导出供验收脚本直接断言「body 卡住会被截止时间中止」。
 */
export async function fetchTextWithDeadline(
    url: string,
    init: Omit<RequestInit, 'signal'>,
    timeoutMs: number,
): Promise<UpstreamTextResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        Math.max(1000, Number(timeoutMs) || 90_000),
    );
    try {
        const resp = await fetch(url, { ...init, signal: controller.signal });
        // 仍在同一个中止器窗口内：body 卡住会被 abort，抛 AbortError 交给上层重试/报错
        const text = await resp.text();
        return { ok: resp.ok, status: resp.status, headers: resp.headers, text };
    } finally {
        clearTimeout(timer);
    }
}

function isNvidiaDeepSeekV4(model: string): boolean {
    const m = String(model || '').toLowerCase();
    return m.includes('deepseek-v4') || m.includes('deepseek-ai/deepseek-v4');
}

function openAiToolsToAnthropic(tools: unknown[] | undefined): unknown[] | undefined {
    if (!tools?.length) return undefined;
    const out: unknown[] = [];
    for (const raw of tools) {
        if (!raw || typeof raw !== 'object') continue;
        const t = raw as { type?: string; function?: Record<string, unknown> };
        const fn = t.function && typeof t.function === 'object' ? t.function : (raw as Record<string, unknown>);
        const name = String(fn.name || '').trim();
        if (!name) continue;
        const params = fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} };
        out.push({
            name,
            description: String(fn.description || '').trim() || name,
            input_schema: params,
        });
    }
    return out.length ? out : undefined;
}

function convertMessagesToAnthropic(messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    const pendingToolResults: unknown[] = [];

    const flushToolResults = () => {
        if (!pendingToolResults.length) return;
        out.push({ role: 'user', content: [...pendingToolResults] });
        pendingToolResults.length = 0;
    };

    for (const m of messages) {
        if (m.role === 'tool') {
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: String(m.tool_call_id || ''),
                content: String(m.content || ''),
            });
            continue;
        }
        flushToolResults();
        if (m.role === 'assistant') {
            const blocks: unknown[] = [];
            const text = String(m.content ?? '').trim();
            if (text) blocks.push({ type: 'text', text });
            const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
            for (const tc of calls) {
                let input: Record<string, unknown> = {};
                try {
                    input = JSON.parse(String(tc.function?.arguments || '{}'));
                } catch {
                    input = {};
                }
                blocks.push({
                    type: 'tool_use',
                    id: String(tc.id || ''),
                    name: String(tc.function?.name || ''),
                    input,
                });
            }
            if (!blocks.length) blocks.push({ type: 'text', text: '' });
            out.push({ role: 'assistant', content: blocks });
            continue;
        }
        const role = String(m.role || 'user');
        if (role === 'system') continue;
        out.push({ role, content: String(m.content ?? '') });
    }
    flushToolResults();
    return out;
}

function parseAnthropicResponse(data: Record<string, unknown>): CompletionResult {
    const blocks = Array.isArray(data.content) ? data.content : [];
    let content = '';
    let reasoning = '';
    const tool_calls: ToolCallResult[] = [];
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        const type = String(b.type || '');
        if (type === 'text') content += String(b.text ?? '');
        if (type === 'thinking' || type === 'redacted_thinking') {
            reasoning += String(b.thinking ?? b.text ?? '');
        }
        if (type === 'tool_use') {
            tool_calls.push({
                id: String(b.id || ''),
                type: 'function',
                function: {
                    name: String(b.name || ''),
                    arguments: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}),
                },
            });
        }
    }
    const usageRaw = data.usage as Record<string, number> | undefined;
    const usage: CompletionUsage | undefined = usageRaw
        ? {
              prompt_tokens: Number(usageRaw.input_tokens || 0),
              completion_tokens: Number(usageRaw.output_tokens || 0),
              total_tokens: Number(usageRaw.input_tokens || 0) + Number(usageRaw.output_tokens || 0),
          }
        : undefined;
    return normalizeCompletionTools({
        ok: true,
        content: content.trim(),
        reasoning: reasoning.trim() || undefined,
        tool_calls: tool_calls.length ? tool_calls : undefined,
        usage,
    });
}

async function chatCompletionAnthropic(
    config: SmartChatConfig,
    systemPrompt: string,
    messages: ChatMessage[],
    options?: { tools?: unknown[]; tool_choice?: string | object },
): Promise<CompletionResult> {
    const apiKey = String(config.api_key || '').trim();
    if (!apiKey) return { ok: false, error: 'api_key_not_configured' };

    const preset = resolveChatPreset(config);
    const protocol = resolveApiProtocol(config);
    /**
     * 自定义线路没填 chat_path 时不能把请求打到裸 base_url：
     * 那样 URL 少一层路径，上游多半回空 body（表现为 `invalid_json: `），
     * 而错误信息里看不出「地址拼错了」。回落协议默认路径。
     */
    const path = preset.custom
        ? (String(preset.chat_path || '').trim() || resolveEffectiveChatPath('', protocol))
        : resolveEffectiveChatPath(preset.chat_path, protocol);
    const url = buildChatUrl(config.base_url, path);
    const anthropicMessages = convertMessagesToAnthropic(messages);
    const body: Record<string, unknown> = {
        model: config.model,
        system: systemPrompt,
        messages: anthropicMessages,
        max_tokens: Math.max(64, Number(config.max_tokens) || 2048),
        temperature: config.temperature,
    };
    const tools = openAiToolsToAnthropic(options?.tools as unknown[] | undefined);
    if (tools?.length) {
        body.tools = tools;
        body.tool_choice = { type: 'auto' };
    }

    try {
        const timeoutMs = resolveChatCompletionTimeoutMs(String(config.vendor || ''));
        const maxAttempts = 3;
        let resp: UpstreamTextResponse | undefined;
        let lastErrText = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                resp = await fetchTextWithDeadline(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': ANTHROPIC_API_VERSION,
                    },
                    body: JSON.stringify(body),
                }, timeoutMs);
            } catch (fetchErr) {
                // 网络错误/超时/body 卡死：短退避后重试（中转站抽风常见）
                if (attempt < maxAttempts) {
                    await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
                    continue;
                }
                throw fetchErr;
            }
            if (resp.ok || !isRetryableStatus(resp.status) || attempt >= maxAttempts) break;
            lastErrText = `HTTP ${resp.status}`;
            await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
        }
        if (!resp) return { ok: false, error: lastErrText || 'empty_response' };
        const text = resp.text;
        let data: Record<string, unknown> = {};
        try {
            data = JSON.parse(text);
        } catch {
            return { ok: false, error: `invalid_json: ${text.slice(0, 200)}`, raw: text.slice(0, 4000) };
        }
        if (!resp.ok) {
            const errObj = data.error as { message?: string } | undefined;
            const errMsg = errObj?.message || text.slice(0, 300) || lastErrText;
            return {
                ok: false,
                error: `HTTP ${resp.status}: ${errMsg}`,
                status: resp.status,
                raw: text.slice(0, 4000),
            };
        }
        return parseAnthropicResponse(data);
    } catch (e) {
        const name = e?.name || '';
        const msg = e?.message || String(e);
        if (name === 'AbortError' || /aborted/i.test(msg)) {
            return { ok: false, error: 'upstream_timeout' };
        }
        return { ok: false, error: msg };
    }
}

async function chatCompletionOpenAI(
    config: SmartChatConfig,
    systemPrompt: string,
    messages: ChatMessage[],
    options?: { tools?: unknown[]; tool_choice?: string | object },
): Promise<CompletionResult> {
    const apiKey = String(config.api_key || '').trim();
    if (!apiKey) return { ok: false, error: 'api_key_not_configured' };

    const vendorRaw = String(config.vendor || '');
    const vendor = isBuiltinVendorId(vendorRaw)
        ? vendorRaw
        : normalizeSmartChatVendor(vendorRaw, config.base_url);
    const preset = resolveChatPreset(config);
    const protocol = resolveApiProtocol(config);
    // 自定义线路空 chat_path：回落协议默认路径（否则请求会打到裸 base_url，上游回空 body）
    const path = preset.custom
        ? (String(preset.chat_path || '').trim() || resolveEffectiveChatPath('/v1/chat/completions', protocol))
        : resolveEffectiveChatPath(preset.chat_path || '/v1/chat/completions', protocol);
    const url = buildChatUrl(config.base_url, path);
    const body: Record<string, unknown> = {
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        stream: false,
    };
    if (vendor === 'nvidia' && isBuiltinVendorId(vendorRaw)) {
        // 群聊默认关 thinking：NIM DeepSeek V4 的 reasoning_effort 默认 high，不关会拖到超时
        body.top_p = 0.95;
        body.chat_template_kwargs = { thinking: false, enable_thinking: false };
        if (isNvidiaDeepSeekV4(String(config.model || ''))) {
            body.reasoning_effort = 'none';
        }
    }
    if (options?.tools?.length) {
        body.tools = options.tools;
        body.tool_choice = options.tool_choice ?? 'auto';
    }

    try {
        const timeoutMs = resolveChatCompletionTimeoutMs(vendor);
        const maxAttempts = 3;
        let lastErrText = '';
        let resp: UpstreamTextResponse | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                resp = await fetchTextWithDeadline(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify(body),
                }, timeoutMs);
            } catch (fetchErr) {
                if (attempt < maxAttempts) {
                    await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
                    continue;
                }
                throw fetchErr;
            }
            if (resp.ok || !isRetryableStatus(resp.status) || attempt >= maxAttempts) break;
            lastErrText = `HTTP ${resp.status}`;
            await new Promise((r) => setTimeout(r, 400 * attempt * attempt));
        }
        if (!resp) return { ok: false, error: lastErrText || 'empty_response' };
        if (vendor === 'nvidia') {
            noteNvidiaRequest(null, {
                headers: resp.headers,
                status: resp.status,
                ok: resp.ok,
                error: resp.ok ? '' : `HTTP ${resp.status}`,
            });
        }
        const text = resp.text;
        let data: Record<string, unknown> = {};
        try {
            data = JSON.parse(text);
        } catch {
            return { ok: false, error: `invalid_json: ${text.slice(0, 200)}`, raw: text.slice(0, 4000) };
        }
        if (!resp.ok) {
            const errMsg = (data?.error as { message?: string })?.message || text.slice(0, 300) || lastErrText;
            return {
                ok: false,
                error: `HTTP ${resp.status}: ${errMsg}`,
                status: resp.status,
                raw: text.slice(0, 4000),
            };
        }
        const choices = data.choices as Array<{
            message?: {
                content?: string | null;
                reasoning?: string | null;
                reasoning_content?: string | null;
                tool_calls?: Array<{
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                }>;
            };
        }> | undefined;
        const msg = choices?.[0]?.message;
        // 只取最终 content；reasoning / reasoning_content 不进群聊，仅捕获供落盘
        const content = String(msg?.content ?? '').trim();
        const reasoning = String(msg?.reasoning ?? msg?.reasoning_content ?? '').trim();
        const rawCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        const tool_calls: ToolCallResult[] = rawCalls
            .filter((c) => c && (c.function?.name || c.id))
            .map((c) => ({
                id: String(c.id || ''),
                type: String(c.type || 'function'),
                function: {
                    name: String(c.function?.name || ''),
                    arguments: String(c.function?.arguments || '{}'),
                },
            }));
        const usageRaw = data.usage as Record<string, unknown> | undefined;
        const cache = extractCacheTokens(usageRaw);
        const usage: CompletionUsage | undefined = usageRaw
            ? {
                  prompt_tokens: Number(usageRaw.prompt_tokens || 0),
                  completion_tokens: Number(usageRaw.completion_tokens || 0),
                  total_tokens: Number(usageRaw.total_tokens || 0),
                  // DeepSeek：命中前缀 token；验收时期望连续闲聊第 2+ 轮 hit ≈ 上轮 prompt
                  prompt_cache_hit_tokens: cache.hit || undefined,
                  prompt_cache_miss_tokens: cache.miss || undefined,
                  cache_fields_reported: cache.reported,
              }
            : undefined;
        return normalizeCompletionTools({
            ok: true,
            content,
            reasoning: reasoning || undefined,
            tool_calls: tool_calls.length ? tool_calls : undefined,
            usage,
        });
    } catch (e) {
        if (vendor === 'nvidia') {
            noteNvidiaRequest(null, { ok: false, error: e?.message || String(e) });
        }
        const name = e?.name || '';
        const msg = e?.message || String(e);
        if (name === 'AbortError' || /aborted/i.test(msg)) {
            return { ok: false, error: 'upstream_timeout' };
        }
        return { ok: false, error: msg };
    }
}

/** 轮替日志里给空载响应用的原因串（含 empty_response 以便与旧日志/兜底一致） */
export const EMPTY_COMPLETION_ERROR = 'empty_response: 上游 200 但无正文无工具调用';

/**
 * HTTP 200 却整体空载：没正文、也没工具调用（只有原生思考同样不可用）。
 * 上游抽风时很常见，对任何调用点都等于白跑一轮 —— 应当和报错一样参与模型轮替。
 */
export function isEmptyCompletion(r: CompletionResult | null | undefined): boolean {
    if (!r?.ok) return false;
    if (r.tool_calls?.length) return false;
    return !String(r.content || '').trim();
}

export async function chatCompletion(
    config: SmartChatConfig,
    systemPrompt: string,
    messages: ChatMessage[],
    options?: { tools?: unknown[]; tool_choice?: string | object },
): Promise<CompletionResult> {
    const once = (cfg: SmartChatConfig): Promise<CompletionResult> => (
        resolveApiProtocol(cfg) === 'anthropic'
            ? chatCompletionAnthropic(cfg, systemPrompt, messages, options)
            : chatCompletionOpenAI(cfg, systemPrompt, messages, options)
    );
    const first = await once(config);
    const firstEmpty = isEmptyCompletion(first);
    if (first.ok && !firstEmpty) return first;
    if (config?.model_rotation_enabled !== true) return first;
    // 上下文触顶交给 compact 重试，换模型只会白烧 token
    if (isContextOverflowError(first.error)) return first;

    // 空载在轮替内部按失败处理：种子结果与每次重试都统一判定，避免「换个模型又空载还算成功」
    const attempt = async (cfg: SmartChatConfig): Promise<CompletionResult> => {
        const r = await once(cfg);
        return isEmptyCompletion(r) ? { ...r, ok: false, error: EMPTY_COMPLETION_ERROR } : r;
    };
    const seed = firstEmpty ? { ...first, ok: false, error: EMPTY_COMPLETION_ERROR } : first;
    const out = await runChatWithRotation(config, seed, attempt);
    if (!firstEmpty) return out;
    if (out.ok) {
        // 空载那一轮的 prompt token 照样计费，并进账单
        out.usage = mergeUsage(first.usage, out.usage);
        return out;
    }
    // 轮替也全空/全失败：还回原始的 200 空载结果，上层既有兜底（贴表情、强制收束、不外发）照旧生效
    return {
        ...first,
        rotation_attempts: out.rotation_attempts,
        rotation_log: out.rotation_log,
    };
}

/** 上游致命错误：不应再连打重试（不含 context overflow，后者可 compact 后重试） */
export function isFatalUpstreamError(err: unknown): boolean {
    if (isContextOverflowError(err)) return false;
    const e = String(err || '');
    return /fetch failed|upstream_timeout|aborted|timeout|econnreset|enotfound|econnrefused|network|no available channel|invalid.*(?:api[- ]?)?key|authentication|unauthorized|401|403|insufficient|余额不足|quota|令牌|token.*invalid|rate.?limit|too many requests|429/i.test(e);
}

/**
 * NIM / OpenAI 兼容：上下文触顶（可 compact 后重试，勿当 fatal）。
 * 样例：Kilo/NIM「You passed N input tokens… context length is only M」
 */
export function isContextOverflowError(err: unknown): boolean {
    const e = String(err || '');
    return /context[_\s-]?length|maximum context|max_model_len|reduce the length of the input|too many tokens|input_tokens|prompt is too long|token limit|context window|exceeds?.*(?:context|token)|maximum input length/i.test(e);
}

/** 给群友看的简短中文报错 */
export function formatSmartChatApiError(err: unknown): string {
    const e = String(err || 'unknown');
    if (/no available channel/i.test(e)) {
        return '当前令牌分组用不了这个模型，请换模型或换有权限的令牌';
    }
    if (/fetch failed|upstream_timeout|timeout|aborted|econnreset|enotfound|econnrefused/i.test(e)) {
        return '上游 API 连不上或超时，请稍后重试，或换深度求索/其它线路';
    }
    if (/authentication|invalid.*(?:api[- ]?)?key|unauthorized|401/i.test(e)) {
        return 'API Key 无效或未授权，请检查密钥';
    }
    if (/insufficient|余额|quota|rate.?limit|429|too many requests/i.test(e)) {
        return '额度或限速不足，请稍后再试（英伟达免费档常见约 40 次/分钟）';
    }
    return e.length > 160 ? `${e.slice(0, 160)}…` : e;
}

export { mergeUsage };
