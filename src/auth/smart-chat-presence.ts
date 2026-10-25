// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 本账号在本群的站位（入群时间 / 群身份）
// 仅群聊、且会话顶层尚无站位数据时拉取一次并锁定；之后不因改名/升降职刷新。
// ---------------------------------------------------------------------------

import type { SmartChatDeps, SmartChatSessionFile } from './smart-chat-types';

const DAY = 24 * 3600;
const MONTH = 30 * DAY;
const THREE_MONTHS = 90 * DAY;

export type BotStanding = '新成员' | '普通群成员' | '老成员';
export type BotRole = 'owner' | 'admin' | 'member';

const ROLE_LABEL: Record<BotRole, string> = {
    owner: '群主',
    admin: '管理员',
    member: '普通成员',
};

function extractPayload(raw: unknown): Record<string, unknown> | null {
    if (raw == null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.data != null && typeof o.data === 'object' && (o.retcode != null || o.status != null)) {
        return o.data as Record<string, unknown>;
    }
    return o;
}

function formatJoinAt(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 入群至今：<1 月新成员；≥1 月普通群成员；≥3 月老成员 */
export function standingFromJoinTime(joinTimeSec: number, nowSec = Math.floor(Date.now() / 1000)): BotStanding {
    const age = Math.max(0, nowSec - Number(joinTimeSec || 0));
    if (age >= THREE_MONTHS) return '老成员';
    if (age >= MONTH) return '普通群成员';
    return '新成员';
}

export function normalizeBotRole(raw: unknown): BotRole {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'owner' || s === '群主') return 'owner';
    if (s === 'admin' || s === 'administrator' || s === '管理员') return 'admin';
    return 'member';
}

export function botRoleLabel(role: BotRole): string {
    return ROLE_LABEL[role] || ROLE_LABEL.member;
}

/** 会话是否已锁定过本群站位（有任一关键字段即视为已有上下文，不再拉） */
export function sessionHasBotPresence(session: SmartChatSessionFile | null | undefined): boolean {
    if (!session) return false;
    if (session.bot_standing) return true;
    if (session.bot_role) return true;
    if (Number(session.bot_join_time) > 0) return true;
    if (String(session.bot_role_label || '').trim()) return true;
    return false;
}

export interface BotPresenceFields {
    bot_join_time?: number;
    bot_join_at?: string;
    bot_role?: BotRole;
    bot_role_label?: string;
    bot_standing?: BotStanding;
    bot_card?: string;
    bot_nickname?: string;
}

/** 把站位写进会话（仅填空槽，不覆盖已有值） */
export function applyBotPresenceOnce(session: SmartChatSessionFile, fields: BotPresenceFields | null | undefined): void {
    if (!fields || sessionHasBotPresence(session)) return;
    if (Number(fields.bot_join_time) > 0) session.bot_join_time = Math.floor(Number(fields.bot_join_time));
    if (fields.bot_join_at) session.bot_join_at = String(fields.bot_join_at);
    if (fields.bot_role) session.bot_role = fields.bot_role;
    if (fields.bot_role_label) session.bot_role_label = String(fields.bot_role_label);
    if (fields.bot_standing) session.bot_standing = fields.bot_standing;
    if (fields.bot_card) session.bot_card = String(fields.bot_card).trim().slice(0, 64);
    if (fields.bot_nickname) session.bot_nickname = String(fields.bot_nickname).trim().slice(0, 64);
}

/**
 * 群聊且会话尚无站位数据时：get_group_member_info(自己) 拉一次并锁定。
 * 私聊 / 已有上下文 / 无 botApi：直接跳过。
 */
export async function ensureSessionBotPresence(
    deps: SmartChatDeps,
    session: SmartChatSessionFile,
    opts: { groupId?: string; selfId?: string },
): Promise<boolean> {
    if (session.chat_type === 'private') return false;
    if (sessionHasBotPresence(session)) return false;
    const groupId = String(opts.groupId || session.group_id || '').trim();
    const selfId = String(opts.selfId || '').trim();
    if (!groupId || !selfId) return false;
    if (typeof deps.botApi !== 'function') {
        deps.logger?.warn?.('[智能对话] 无 botApi，无法拉取本群站位');
        return false;
    }
    try {
        const raw = await deps.botApi('get_group_member_info', {
            group_id: /^\d+$/.test(groupId) ? Number(groupId) : groupId,
            user_id: /^\d+$/.test(selfId) ? Number(selfId) : selfId,
        });
        const data = extractPayload(raw);
        if (!data) {
            deps.logger?.warn?.('[智能对话] get_group_member_info 无数据，站位未锁定');
            return false;
        }
        let joinSec = Number(data.join_time ?? data.joinTime ?? 0);
        if (!Number.isFinite(joinSec) || joinSec <= 0) {
            // 极少数实现用毫秒
            const ms = Number(data.join_time ?? data.joinTime ?? 0);
            if (ms > 1e12) joinSec = Math.floor(ms / 1000);
        }
        const role = normalizeBotRole(data.role);
        const standing = joinSec > 0 ? standingFromJoinTime(joinSec) : '新成员';
        const card = String(data.card ?? data.card_name ?? '').trim();
        const nickname = String(data.nickname ?? data.nick ?? '').trim();
        applyBotPresenceOnce(session, {
            bot_join_time: joinSec > 0 ? joinSec : undefined,
            bot_join_at: joinSec > 0 ? formatJoinAt(joinSec) : undefined,
            bot_role: role,
            bot_role_label: botRoleLabel(role),
            bot_standing: standing,
            bot_card: card || undefined,
            bot_nickname: nickname || undefined,
        });
        deps.logger?.info?.(
            `[智能对话] 已锁定本群站位 group=${groupId} 资历=${standing} 身份=${botRoleLabel(role)}`
            + (joinSec > 0 ? ` 入群=${formatJoinAt(joinSec)}` : ''),
        );
        return sessionHasBotPresence(session);
    } catch (e) {
        deps.logger?.warn?.('[智能对话] get_group_member_info 失败:', (e as Error)?.message || e);
        return false;
    }
}

/** 展示用昵称：会话锁定的群名片/昵称优先，否则回落登录昵称 */
export function resolveSessionBotDisplayNick(
    session: SmartChatSessionFile | null | undefined,
    loginNick: string,
): string {
    const card = String(session?.bot_card || '').trim();
    if (card) return card.slice(0, 64);
    const nick = String(session?.bot_nickname || '').trim();
    if (nick) return nick.slice(0, 64);
    return String(loginNick || '').trim() || '群友';
}
