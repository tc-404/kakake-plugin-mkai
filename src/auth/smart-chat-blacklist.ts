// ---------------------------------------------------------------------------
// 智能对话 · 黑户（全局禁用群 / 用户）
// ---------------------------------------------------------------------------

import type { SmartChatDeps } from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';

export const SMART_CHAT_BLACKLIST_GROUPS = `${SMART_CHAT_ROOT}黑户群.json`;
export const SMART_CHAT_BLACKLIST_USERS = `${SMART_CHAT_ROOT}黑户用户.json`;

export type BlacklistKind = 'group' | 'user';

function fileFor(kind: BlacklistKind): string {
    return kind === 'group' ? SMART_CHAT_BLACKLIST_GROUPS : SMART_CHAT_BLACKLIST_USERS;
}

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function isValidId(id: string): boolean {
    return /^\d{5,15}$/.test(id);
}

export function loadBlacklistIds(deps: SmartChatDeps, kind: BlacklistKind): string[] {
    try {
        const raw = deps.readA?.(fileFor(kind));
        if (!raw) return [];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        const out: string[] = [];
        const seen = new Set<string>();
        for (const item of parsed) {
            const id = normalizeId(item);
            if (!isValidId(id) || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
        return out;
    } catch {
        return [];
    }
}

export function saveBlacklistIds(deps: SmartChatDeps, kind: BlacklistKind, ids: string[]): string[] {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const item of ids) {
        const id = normalizeId(item);
        if (!isValidId(id) || seen.has(id)) continue;
        seen.add(id);
        cleaned.push(id);
    }
    deps.writeA?.(fileFor(kind), JSON.stringify(cleaned, null, 2));
    return cleaned;
}

export function isSmartChatGroupBlacklisted(deps: SmartChatDeps, groupId: string): boolean {
    const id = normalizeId(groupId);
    if (!id) return false;
    return loadBlacklistIds(deps, 'group').includes(id);
}

export function isSmartChatUserBlacklisted(deps: SmartChatDeps, userId: string): boolean {
    const id = normalizeId(userId);
    if (!id) return false;
    return loadBlacklistIds(deps, 'user').includes(id);
}

/** 群黑户 → 整群跳过；用户黑户 → 该用户（群聊/私聊）跳过 */
export function isSmartChatBlacklistedForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    const groupId = normalizeId(event.group_id);
    const userId = normalizeId(event.user_id);
    if (groupId && isSmartChatGroupBlacklisted(deps, groupId)) return true;
    if (userId && isSmartChatUserBlacklisted(deps, userId)) return true;
    return false;
}

export function addBlacklistIds(deps: SmartChatDeps, kind: BlacklistKind, ids: string[]): string[] {
    const cur = loadBlacklistIds(deps, kind);
    return saveBlacklistIds(deps, kind, [...cur, ...ids]);
}

export function removeBlacklistIds(deps: SmartChatDeps, kind: BlacklistKind, ids: string[]): string[] {
    const drop = new Set(ids.map(normalizeId).filter(Boolean));
    const cur = loadBlacklistIds(deps, kind).filter((id) => !drop.has(id));
    return saveBlacklistIds(deps, kind, cur);
}
