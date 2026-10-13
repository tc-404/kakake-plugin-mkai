// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 余额查询 + 本地 usage 账本（对齐 Reasonix billing）
// ---------------------------------------------------------------------------

import type {
    CompletionUsage,
    SmartChatBalanceResult,
    SmartChatConfig,
    SmartChatDeps,
    SmartChatUsageLedger,
    SmartChatUsageRecord,
} from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';
import {
    getVendorPreset,
    isBuiltinVendorId,
    isCustomVendorId,
    normalizeSmartChatVendor,
    resolveChatPreset,
} from './smart-chat-config';
import {
    ANTHROPIC_API_VERSION,
    buildChatUrl,
    resolveApiProtocolFromOpts,
    resolveEffectiveChatPath,
} from './smart-chat-api-url';
import {
    bindNvidiaRateDeps,
    buildNvidiaBalanceResult,
    noteNvidiaRequest,
    NVIDIA_DEFAULT_RPM,
} from './smart-chat-nvidia-rate';

export { bindNvidiaRateDeps };

const USAGE_FILE = `${SMART_CHAT_ROOT}usage.json`;
const BALANCE_CACHE_MS = 60_000;
/**
 * 余额查询的外部网络超时。
 *
 * 没有它的时候余额请求会**无限期挂住**，而总览页用 Promise.allSettled 等齐所有接口
 * → 整个概览一直转圈（境外 API 在国内尤其常见）。有超时后最坏 6 秒必返回（失败也算结果）。
 */
const BALANCE_FETCH_TIMEOUT_MS = 6_000;
const HCNSEC_QUOTA_PER_UNIT = 500_000;
const HCNSEC_USD_CNY = 7.3;

let balanceCache: { at: number; data: SmartChatBalanceResult } | null = null;
/**
 * 同一时刻正在飞行中的余额请求。
 *
 * 没有它的时候：后台顶部状态条（useAdminStatus）和总览页（useOverviewController）
 * 会在同一帧内各打一次 `/smart-chat/balance`，缓存都没命中 → 外部 API 被访问两遍，
 * 页面得等**两次**外部往返（串行时更久）。这里做「单飞 + 共享」：
 * 后到的调用直接复用同一个 Promise，外部接口只打一次。
 */
let balanceInFlight: Promise<SmartChatBalanceResult> | null = null;

function emptyLedger(): SmartChatUsageLedger {
    return {
        total_requests: 0,
        total_prompt_tokens: 0,
        total_completion_tokens: 0,
        total_tokens: 0,
        total_cache_hit_tokens: 0,
        total_estimated_cost: 0,
        records: [],
    };
}

export function loadUsageLedger(deps: SmartChatDeps): SmartChatUsageLedger {
    const raw = deps.readA(USAGE_FILE);
    if (!raw) return emptyLedger();
    try {
        const obj = JSON.parse(raw);
        return {
            ...emptyLedger(),
            ...obj,
            records: Array.isArray(obj.records) ? obj.records.slice(-500) : [],
        };
    } catch {
        return emptyLedger();
    }
}

function saveUsageLedger(deps: SmartChatDeps, ledger: SmartChatUsageLedger): void {
    ledger.records = (ledger.records || []).slice(-500);
    deps.writeA(USAGE_FILE, JSON.stringify(ledger, null, 2));
}

function estimateCost(config: SmartChatConfig, usage: CompletionUsage): number {
    const p = Number(config.price_prompt_per_million || 0);
    const c = Number(config.price_completion_per_million || 0);
    if (p <= 0 && c <= 0) return 0;
    return (usage.prompt_tokens / 1_000_000) * p + (usage.completion_tokens / 1_000_000) * c;
}

export function recordUsage(
    deps: SmartChatDeps,
    config: SmartChatConfig,
    chatId: string,
    usage: CompletionUsage,
    modelOverride?: string,
): SmartChatUsageRecord {
    const ledger = loadUsageLedger(deps);
    // 轮替成功时记「实际命中的模型」（provider 回填的 rotated_model），否则记选定模型。
    // 不这样做，后台用量会把每条请求都算到选定模型头上，看不出轮替真相。
    const usedModel = String(modelOverride || '').trim() || config.model;
    const record: SmartChatUsageRecord = {
        at: new Date().toISOString(),
        chatId,
        model: usedModel,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
        prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
        cache_fields_reported: usage.cache_fields_reported,
        estimated_cost: estimateCost(config, usage),
    };
    ledger.total_requests += 1;
    ledger.total_prompt_tokens += record.prompt_tokens;
    ledger.total_completion_tokens += record.completion_tokens;
    ledger.total_tokens += record.total_tokens;
    ledger.total_cache_hit_tokens += record.prompt_cache_hit_tokens || 0;
    ledger.total_estimated_cost += record.estimated_cost || 0;
    ledger.last = record;
    ledger.records.push(record);
    saveUsageLedger(deps, ledger);
    return record;
}

export function getUsageSummary(deps: SmartChatDeps): Record<string, unknown> {
    const ledger = loadUsageLedger(deps);
    const today = new Date().toISOString().slice(0, 10);
    let todayPrompt = 0;
    let todayCompletion = 0;
    let todayTotal = 0;
    let todayCost = 0;
    let todayRequests = 0;
    for (const r of ledger.records || []) {
        if (!r.at || !r.at.startsWith(today)) continue;
        todayPrompt += r.prompt_tokens || 0;
        todayCompletion += r.completion_tokens || 0;
        todayTotal += r.total_tokens || 0;
        todayCost += r.estimated_cost || 0;
        todayRequests += 1;
    }
    const cacheDenom = ledger.total_prompt_tokens || 0;
    const cacheHitRate = cacheDenom > 0 ? Math.round((ledger.total_cache_hit_tokens / cacheDenom) * 10000) / 100 : null;
    let todayCacheHit = 0;
    let todayPromptAll = 0;
    for (const r of ledger.records || []) {
        if (!r.at || !r.at.startsWith(today)) continue;
        todayCacheHit += r.prompt_cache_hit_tokens || 0;
        todayPromptAll += r.prompt_tokens || 0;
    }
    const todayCacheHitRate = todayPromptAll > 0
        ? Math.round((todayCacheHit / todayPromptAll) * 10000) / 100
        : null;
    const last = ledger.last || null;
    const lastHit = last?.prompt_cache_hit_tokens || 0;
    const lastPrompt = last?.prompt_tokens || 0;
    const lastCacheHitRate = lastPrompt > 0 ? Math.round((lastHit / lastPrompt) * 10000) / 100 : null;
    const recent = (ledger.records || []).slice(-20);
    const anyCacheReported = recent.some((r) => r.cache_fields_reported === true)
        || (ledger.records || []).some((r) => r.cache_fields_reported === true);
    const cacheStatus = ledger.total_requests > 0
        ? (anyCacheReported ? 'reported' : 'cache_unsupported')
        : 'unknown';
    return {
        total_requests: ledger.total_requests,
        total_prompt_tokens: ledger.total_prompt_tokens,
        total_completion_tokens: ledger.total_completion_tokens,
        total_tokens: ledger.total_tokens,
        total_cache_hit_tokens: ledger.total_cache_hit_tokens,
        total_estimated_cost: ledger.total_estimated_cost,
        cache_hit_rate_percent: cacheHitRate,
        cache_status: cacheStatus,
        today: {
            requests: todayRequests,
            prompt_tokens: todayPrompt,
            completion_tokens: todayCompletion,
            total_tokens: todayTotal,
            estimated_cost: todayCost,
            cache_hit_tokens: todayCacheHit,
            cache_hit_rate_percent: todayCacheHitRate,
        },
        last: last
            ? {
                ...last,
                cache_hit_rate_percent: lastCacheHitRate,
                cache_status: last.cache_fields_reported ? 'reported' : 'cache_unsupported',
            }
            : null,
    };
}

export function clearBalanceCache(): void {
    balanceCache = null;
    // 在飞的请求也要作废：否则清缓存后的第一次调用会搭上一个「清缓存之前」发起的旧结果
    balanceInFlight = null;
}

/**
 * 从 Base URL 推导中转站常见余额地址：{origin}/api/usage/token
 * 例：https://proxy.example.com/v1 → https://proxy.example.com/api/usage/token
 */
export function deriveRelayBalanceUrl(baseUrl: string): string {
    let raw = String(baseUrl || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
        const u = new URL(raw);
        let path = u.pathname.replace(/\/+$/, '');
        // 去掉常见 API 前缀，落到站点根
        path = path.replace(/\/v1(?:\/chat(?:\/completions)?)?$/i, '');
        path = path.replace(/\/chat\/completions$/i, '');
        u.pathname = `${path}/api/usage/token`.replace(/\/{2,}/g, '/');
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch {
        return '';
    }
}

/** 显式 balance_url → 自定义档案 → 中转站惯例推导 */
export function resolveBalanceUrl(config: SmartChatConfig): string {
    const customs = config.custom_vendors || [];
    const vendor = String(config.vendor || '');
    const preset = getVendorPreset(vendor, customs);
    const explicit = String(config.balance_url || '').trim()
        || String(preset.balance_url || '').trim();
    if (explicit) return explicit;
    if (isCustomVendorId(vendor) || preset.custom) {
        return deriveRelayBalanceUrl(String(config.base_url || preset.base_url || ''));
    }
    return '';
}

function resolveVendor(config: SmartChatConfig) {
    const v = String(config.vendor || '');
    if (isBuiltinVendorId(v)) return v;
    if (isCustomVendorId(v)) return v;
    return normalizeSmartChatVendor(v, config.base_url);
}

function fmtUsd(n: number): string {
    if (!Number.isFinite(n)) return '0';
    return n.toFixed(4);
}

function quotaToUsd(quota: number, unit = HCNSEC_QUOTA_PER_UNIT): number {
    return Number(quota || 0) / unit;
}

/** 解析 NewAPI /api/usage/token 响应为余额卡片数据 */
function parseHcnsecTokenUsage(data: Record<string, unknown>): SmartChatBalanceResult | null {
    const payload = (data?.data && typeof data.data === 'object' ? data.data : data) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') return null;
    const hasTokenFields =
        payload.total_available != null ||
        payload.total_used != null ||
        payload.total_granted != null ||
        payload.object === 'token_usage';
    if (!hasTokenFields) return null;

    const unlimited = Boolean(payload.unlimited_quota);
    const availableQuota = Number(payload.total_available ?? 0);
    const usedQuota = Number(payload.total_used ?? 0);
    const grantedQuota = Number(payload.total_granted ?? (availableQuota + usedQuota));
    const availUsd = unlimited ? 999999 : quotaToUsd(availableQuota);
    const usedUsd = quotaToUsd(usedQuota);
    const totalUsd = unlimited ? 999999 : quotaToUsd(grantedQuota);

    return {
        available: unlimited || availableQuota > 0,
        display: 'hcnsec',
        infos: [
            {
                currency: 'USD',
                // 主显示：剩余额度（USD）；UI 会附带约 ¥
                total_balance: unlimited ? '∞' : fmtUsd(availUsd),
                // 复用字段：已用
                topped_up_balance: fmtUsd(usedUsd),
                // 复用字段：令牌总额度
                granted_balance: unlimited ? '∞' : fmtUsd(totalUsd),
            },
        ],
        meta: {
            token_name: String(payload.name || ''),
            unlimited_quota: unlimited,
            remaining_quota: availableQuota,
            used_quota: usedQuota,
            total_quota: grantedQuota,
            quota_per_unit: HCNSEC_QUOTA_PER_UNIT,
            usd_exchange_rate: HCNSEC_USD_CNY,
        },
        fetched_at: new Date().toISOString(),
    };
}

function parseDeepseekBalance(data: Record<string, unknown>): SmartChatBalanceResult {
    const infos = Array.isArray(data.balance_infos)
        ? data.balance_infos.map((b: Record<string, string>) => ({
              currency: String(b.currency || ''),
              total_balance: String(b.total_balance || '0'),
              granted_balance: String(b.granted_balance || '0'),
              topped_up_balance: String(b.topped_up_balance || '0'),
          }))
        : [];
    return {
        available: Boolean(data.is_available),
        display: 'deepseek',
        infos,
        fetched_at: new Date().toISOString(),
    };
}

function displayForVendor(vendor: string): SmartChatBalanceResult['display'] {
    if (vendor === 'nvidia') return 'nvidia';
    // 自定义 / 中转默认按 NewAPI 卡片语义展示（解析成功后会被 hcnsec/deepseek 覆盖）
    if (isCustomVendorId(vendor)) return 'hcnsec';
    return 'deepseek';
}

async function probeNvidiaModels(config: SmartChatConfig, deps?: SmartChatDeps | null): Promise<SmartChatBalanceResult> {
    const preset = getVendorPreset('nvidia');
    const base = String(config.base_url || preset.base_url).replace(/\/+$/, '');
    const apiKey = String(config.api_key || '').trim();
    if (!apiKey) {
        return {
            ...buildNvidiaBalanceResult(deps),
            available: false,
            error: 'api_key_not_configured',
        };
    }
    try {
        const resp = await fetch(`${base}/models`, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Cache-Control': 'no-cache',
            },
        });
        noteNvidiaRequest(deps, {
            headers: resp.headers,
            status: resp.status,
            ok: resp.ok,
            error: resp.ok ? '' : `HTTP ${resp.status}`,
            countInWindow: false,
        });
        const snap = buildNvidiaBalanceResult(deps);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return {
                ...snap,
                available: false,
                error: `HTTP ${resp.status}: ${text.slice(0, 160)}`,
                fetched_at: new Date().toISOString(),
            };
        }
        return {
            ...snap,
            // 探 models 成功只代表密钥可用；RPM 是否还有余量看 snap.available
            error: undefined,
            fetched_at: new Date().toISOString(),
        };
    } catch (e) {
        noteNvidiaRequest(deps, { ok: false, error: e?.message || String(e), countInWindow: false });
        return {
            ...buildNvidiaBalanceResult(deps),
            available: false,
            error: e?.message || String(e),
            fetched_at: new Date().toISOString(),
        };
    }
}

/**
 * 余额查询的公开入口：缓存命中直接返回；未命中则走「单飞」——同一时刻只允许一个真实请求，
 * 其余调用方共享它的结果。**不要**把去重逻辑写在调用方（WebUI 层），因为顶部状态条和
 * 总览页是两个独立的数据源，只有在这一层收敛才能保证外部 API 真的只被访问一次。
 */
export function fetchBalance(
    config: SmartChatConfig,
    force = false,
    deps?: SmartChatDeps | null,
): Promise<SmartChatBalanceResult> {
    return fetchBalanceCoalesced(config, force, deps);
}

async function fetchBalanceCoalesced(
    config: SmartChatConfig,
    force: boolean,
    deps?: SmartChatDeps | null,
): Promise<SmartChatBalanceResult> {
    const vendor = resolveVendor(config);
    // NVIDIA 走本地限速快照（不产生外部往返），force 时才真探一次 —— 无需单飞保护
    if (vendor === 'nvidia') {
        if (force) return probeNvidiaModels(config, deps);
        return buildNvidiaBalanceResult(deps);
    }

    const url = resolveBalanceUrl(config);
    const apiKey = String(config.api_key || '').trim();
    if (!url) return { available: false, infos: [], error: 'balance_url_not_configured', display: displayForVendor(vendor) };
    if (!apiKey) return { available: false, infos: [], error: 'api_key_not_configured', display: displayForVendor(vendor) };

    const now = Date.now();
    if (force) {
        balanceCache = null;
    } else if (balanceCache && now - balanceCache.at < BALANCE_CACHE_MS) {
        return { ...balanceCache.data, fetched_at: balanceCache.data.fetched_at, error: balanceCache.data.error };
    }

    // 已有同款请求在飞 → 直接搭车，避免重复的外部往返
    if (balanceInFlight) return balanceInFlight;

    const task = requestBalanceOnce(url, apiKey, vendor, now);
    balanceInFlight = task;
    try {
        return await task;
    } finally {
        // 无论成功失败都要清空，否则后续请求会永远复用这个已结束的 Promise
        if (balanceInFlight === task) balanceInFlight = null;
    }
}

/** 真正打外部 API 的那一次请求（含限时与失败入缓存） */
async function requestBalanceOnce(
    url: string,
    apiKey: string,
    vendor: string,
    startedAt: number,
): Promise<SmartChatBalanceResult> {
    // 必须限时：余额查询打的是外部 API，慢/不可达时若不超时会把整个概览页拖住
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), BALANCE_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: 'GET',
            signal: ctl.signal,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Cache-Control': 'no-cache',
            },
        });
        const text = await resp.text();
        if (!resp.ok) {
            const result: SmartChatBalanceResult = {
                available: false,
                infos: [],
                display: displayForVendor(vendor),
                error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
                fetched_at: new Date().toISOString(),
            };
            balanceCache = { at: startedAt, data: result };
            return result;
        }
        const data = JSON.parse(text);
        // NewAPI token_usage 形态仍可自动识别（自定义厂商若指向同类接口）
        const hcn = parseHcnsecTokenUsage(data);
        const result: SmartChatBalanceResult = hcn || parseDeepseekBalance(data);
        if (hcn?.infos[0] && hcn.infos[0].total_balance !== '∞' && hcn.meta) {
            const usd = Number(hcn.infos[0].total_balance);
            if (Number.isFinite(usd)) {
                hcn.meta.approx_cny = (usd * HCNSEC_USD_CNY).toFixed(2);
            }
        }
        balanceCache = { at: startedAt, data: result };
        return result;
    } catch (e) {
        const aborted = (e as { name?: string })?.name === 'AbortError';
        const result: SmartChatBalanceResult = {
            available: false,
            infos: [],
            display: displayForVendor(vendor),
            error: aborted
                ? `余额查询超时（${BALANCE_FETCH_TIMEOUT_MS / 1000} 秒）`
                : (e as Error)?.message || String(e),
            fetched_at: new Date().toISOString(),
        };
        // 超时结果同样入缓存：否则每次进概览页都要再干等一个超时窗口
        balanceCache = { at: startedAt, data: result };
        return result;
    } finally {
        clearTimeout(timer);
    }
}

async function testAnthropicMessages(config: SmartChatConfig): Promise<{ ok: boolean; message: string }> {
    const preset = resolveChatPreset(config);
    const protocol = resolveApiProtocolFromOpts({
        vendor: config.vendor,
        custom_vendors: config.custom_vendors,
        api_protocol: preset.api_protocol,
    });
    const path = preset.custom
        ? preset.chat_path
        : resolveEffectiveChatPath(preset.chat_path, protocol);
    const url = buildChatUrl(String(config.base_url || preset.base_url), path);
    const apiKey = String(config.api_key || '').trim();
    if (!apiKey) return { ok: false, message: 'api_key_not_configured' };
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
            },
            body: JSON.stringify({
                model: config.model || preset.default_model,
                max_tokens: 16,
                messages: [{ role: 'user', content: 'ping' }],
            }),
        });
        const text = await resp.text();
        if (!resp.ok) {
            return { ok: false, message: `HTTP ${resp.status}: ${text.slice(0, 180)}` };
        }
        return { ok: true, message: 'anthropic_messages_ok' };
    } catch (e) {
        return { ok: false, message: e?.message || String(e) };
    }
}

async function testChatCompletions(config: SmartChatConfig): Promise<{ ok: boolean; message: string }> {
    const preset = resolveChatPreset(config);
    const protocol = resolveApiProtocolFromOpts({
        vendor: config.vendor,
        custom_vendors: config.custom_vendors,
        api_protocol: preset.api_protocol,
    });
    if (protocol === 'anthropic') return testAnthropicMessages(config);

    const base = String(config.base_url || preset.base_url).replace(/\/+$/, '');
    const path = preset.custom
        ? preset.chat_path
        : resolveEffectiveChatPath(preset.chat_path || '/v1/chat/completions', protocol);
    const url = buildChatUrl(base, path);
    const apiKey = String(config.api_key || '').trim();
    if (!apiKey) return { ok: false, message: 'api_key_not_configured' };
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: config.model || preset.default_model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 8,
                stream: false,
            }),
        });
        const text = await resp.text();
        if (!resp.ok) {
            return { ok: false, message: `HTTP ${resp.status}: ${text.slice(0, 180)}` };
        }
        return { ok: true, message: 'chat_completions_ok' };
    } catch (e) {
        return { ok: false, message: e?.message || String(e) };
    }
}

/** 自定义厂商「测试访问」：不带插件 system，只发一句「你好」，返回原文供调试框 */
export async function probeChatAccess(opts: {
    api_key?: string;
    base_url?: string;
    model?: string;
    chat_path?: string;
    max_tokens?: number;
    temperature?: number;
    api_protocol?: string;
    vendor?: string;
    custom_vendors?: SmartChatConfig['custom_vendors'];
}): Promise<{
    ok: boolean;
    latency_ms: number;
    status?: number;
    content?: string;
    raw?: string;
    error?: string;
}> {
    const apiKey = String(opts.api_key || '').trim();
    const base = String(opts.base_url || '').trim().replace(/\/+$/, '');
    const model = String(opts.model || '').trim();
    const protocol = resolveApiProtocolFromOpts({
        api_protocol: opts.api_protocol,
        vendor: opts.vendor,
        custom_vendors: opts.custom_vendors,
    });
    const rawPath = opts.chat_path != null ? String(opts.chat_path).trim() : '';
    const path = rawPath || resolveEffectiveChatPath('', protocol);
    if (!apiKey) return { ok: false, latency_ms: 0, error: 'api_key_not_configured' };
    if (!base) return { ok: false, latency_ms: 0, error: 'base_url_required' };
    if (!model) return { ok: false, latency_ms: 0, error: 'model_required' };
    const url = buildChatUrl(base, rawPath);
    const started = Date.now();
    try {
        const maxTok = Math.min(1024, Math.max(16, Number(opts.max_tokens) || 256));
        const temp = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.7;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        };
        let body: Record<string, unknown>;
        if (protocol === 'anthropic') {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = ANTHROPIC_API_VERSION;
            body = {
                model,
                max_tokens: maxTok,
                temperature: temp,
                messages: [{ role: 'user', content: '你好' }],
            };
        } else {
            headers.Authorization = `Bearer ${apiKey}`;
            body = {
                model,
                messages: [{ role: 'user', content: '你好' }],
                max_tokens: maxTok,
                temperature: temp,
                stream: false,
            };
        }
        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        const latency_ms = Date.now() - started;
        const text = await resp.text();
        let content = '';
        try {
            const data = JSON.parse(text);
            if (protocol === 'anthropic') {
                const blocks = Array.isArray(data?.content) ? data.content : [];
                for (const block of blocks) {
                    if (block?.type === 'text') content += String(block.text ?? '');
                }
            } else {
                content = String(data?.choices?.[0]?.message?.content ?? '').trim();
            }
        } catch {
            /* keep raw */
        }
        if (!resp.ok) {
            return {
                ok: false,
                latency_ms,
                status: resp.status,
                raw: text.slice(0, 4000),
                error: `HTTP ${resp.status}: ${text.slice(0, 240)}`,
            };
        }
        return {
            ok: true,
            latency_ms,
            status: resp.status,
            content: content || '(空正文)',
            raw: text.slice(0, 4000),
        };
    } catch (e) {
        return {
            ok: false,
            latency_ms: Date.now() - started,
            error: e?.message || String(e),
        };
    }
}

/**
 * 「连通性测试」= 用当前已保存配置模拟一次真实对话访问（发「你好」，不加载插件 system），
 * 返回模型输出。语义与自定义厂商「测试访问」一致；URL/协议/路径按当前厂商解析。
 */
export async function simulateChatAccess(config: SmartChatConfig, _deps?: SmartChatDeps | null): Promise<{
    ok: boolean;
    latency_ms: number;
    status?: number;
    content?: string;
    raw?: string;
    error?: string;
    model?: string;
}> {
    const preset = resolveChatPreset(config);
    const protocol = resolveApiProtocolFromOpts({
        vendor: config.vendor,
        custom_vendors: config.custom_vendors,
        api_protocol: preset.api_protocol,
    });
    const base = String(config.base_url || preset.base_url).replace(/\/+$/, '');
    const path = preset.custom
        ? preset.chat_path
        : resolveEffectiveChatPath(preset.chat_path || '/v1/chat/completions', protocol);
    const model = String(config.model || preset.default_model || '').trim();
    const r = await probeChatAccess({
        api_key: config.api_key,
        base_url: base,
        model,
        chat_path: path,
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        api_protocol: protocol,
        vendor: config.vendor,
        custom_vendors: config.custom_vendors,
    });
    return { ...r, model };
}

export async function testConnection(config: SmartChatConfig, deps?: SmartChatDeps | null): Promise<{ ok: boolean; message: string }> {
    if (resolveChatPreset(config).custom) {
        return testChatCompletions(config);
    }
    const vendor = resolveVendor(config);
    if (vendor === 'nvidia') {
        const bal = await fetchBalance(config, true, deps);
        if (bal.error && /api_key_not_configured|401|403|unauthorized|invalid/i.test(String(bal.error))) {
            return { ok: false, message: bal.error };
        }
        if (!bal.error || bal.infos?.length) {
            return {
                ok: true,
                message: `nvidia_ok · ~${bal.meta?.rpm_used ?? 0}/${bal.meta?.rpm_limit ?? NVIDIA_DEFAULT_RPM} RPM`,
            };
        }
        const chat = await testChatCompletions(config);
        return chat.ok
            ? { ok: true, message: `chat_ok_models_failed: ${bal.error}` }
            : { ok: false, message: bal.error || chat.message };
    }

    const bal = await fetchBalance(config, true, deps);
    if (bal.infos?.length && !bal.error) {
        return { ok: true, message: bal.available ? 'balance_ok' : 'balance_fetched_but_unavailable' };
    }
    // 余额接口失败时再探对话补全（确认 key / 模型路径可用）
    if (bal.error && /404|not.?found|unexpected/i.test(String(bal.error))) {
        const chat = await testChatCompletions(config);
        if (chat.ok) {
            return {
                ok: true,
                message: bal.error ? `chat_ok_balance_failed: ${bal.error}` : chat.message,
            };
        }
        return { ok: false, message: bal.error || chat.message };
    }
    if (bal.error && !bal.infos.length) {
        return { ok: false, message: bal.error };
    }
    return { ok: true, message: bal.available ? 'balance_ok' : 'balance_fetched_but_unavailable' };
}

export function clearUsageLedger(deps: SmartChatDeps): void {
    saveUsageLedger(deps, emptyLedger());
}
