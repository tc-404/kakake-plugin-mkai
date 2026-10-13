// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — API URL / 协议解析（OpenAI 兼容 vs Anthropic Messages）
// ---------------------------------------------------------------------------

import type { SmartChatConfig, SmartChatApiProtocol } from './smart-chat-types';
import { getVendorPreset, isCustomVendorId } from './smart-chat-config';

export type { SmartChatApiProtocol };

export const ANTHROPIC_API_VERSION = '2023-06-01';

export function normalizeApiProtocol(raw: unknown): SmartChatApiProtocol {
    const v = String(raw || '').trim().toLowerCase();
    return v === 'anthropic' ? 'anthropic' : 'openai';
}

/** 拼聊天 endpoint：chat_path 空则仅用 base（完整 endpoint 场景） */
export function buildChatUrl(baseUrl: string, chatPath?: string | null): string {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    const path = String(chatPath ?? '').trim();
    if (!path) return base;
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 内置厂商固定 path；自定义空 path 由 buildChatUrl 处理 */
export function resolveEffectiveChatPath(
    chatPath: string | undefined | null,
    protocol: SmartChatApiProtocol,
): string {
    const p = String(chatPath ?? '').trim();
    if (p) return p;
    return protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
}

export function resolveApiProtocol(config: SmartChatConfig): SmartChatApiProtocol {
    const vendor = String(config?.vendor || '').trim();
    if (isCustomVendorId(vendor)) {
        const c = (config.custom_vendors || []).find((x) => x.id === vendor);
        if (c?.api_protocol) return normalizeApiProtocol(c.api_protocol);
    }
    return 'openai';
}

export function resolveApiProtocolFromOpts(opts: {
    vendor?: string;
    api_protocol?: string;
    custom_vendors?: SmartChatConfig['custom_vendors'];
}): SmartChatApiProtocol {
    if (opts.api_protocol) return normalizeApiProtocol(opts.api_protocol);
    const vendor = String(opts.vendor || '').trim();
    if (isCustomVendorId(vendor)) {
        const c = (opts.custom_vendors || []).find((x) => x.id === vendor);
        if (c?.api_protocol) return normalizeApiProtocol(c.api_protocol);
    }
    return 'openai';
}

export function protocolLabel(protocol: SmartChatApiProtocol): string {
    return protocol === 'anthropic' ? 'Anthropic' : 'OpenAI';
}
