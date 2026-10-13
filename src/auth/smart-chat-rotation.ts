// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 自动模型轮替（API 报错时自动换模型 / 换厂商重试）
// ---------------------------------------------------------------------------
//
// 三种方式（SmartChatRotationMode）：
// - same_vendor           仅本厂商内轮替：同 key/同地址，拉模型列表随机挑别的模型
// - other_vendor_default  其他厂商模型：换到别的已配好的厂商，只用它自己配置的模型
// - other_vendor_any      其他厂商任意模型：换厂商，且可用该厂商模型列表里的任意模型
//
// 次数上限 model_rotation_limit：0=不限（候选全试完才算失败）；N=最多再试 N 次
// （不分厂商不分模型，累计到 N 次仍失败即判失败）。
//
// 全过程只写日志，绝不改写 config.json —— 会话指纹（smart-chat-fingerprint）
// 因此不变，冻结能力（frozen_system_caps）与会话命名空间都不会被轮替带偏。

import type { SmartChatConfig, SmartChatDeps, SmartChatRotationMode } from './smart-chat-types';
import { normalizeRotationMode } from './smart-chat-config';
import { normalizeApiProtocol, resolveApiProtocol } from './smart-chat-api-url';
import { fetchModelList } from './smart-chat-models';

export const ROTATION_MODE_LABEL: Record<SmartChatRotationMode, string> = {
    same_vendor: '仅本厂商内轮替切换',
    other_vendor_default: '其他厂商模型',
    other_vendor_any: '其他厂商任意模型',
};

let boundDeps: SmartChatDeps | null = null;

/** 运行时绑定 deps，供无显式 deps 的 provider 写日志 */
export function bindRotationDeps(deps: SmartChatDeps | null | undefined): void {
    boundDeps = deps || null;
}

function logLine(line: string, level: 'info' | 'warn' = 'info'): void {
    const text = `[智能对话·轮替] ${line}`;
    const lg = boundDeps?.logger;
    if (level === 'warn' && lg?.warn) {
        lg.warn(text);
        return;
    }
    if (level === 'info' && lg?.info) {
        lg.info(text);
        return;
    }
    try {
        console.log(text);
    } catch {
        /* ignore */
    }
}

function short(err: unknown): string {
    const e = String(err || 'unknown').replace(/\s+/g, ' ').trim();
    return e.length > 120 ? `${e.slice(0, 120)}…` : e;
}

/**
 * key 级致命错误：key 无效 / 未授权 / 余额不足 —— 换模型也没用，只能换厂商。
 * 「no available channel」是令牌分组缺该模型，属模型级，换模型有救，故排除。
 */
export function isKeyLevelFatalError(err: unknown, status?: number): boolean {
    const e = String(err || '');
    if (/no available channel/i.test(e)) return false;
    const st = Number(status);
    if (st === 401 || st === 402) return true;
    return /invalid[^\n]{0,24}key|api[_\s-]?key[^\n]{0,24}(invalid|无效|错误|过期)|unauthorized|authentication|\b401\b|\b402\b|insufficient|余额不足|欠费|arrears|payment required|quota|令牌[^\n]{0,10}(无效|过期|不存在)/i.test(e);
}

/** 模型列表里常混入非对话模型（向量/重排/语音/绘图），先滤掉免得白试 */
const NON_CHAT_MODEL_RE = /embed|rerank|whisper|\btts\b|speech|audio|moderation|dall-?e|flux|stable-?diffusion|\bsd[-_]|midjourney|video|\bbge-|m3e|ocr|image-?gen|text-to-/i;

export function isLikelyChatModel(id: string): boolean {
    const m = String(id || '').trim();
    if (!m) return false;
    return !NON_CHAT_MODEL_RE.test(m);
}

function shuffled<T>(list: T[]): T[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    }
    return a;
}

/** 轮替目标厂商（自定义厂商档案里 key/地址/模型齐全的那些） */
export interface RotationTarget {
    id: string;
    name: string;
    api_key: string;
    base_url: string;
    balance_url?: string;
    model: string;
    temperature?: number;
    max_tokens?: number;
    chat_path?: string;
    api_protocol?: string;
}

const MODEL_CACHE_TTL_MS = 300_000;
const modelListCache = new Map<string, { at: number; models: string[] }>();

export function clearRotationModelCache(): void {
    modelListCache.clear();
}

function modelCacheKey(t: { api_key: string; base_url: string; api_protocol?: string }): string {
    const base = String(t.base_url || '').replace(/\/+$/, '');
    return `${normalizeApiProtocol(t.api_protocol)}|${base}|${String(t.api_key || '').slice(-8)}`;
}

/** 拉取（并缓存 5 分钟）某个 key+地址下的可用对话模型 */
async function listModelsCached(t: {
    name?: string;
    api_key: string;
    base_url: string;
    api_protocol?: string;
    chat_path?: string;
}): Promise<string[]> {
    const key = modelCacheKey(t);
    const hit = modelListCache.get(key);
    if (hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS) return hit.models;
    const r = await fetchModelList({
        api_key: t.api_key,
        base_url: t.base_url,
        api_protocol: t.api_protocol,
        chat_path: t.chat_path,
    });
    if (!r.ok) {
        logLine(`拉取模型列表失败（${t.name || t.base_url}）：${short(r.error)}`, 'warn');
        return [];
    }
    const models = (r.models || []).filter(isLikelyChatModel);
    modelListCache.set(key, { at: Date.now(), models });
    return models;
}

/**
 * 「其他已配置好的厂商」= 自定义厂商档案中 key/地址/模型都填齐的，排除当前在用的那个。
 * 内置厂商不参与：它们没有独立保存的 key（顶层只有一把 key），换过去必然 401。
 */
export function listOtherVendorTargets(config: SmartChatConfig): RotationTarget[] {
    const cur = String(config?.vendor || '').trim();
    const out: RotationTarget[] = [];
    for (const c of config?.custom_vendors || []) {
        const id = String(c?.id || '').trim();
        if (!id || id === cur) continue;
        const api_key = String(c?.api_key || '').trim();
        const base_url = String(c?.base_url || '').trim();
        const model = String(c?.model || '').trim();
        if (!api_key || !base_url || !model) continue;
        const temperature = Number(c?.temperature);
        const max_tokens = Number(c?.max_tokens);
        out.push({
            id,
            name: String(c?.name || id),
            api_key,
            base_url,
            balance_url: c?.balance_url ? String(c.balance_url) : undefined,
            model,
            temperature: Number.isFinite(temperature) ? temperature : undefined,
            max_tokens: Number.isFinite(max_tokens) && max_tokens > 0 ? max_tokens : undefined,
            chat_path: String(c?.chat_path || ''),
            api_protocol: normalizeApiProtocol(c?.api_protocol),
        });
    }
    return out;
}

/** 仅本厂商换模型：只改 model，key/地址/协议全不动 */
function configWithModel(base: SmartChatConfig, model: string): SmartChatConfig {
    const vendor = String(base?.vendor || '');
    const customs = (base.custom_vendors || []).map((c) => (c?.id === vendor ? { ...c, model } : c));
    return { ...base, model, custom_vendors: customs };
}

/** 换厂商：整套 key/地址/协议/参数都用目标厂商档案 */
function configForTarget(base: SmartChatConfig, t: RotationTarget, model: string): SmartChatConfig {
    const customs = (base.custom_vendors || []).map((c) => (c?.id === t.id ? { ...c, model } : c));
    return {
        ...base,
        vendor: t.id,
        api_key: t.api_key,
        base_url: t.base_url,
        balance_url: t.balance_url ?? base.balance_url,
        model,
        temperature: t.temperature ?? base.temperature,
        max_tokens: t.max_tokens ?? base.max_tokens,
        custom_vendors: customs,
    };
}

export interface RotationAttemptResult {
    ok: boolean;
    error?: string;
    status?: number;
}

/**
 * 一次请求失败后按配置轮替重试。
 * @param config    本次使用的配置（含 model_rotation_* 三项）
 * @param first     首次失败的结果（原样保留，轮替全败时返回它）
 * @param attempt   单次请求执行器（provider 传入，不含轮替，避免递归）
 */
export async function runChatWithRotation<T extends RotationAttemptResult>(
    config: SmartChatConfig,
    first: T,
    attempt: (cfg: SmartChatConfig) => Promise<T>,
): Promise<T> {
    const mode: SmartChatRotationMode = normalizeRotationMode(config?.model_rotation_mode);
    const limit = Math.max(0, Math.round(Number(config?.model_rotation_limit) || 0));
    const budget = limit > 0 ? limit : Number.POSITIVE_INFINITY;
    const baseVendor = String(config?.vendor || '') || '当前厂商';
    const baseModel = String(config?.model || '');
    const log: string[] = [];
    let used = 0;

    const push = (line: string, level: 'info' | 'warn' = 'info'): void => {
        log.push(line);
        logLine(line, level);
    };

    function finish(): T {
        if (Number.isFinite(budget) && used >= budget) {
            push(`已达轮替上限 ${limit} 次，仍未成功 → 判定失败`, 'warn');
        } else {
            push('候选已全部试完，轮替失败', 'warn');
        }
        (first as Record<string, unknown>).rotation_attempts = used;
        (first as Record<string, unknown>).rotation_log = [...log];
        return first;
    }

    /** 返回 null = 次数预算已用尽；否则返回本次结果（成功/失败都返回） */
    const tryOne = async (cfg: SmartChatConfig, label: string): Promise<T | null> => {
        if (used >= budget) return null;
        used += 1;
        const r = await attempt(cfg);
        if (r?.ok) {
            push(`第 ${used} 次轮替成功 → ${label}`);
            (r as Record<string, unknown>).rotated_from = `${baseVendor} / ${baseModel}`;
            (r as Record<string, unknown>).rotated_vendor = String(cfg.vendor || '');
            (r as Record<string, unknown>).rotated_model = String(cfg.model || '');
            (r as Record<string, unknown>).rotation_attempts = used;
            (r as Record<string, unknown>).rotation_log = [...log];
            return r;
        }
        push(`第 ${used} 次轮替失败 → ${label}：${short(r?.error)}`, 'warn');
        return r;
    };

    push(
        `触发轮替：方式=${ROTATION_MODE_LABEL[mode]} 次数=${limit > 0 ? `${limit} 次` : '不限'}`
        + ` 原模型=${baseVendor} / ${baseModel} 原因=${short(first?.error)}`,
        'warn',
    );

    if (mode === 'same_vendor') {
        if (isKeyLevelFatalError(first?.error, first?.status)) {
            push('该错误属 key 无效/额度不足，同厂商换模型无意义 → 直接判定失败', 'warn');
            (first as Record<string, unknown>).rotation_log = [...log];
            return first;
        }
        const models = await listModelsCached({
            name: baseVendor,
            api_key: String(config.api_key || ''),
            base_url: String(config.base_url || ''),
            api_protocol: resolveApiProtocol(config),
        });
        const pool = shuffled(models.filter((m) => m && m !== baseModel));
        if (!pool.length) {
            push('本厂商没有其他可用模型 → 判定失败', 'warn');
            (first as Record<string, unknown>).rotation_log = [...log];
            return first;
        }
        for (const m of pool) {
            const r = await tryOne(configWithModel(config, m), `${baseVendor} / ${m}`);
            if (!r) break;
            if (r.ok) return r;
            if (isKeyLevelFatalError(r.error, r.status)) {
                push('已确认是 key 级错误，停止同厂商轮替', 'warn');
                break;
            }
        }
        return finish();
    }

    const targets = shuffled(listOtherVendorTargets(config));
    if (!targets.length) {
        push('没有其他可用厂商（自定义厂商需填齐 Key/地址/模型）→ 判定失败', 'warn');
        (first as Record<string, unknown>).rotation_log = [...log];
        return first;
    }

    if (mode === 'other_vendor_default') {
        for (const t of targets) {
            const r = await tryOne(configForTarget(config, t, t.model), `${t.name} / ${t.model}`);
            if (!r) break;
            if (r.ok) return r;
        }
        return finish();
    }

    // other_vendor_any：先用该厂商配置的模型，再随机试它列表里的其他模型
    for (const t of targets) {
        if (used >= budget) break;
        const head = await tryOne(configForTarget(config, t, t.model), `${t.name} / ${t.model}`);
        if (!head) break;
        if (head.ok) return head;
        if (isKeyLevelFatalError(head.error, head.status)) {
            push(`${t.name} 的 Key 无效/额度不足 → 跳过该厂商`, 'warn');
            continue;
        }
        const models = await listModelsCached(t);
        const pool = shuffled(models.filter((m) => m && m !== t.model));
        if (!pool.length) {
            push(`${t.name} 没有其他可选模型 → 换下一个厂商`);
            continue;
        }
        let exhausted = false;
        for (const m of pool) {
            const r = await tryOne(configForTarget(config, t, m), `${t.name} / ${m}`);
            if (!r) {
                exhausted = true;
                break;
            }
            if (r.ok) return r;
            if (isKeyLevelFatalError(r.error, r.status)) {
                push(`${t.name} 出现 Key 级错误 → 跳过该厂商剩余模型`, 'warn');
                break;
            }
        }
        if (exhausted) break;
    }
    return finish();
}
