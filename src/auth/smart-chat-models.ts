// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 拉取上游模型列表（OpenAI 兼容 / Anthropic）
// ---------------------------------------------------------------------------

import {
    ANTHROPIC_API_VERSION,
    buildChatUrl,
    normalizeApiProtocol,
    type SmartChatApiProtocol,
} from './smart-chat-api-url';

export interface FetchModelListOpts {
    api_key: string;
    base_url: string;
    api_protocol?: string;
    chat_path?: string;
}

export interface FetchModelListResult {
    ok: boolean;
    models: string[];
    error?: string;
}

function parseModelIds(data: unknown): string[] {
    if (!data || typeof data !== 'object') return [];
    const d = data as Record<string, unknown>;
    const list = Array.isArray(d.data) ? d.data : Array.isArray(d.models) ? d.models : [];
    const ids: string[] = [];
    for (const row of list) {
        if (!row || typeof row !== 'object') continue;
        const id = String((row as { id?: unknown }).id || '').trim();
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

async function fetchJsonModels(url: string, headers: Record<string, string>): Promise<FetchModelListResult> {
    try {
        const resp = await fetch(url, { method: 'GET', headers });
        const text = await resp.text();
        if (!resp.ok) {
            return { ok: false, models: [], error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
        }
        let data: unknown = {};
        try {
            data = JSON.parse(text);
        } catch {
            return { ok: false, models: [], error: 'invalid_json' };
        }
        const models = parseModelIds(data);
        if (!models.length) return { ok: false, models: [], error: 'no_models_in_response' };
        return { ok: true, models };
    } catch (e: unknown) {
        return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
    }
}

async function fetchOpenAiModelList(base: string, apiKey: string): Promise<FetchModelListResult> {
    const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
    const root = String(base || '').trim().replace(/\/+$/, '');
    const tries = [`${root}/v1/models`, `${root}/models`];
    let last: FetchModelListResult = { ok: false, models: [], error: 'no_endpoint' };
    for (const url of tries) {
        const r = await fetchJsonModels(url, headers);
        if (r.ok) return r;
        last = r;
    }
    return last;
}

async function fetchAnthropicModelList(base: string, apiKey: string): Promise<FetchModelListResult> {
    const root = String(base || '').trim().replace(/\/+$/, '');
    const url = `${root}/v1/models`;
    return fetchJsonModels(url, {
        Accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
    });
}

export async function fetchModelList(opts: FetchModelListOpts): Promise<FetchModelListResult> {
    const apiKey = String(opts.api_key || '').trim();
    const base = String(opts.base_url || '').trim();
    if (!apiKey) return { ok: false, models: [], error: 'api_key_not_configured' };
    if (!base) return { ok: false, models: [], error: 'base_url_required' };
    const protocol: SmartChatApiProtocol = normalizeApiProtocol(opts.api_protocol);
    if (protocol === 'anthropic') return fetchAnthropicModelList(base, apiKey);
    return fetchOpenAiModelList(base, apiKey);
}
