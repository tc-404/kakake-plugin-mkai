// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 消息缓冲与防抖
// ---------------------------------------------------------------------------

import type { SmartChatBufferEntry, SmartChatDeps } from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';

interface ChatBufferState {
    pending: SmartChatBufferEntry[];
}

/** 目录/文件名安全段（同 session 侧口径）：id 会拼进路径，禁止任何越界字符 */
function safeSegment(raw: unknown, fallback = 'unknown'): string {
    const s = String(raw ?? '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
    return s || fallback;
}

function bufferPath(chatId: string): string {
    return `${SMART_CHAT_ROOT}buffer/${safeSegment(chatId)}.json`;
}

export function loadChatBuffer(deps: SmartChatDeps, chatId: string): SmartChatBufferEntry[] {
    const raw = deps.readA(bufferPath(chatId));
    if (!raw) return [];
    try {
        const obj = JSON.parse(raw);
        return Array.isArray(obj?.pending) ? obj.pending : [];
    } catch (e) {
        // 以前这里静默返回空数组，紧接着 append 会用 [新条目] 覆盖写 —— 坏文件=旧消息无痕消失。
        // 至少留一条 error 日志，便于事后定位（缓冲本身是暂态数据，不做备份）。
        deps.logger?.error?.(
            `[智能对话] 缓冲文件损坏，按空处理 ${chatId}: ${(e as Error)?.message || e}`,
        );
        return [];
    }
}

export function saveChatBuffer(deps: SmartChatDeps, chatId: string, pending: SmartChatBufferEntry[]): void {
    const payload: ChatBufferState = { pending };
    deps.writeA(bufferPath(chatId), JSON.stringify(payload, null, 2));
}

export function appendChatBuffer(deps: SmartChatDeps, chatId: string, entry: SmartChatBufferEntry): SmartChatBufferEntry[] {
    const pending = loadChatBuffer(deps, chatId);
    pending.push(entry);
    saveChatBuffer(deps, chatId, pending);
    return pending;
}

export function clearChatBuffer(deps: SmartChatDeps, chatId: string): void {
    saveChatBuffer(deps, chatId, []);
}

export function takeChatBuffer(deps: SmartChatDeps, chatId: string): SmartChatBufferEntry[] {
    const pending = loadChatBuffer(deps, chatId);
    saveChatBuffer(deps, chatId, []);
    return pending;
}
