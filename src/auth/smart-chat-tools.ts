// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — Function Calling 工具（web_search / web_fetch）
// ---------------------------------------------------------------------------

import dns from 'dns/promises';
import net from 'net';
import type { SmartChatConfig, SmartChatWebSearchKeys } from './smart-chat-types';
import { SPILL_INLINE_HEAD_CHARS, SPILL_THRESHOLD_CHARS } from './smart-chat-file';

export type WebSearchProviderId = 'tavily' | 'serper' | 'bocha';

export const WEB_SEARCH_PROVIDER_META: Record<
    WebSearchProviderId,
    {
        label: string;
        keyUrls: string[];
        notes: string;
        /** 测试是否可能消耗搜索额度 */
        testMayConsume: boolean;
    }
> = {
    tavily: {
        label: 'Tavily',
        keyUrls: ['https://app.tavily.com/home', 'https://docs.tavily.com'],
        notes: '控制台复制 API Key（tvly-…）；免费档每月有额度。',
        testMayConsume: true,
    },
    serper: {
        label: 'Serper',
        keyUrls: ['https://serper.dev'],
        notes: '登录 Dashboard → API Key 复制。',
        testMayConsume: true,
    },
    bocha: {
        label: '博查',
        keyUrls: [
            'https://open.bochaai.com/api-keys',
            'https://open.bochaai.com/',
            'https://open.bochaai.com/recharge',
        ],
        notes: '开放平台创建 Key；预付费，无余额会失败。',
        testMayConsume: true,
    },
};

/** 稳定、固定字节的 tools schema（写入请求时勿改动描述文案） */
export const SMART_CHAT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the public web for up-to-date information. Returns titles, URLs and snippets.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    max_results: { type: 'integer', description: 'Max results 1-8', minimum: 1, maximum: 8 },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: 'Fetch a public http(s) URL and return readable text content.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Absolute http(s) URL' },
                },
                required: ['url'],
            },
        },
    },
] as const;

/** 联网开启时追加到 system（固定文案；是否挂载由分聊天「联网」开关决定） */
export const TOOLS_SYSTEM_SUFFIX =
    '\n\n[联网工具]\n' +
    '可用 web_search / web_fetch（公网搜索/抓网页）。host-state 写「联网已开启」时你就能用。\n' +
    '优先级：脚本工具 mkapi_* 能解决的，禁止用联网；只有脚本解决不了的公网事实才 web_search。\n' +
    '查 QQ 群号、群是否存在、群名/群主/人数等：只调 mkapi_001，不要 web_search（宿主会拒掉这类网页搜）。\n' +
    '何时搜：公网拿不准的新鲜事实——档期/开服/版本/官宣/「会出什么」「最新怎样」这类别靠印象瞎答。\n' +
    '纯闲聊接梗、纯态度、纯抬杠：能接就别搜。\n' +
    '例外：群里冒出一个你不认识的新梗/黑话/缩写，别硬接也别编，可以搜一句再回（说「我查查」就必须真出 tool_calls）。\n' +
    '怎么做人：别空口装懂，别编假出处（「刚刷了公告/社区」却没调工具）；搜不到就直说不确定或只聊态度。\n' +
    '别把传闻说成已官宣，别把猜测说成板上钉钉——别误导人。\n' +
    '真要核实就自己出 tool_calls，再根据回灌说话；禁止空口「我查查/我去搜」撑场——那不是在用工具。\n' +
    '本回合最终若没有 tool 回灌：禁止假装查过，也禁止据此写可执行教程/配置步骤。\n' +
    '需要工具或二次续写时：同轮可用一句很短的 <status>…</status>（只给宿主看日志）；禁止在 status/正文里写 mkapi_*/web_search/工具计划；禁止把「用户要…」「调 xxx 查…」这种内心独白发到群。\n' +
    '搜到/查到当素材：用群友八卦口吻说一两句要点就停；别念「查到了，群号是…人数是…介绍里写着…」报表腔，别堆协议名/安装步骤。\n' +
    '别把调用原文、工具名、status 计划贴进群。\n';

/** 查询像在搜 QQ 群号/群资料 → 应改走 mkapi，不应网页搜 */
export function looksLikeQqGroupWebQuery(query: string): boolean {
    const q = String(query || '').trim();
    if (!q) return false;
    const gid = q.match(/\b(\d{5,12})\b/);
    if (!gid) return false;
    if (/群|qq\s*群|群号|群名|群主|group\s*id|groupid|查群|搜群/i.test(q)) return true;
    // 整段几乎就是一个群号
    if (/^\d{5,12}$/.test(q.replace(/\s+/g, ''))) return true;
    return false;
}

export function extractGroupIdFromQuery(query: string): string {
    const m = String(query || '').match(/\b(\d{5,12})\b/);
    return m ? m[1] : '';
}

/** @deprecated 不再用词表强制搜索；保留空实现以免外部引用报错 */
export function detectSearchIntent(_text: string): boolean {
    return false;
}

/** @deprecated 不再用词表侦测空口答应；改由 system 教模型自判 */
export function looksLikeEmptySearchPromise(_content: string): boolean {
    return false;
}

export function buildToolChoice(forceSearch: boolean): string | object {
    if (forceSearch) {
        return { type: 'function', function: { name: 'web_search' } };
    }
    return 'auto';
}
export interface SearchHit {
    title: string;
    url: string;
    snippet: string;
}

export interface ProviderSearchResult {
    ok: boolean;
    provider: WebSearchProviderId;
    hits?: SearchHit[];
    error?: string;
    /** 测试时：是否可能已扣额度 */
    mayConsumeQuota?: boolean;
}

function clampResults(n: unknown, fallback = 5): number {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(8, Math.max(1, Math.floor(v)));
}

/** 已配置的搜索源（无固定优先级） */
export function listConfiguredProviders(keys: SmartChatWebSearchKeys | null | undefined): WebSearchProviderId[] {
    const k = keys || ({} as SmartChatWebSearchKeys);
    const out: WebSearchProviderId[] = [];
    if (String(k.tavily_key || '').trim()) out.push('tavily');
    if (String(k.serper_key || '').trim()) out.push('serper');
    if (String(k.bocha_key || '').trim()) out.push('bocha');
    return out;
}

export function hasAnySearchKey(cfg: SmartChatConfig): boolean {
    return listConfiguredProviders(cfg.web_search).length > 0;
}

/** 联网工具是否可挂到本轮：本聊天开关开着，且已配置至少一个搜索 Key */
export function toolsShouldAttach(cfg: SmartChatConfig, chatToolsEnabled: boolean): boolean {
    return Boolean(chatToolsEnabled) && hasAnySearchKey(cfg);
}

function shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function searchTavily(key: string, query: string, maxResults: number): Promise<ProviderSearchResult> {
    try {
        const resp = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
                query,
                max_results: maxResults,
                search_depth: 'basic',
                include_answer: false,
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            return {
                ok: false,
                provider: 'tavily',
                error: String(data?.detail || data?.error || data?.message || `HTTP ${resp.status}`),
                mayConsumeQuota: true,
            };
        }
        const results = Array.isArray(data?.results) ? data.results : [];
        const hits: SearchHit[] = results.slice(0, maxResults).map((r) => ({
            title: String(r?.title || ''),
            url: String(r?.url || ''),
            snippet: String(r?.content || r?.snippet || '').slice(0, 400),
        })).filter((h) => h.url);
        return { ok: true, provider: 'tavily', hits, mayConsumeQuota: true };
    } catch (e) {
        return { ok: false, provider: 'tavily', error: e?.message || String(e), mayConsumeQuota: false };
    }
}

async function searchSerper(key: string, query: string, maxResults: number): Promise<ProviderSearchResult> {
    try {
        const resp = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': key,
            },
            body: JSON.stringify({ q: query, num: maxResults }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            return {
                ok: false,
                provider: 'serper',
                error: String(data?.message || data?.error || `HTTP ${resp.status}`),
                mayConsumeQuota: true,
            };
        }
        const organic = Array.isArray(data?.organic) ? data.organic : [];
        const hits: SearchHit[] = organic.slice(0, maxResults).map((r) => ({
            title: String(r?.title || ''),
            url: String(r?.link || ''),
            snippet: String(r?.snippet || '').slice(0, 400),
        })).filter((h) => h.url);
        return { ok: true, provider: 'serper', hits, mayConsumeQuota: true };
    } catch (e) {
        return { ok: false, provider: 'serper', error: e?.message || String(e), mayConsumeQuota: false };
    }
}

async function searchBocha(key: string, query: string, maxResults: number): Promise<ProviderSearchResult> {
    try {
        const resp = await fetch('https://api.bochaai.com/v1/web-search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
                query,
                count: maxResults,
                summary: true,
                freshness: 'noLimit',
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            return {
                ok: false,
                provider: 'bocha',
                error: String(data?.message || data?.msg || data?.error || `HTTP ${resp.status}`),
                mayConsumeQuota: true,
            };
        }
        const pages =
            data?.data?.webPages?.value ||
            data?.data?.webPages ||
            data?.webPages?.value ||
            data?.results ||
            [];
        const list = Array.isArray(pages) ? pages : [];
        const hits: SearchHit[] = list.slice(0, maxResults).map((r) => ({
            title: String(r?.name || r?.title || ''),
            url: String(r?.url || r?.displayUrl || ''),
            snippet: String(r?.snippet || r?.summary || r?.description || '').slice(0, 400),
        })).filter((h) => h.url);
        return { ok: true, provider: 'bocha', hits, mayConsumeQuota: true };
    } catch (e) {
        return { ok: false, provider: 'bocha', error: e?.message || String(e), mayConsumeQuota: false };
    }
}

async function runOneProvider(
    id: WebSearchProviderId,
    keys: SmartChatWebSearchKeys,
    query: string,
    maxResults: number,
): Promise<ProviderSearchResult> {
    switch (id) {
        case 'tavily':
            return searchTavily(keys.tavily_key, query, maxResults);
        case 'serper':
            return searchSerper(keys.serper_key, query, maxResults);
        case 'bocha':
            return searchBocha(keys.bocha_key, query, maxResults);
        default:
            return { ok: false, provider: id, error: 'unknown_provider' };
    }
}

/**
 * 在已配置源中随机打乱后依次尝试，直到成功。
 */
export async function webSearchWithFailover(
    cfg: SmartChatConfig,
    query: string,
    maxResults = 5,
    logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void },
): Promise<{ ok: boolean; text: string; provider?: WebSearchProviderId; errors?: string[] }> {
    const q = String(query || '').trim();
    if (!q) return { ok: false, text: JSON.stringify({ error: 'empty_query' }) };
    const n = clampResults(maxResults, 5);
    const providers = shuffleInPlace(listConfiguredProviders(cfg.web_search));
    if (!providers.length) {
        return { ok: false, text: JSON.stringify({ error: 'no_search_provider_configured' }) };
    }
    const errors: string[] = [];
    for (const id of providers) {
        const r = await runOneProvider(id, cfg.web_search, q, n);
        if (r.ok && r.hits?.length) {
            const sample = String(r.hits[0]?.title || r.hits[0]?.url || '').slice(0, 80);
            logger?.info?.(
                `[智能对话·联网] web_search 使用 ${id}，命中 ${r.hits.length} 条，首条=${sample || '(无标题)'}`,
            );
            const payload = { provider: id, query: q, results: r.hits };
            return { ok: true, text: JSON.stringify(payload).slice(0, 12000), provider: id };
        }
        if (r.ok && (!r.hits || !r.hits.length)) {
            errors.push(`${id}: empty_results`);
            logger?.warn?.(`[智能对话·联网] ${id} 返回空结果`);
            continue;
        }
        errors.push(`${id}: ${r.error || 'fail'}`);
        logger?.warn?.(`[智能对话·联网] ${id} 失败:`, r.error);
    }
    return {
        ok: false,
        text: JSON.stringify({ error: 'all_providers_failed', errors }),
        errors,
    };
}

export async function testWebSearchProvider(
    cfg: SmartChatConfig,
    provider: WebSearchProviderId,
): Promise<ProviderSearchResult & { meta: (typeof WEB_SEARCH_PROVIDER_META)[WebSearchProviderId] }> {
    const meta = WEB_SEARCH_PROVIDER_META[provider];
    const keys = cfg.web_search;
    const has =
        (provider === 'tavily' && keys.tavily_key) ||
        (provider === 'serper' && keys.serper_key) ||
        (provider === 'bocha' && keys.bocha_key);
    if (!has) {
        return { ok: false, provider, error: 'key_not_configured', mayConsumeQuota: false, meta };
    }
    // 极小搜索：可能消耗 1 次额度
    const r = await runOneProvider(provider, keys, 'ping', 1);
    return { ...r, meta };
}

function isBlockedIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const p = ip.split('.').map(Number);
        if (p[0] === 10) return true;
        if (p[0] === 127) return true;
        if (p[0] === 0) return true;
        if (p[0] === 169 && p[1] === 254) return true;
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT / 云元数据常见段
        return false;
    }
    if (net.isIPv6(ip)) {
        const s = ip.toLowerCase();
        if (s === '::1') return true;
        if (s.startsWith('fc') || s.startsWith('fd')) return true; // ULA
        if (s.startsWith('fe80')) return true;
        return false;
    }
    return true;
}

async function assertSafePublicUrl(rawUrl: string): Promise<string> {
    let u: URL;
    try {
        u = new URL(String(rawUrl || '').trim());
    } catch {
        throw new Error('invalid_url');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol_not_allowed');
    const host = u.hostname;
    if (!host || host === 'localhost' || host.endsWith('.local')) throw new Error('host_blocked');
    if (net.isIP(host)) {
        if (isBlockedIp(host)) throw new Error('ip_blocked');
        return u.toString();
    }
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) throw new Error('dns_failed');
    for (const a of addrs) {
        if (isBlockedIp(a.address)) throw new Error('resolved_ip_blocked');
    }
    return u.toString();
}

function htmlToText(html: string): string {
    let s = String(html || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    s = s.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

export async function webFetchUrl(rawUrl: string): Promise<{ ok: boolean; text: string }> {
    try {
        const safe = await assertSafePublicUrl(rawUrl);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
            const resp = await fetch(safe, {
                method: 'GET',
                redirect: 'follow',
                signal: ctrl.signal,
                headers: {
                    'User-Agent': 'MKBot-SmartChat-WebFetch/1.0',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                },
            });
            const ct = String(resp.headers.get('content-type') || '');
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length > 1_500_000) {
                return { ok: false, text: JSON.stringify({ error: 'body_too_large', status: resp.status }) };
            }
            let body = buf.toString('utf8');
            if (/html/i.test(ct) || /<html/i.test(body.slice(0, 500))) {
                body = htmlToText(body);
            }
            body = body.slice(0, 12000);
            if (!resp.ok) {
                return {
                    ok: false,
                    text: JSON.stringify({ error: `HTTP ${resp.status}`, url: safe, preview: body.slice(0, 500) }),
                };
            }
            return { ok: true, text: JSON.stringify({ url: safe, content: body }) };
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        return { ok: false, text: JSON.stringify({ error: e?.message || String(e) }) };
    }
}

export interface ToolCallLike {
    id: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}

export type ExecuteToolCallsOpts = {
    /** 有则处理 mkapi_* / 误名 MKAPI */
    runMkApi?: (name: string, args: Record<string, unknown>) => Promise<string>;
    /** 有则处理 send_sticker；返回 JSON 字符串给模型 */
    runSendSticker?: (path: string) => Promise<string>;
    /** 有则处理 list_stickers（按情绪查真实文件名）；返回 JSON 字符串给模型 */
    runListStickers?: (emotion: string) => Promise<string> | string;
    /**
     * A③ 有界输出：超过 SPILL_THRESHOLD_CHARS 的工具输出交给它落盘，
     * 返回给模型的「取回指引」；返回空串则退回纯截断。
     * 由 flush 注入（它才有 deps 与群号），工具层本身不碰文件系统。
     */
    spill?: (name: string, text: string, kind: string) => string;
};

/** 超出阈值时：落盘 + 只回头部 + 取回指引；否则原样返回（导出供验收脚本直接断言） */
export function boundToolOutput(
    raw: string,
    opts: ExecuteToolCallsOpts | undefined,
    meta: { name: string; kind: string },
): string {
    const text = String(raw || '');
    if (text.length <= SPILL_THRESHOLD_CHARS || !opts?.spill) return text;
    const head = text.slice(0, SPILL_INLINE_HEAD_CHARS);
    const hint = opts.spill(meta.name, text, meta.kind);
    if (!hint) return text.slice(0, 12000); // 没落盘成功就退回老口径
    return `${head}\n…\n${hint}`;
}

function toolSortRank(name: string): number {
    const n = String(name || '');
    if (/^mkapi/i.test(n) || n === 'MKAPI') return 0;
    if (n === 'list_stickers') return 1;
    if (n === 'send_sticker') return 2;
    return 3;
}

export async function executeToolCalls(
    cfg: SmartChatConfig,
    toolCalls: ToolCallLike[],
    logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void },
    opts?: ExecuteToolCallsOpts,
): Promise<Array<{ role: 'tool'; tool_call_id: string; content: string }>> {
    const out: Array<{ role: 'tool'; tool_call_id: string; content: string }> = [];
    // 同批：脚本 → 表情包 → 联网，避免网页抢先
    const ordered = [...(toolCalls || [])].sort(
        (a, b) => toolSortRank(a?.function?.name) - toolSortRank(b?.function?.name),
    );
    for (const call of ordered) {
        const id = String(call?.id || '');
        const name = String(call?.function?.name || '');
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(String(call?.function?.arguments || '{}'));
        } catch {
            args = {};
        }
        let content = '';
        if (/^mkapi/i.test(name) || name === 'MKAPI') {
            if (opts?.runMkApi) {
                content = await opts.runMkApi(name, args);
            } else {
                content = JSON.stringify({ error: 'mkapi_unavailable', message: '宿主未挂载脚本工具执行器' });
            }
        } else if (name === 'send_sticker') {
            if (opts?.runSendSticker) {
                const p = String(args.path ?? args.file ?? args.sticker ?? '').trim();
                content = await opts.runSendSticker(p);
            } else {
                content = JSON.stringify({ error: 'sticker_unavailable', message: '宿主未挂载表情包发送' });
            }
        } else if (name === 'list_stickers') {
            if (opts?.runListStickers) {
                const emo = String(args.emotion ?? args.keyword ?? args.query ?? '').trim();
                content = await opts.runListStickers(emo);
            } else {
                content = JSON.stringify({ error: 'sticker_unavailable', message: '宿主未挂载表情包查询' });
            }
        } else if (name === 'web_search') {
            const q = String(args.query || '');
            if (looksLikeQqGroupWebQuery(q)) {
                const gid = extractGroupIdFromQuery(q);
                logger?.info?.(`[智能对话·联网] 拒网页搜群号，改指引 mkapi_001 group_id=${gid || '?'}`);
                content = JSON.stringify({
                    error: 'prefer_mkapi',
                    message:
                        '不要用网页搜索查 QQ 群。请立刻改调 mkapi_001，参数 group_id 为群号数字。',
                    group_id: gid || undefined,
                });
            } else {
                const r = await webSearchWithFailover(cfg, q, clampResults(args.max_results, 5), logger);
                content = boundToolOutput(r.text, opts, {
                    name: `websearch-${Date.now().toString(36)}.txt`,
                    kind: '搜索结果',
                });
            }
        } else if (name === 'web_fetch') {
            const r = await webFetchUrl(String(args.url || ''));
            content = boundToolOutput(r.text, opts, {
                name: `webfetch-${Date.now().toString(36)}.txt`,
                kind: '网页正文',
            });
        } else {
            content = JSON.stringify({ error: `unknown_tool:${name}` });
        }
        out.push({ role: 'tool', tool_call_id: id || 'unknown', content: content || '{}' });
    }
    return out;
}
