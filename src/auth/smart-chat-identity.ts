// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 登录身份缓存（昵称只拉一次，落盘 identity.json）
// ---------------------------------------------------------------------------

import type { SmartChatDeps } from './smart-chat-types';
import { DEFAULT_PERSONA_LINE, SMART_CHAT_ROOT } from './smart-chat-types';

export const SMART_CHAT_IDENTITY_FILE = `${SMART_CHAT_ROOT}identity.json`;

/** system_prompt 里替换用的占位符 */
export const BOT_NICK_PLACEHOLDER = '{{BOT_NICK}}';

/** 尚未拉到有效昵称时的兜底称呼（避免继续写死 MK） */
export const BOT_NICK_FALLBACK = '群友';

export interface SmartChatBotIdentity {
    user_id: string;
    nickname: string;
    /** ISO 时间：首次成功写入 */
    fetched_at: string;
}

let memory: SmartChatBotIdentity | null = null;
/** 进行中的拉取；并发 ensure 共用同一 Promise */
let inflight: Promise<SmartChatBotIdentity | null> | null = null;

function extractPayload(raw: unknown): Record<string, unknown> | null {
    if (raw == null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.data != null && typeof o.data === 'object' && (o.retcode != null || o.status != null)) {
        return o.data as Record<string, unknown>;
    }
    return o;
}

function normalizeNick(raw: unknown): string {
    return String(raw ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
}

function isValidIdentity(row: SmartChatBotIdentity | null | undefined): row is SmartChatBotIdentity {
    return Boolean(row && normalizeNick(row.nickname));
}

export function readBotIdentity(deps: SmartChatDeps): SmartChatBotIdentity | null {
    if (isValidIdentity(memory)) return memory;
    try {
        const raw = deps.readA(SMART_CHAT_IDENTITY_FILE);
        if (!raw) return null;
        const parsed = JSON.parse(String(raw));
        const nickname = normalizeNick(parsed?.nickname);
        if (!nickname) return null;
        const row: SmartChatBotIdentity = {
            user_id: String(parsed?.user_id ?? '').trim(),
            nickname,
            fetched_at: String(parsed?.fetched_at || new Date().toISOString()),
        };
        memory = row;
        return row;
    } catch {
        return null;
    }
}

export function writeBotIdentity(deps: SmartChatDeps, row: SmartChatBotIdentity): void {
    const nickname = normalizeNick(row.nickname);
    if (!nickname) return;
    const next: SmartChatBotIdentity = {
        user_id: String(row.user_id || '').trim(),
        nickname,
        fetched_at: String(row.fetched_at || new Date().toISOString()),
    };
    memory = next;
    try {
        deps.writeA(SMART_CHAT_IDENTITY_FILE, JSON.stringify(next, null, 2));
    } catch (e) {
        deps.logger?.warn?.('[智能对话] 写入 identity.json 失败:', e?.message || e);
    }
}

/** 同步读取：文件 / 内存里的昵称；没有则兜底 */
export function getBotNickname(deps: SmartChatDeps): string {
    const row = readBotIdentity(deps);
    return row?.nickname || BOT_NICK_FALLBACK;
}

/** 同步读取本账号 QQ（identity.json）；拿不到返回空串。用于把「自己」从人物记忆里排除。 */
export function getBotUserId(deps: SmartChatDeps): string {
    const row = readBotIdentity(deps);
    const uid = String(row?.user_id || '').trim();
    return /^\d{5,15}$/.test(uid) ? uid : '';
}

/**
 * 确保已有有效昵称：有缓存则直接返回；否则 get_login_info 一次并落盘。
 * 全程共用 inflight，避免并发重复请求。
 */
export async function ensureBotIdentity(deps: SmartChatDeps): Promise<SmartChatBotIdentity | null> {
    const cached = readBotIdentity(deps);
    if (cached) return cached;
    if (inflight) return inflight;

    inflight = (async () => {
        if (typeof deps.botApi !== 'function') {
            deps.logger?.warn?.('[智能对话] 无 botApi，无法拉取登录昵称');
            return null;
        }
        try {
            const raw = await deps.botApi('get_login_info', {});
            const data = extractPayload(raw) || {};
            const nickname = normalizeNick(
                data.nickname ?? data.user_name ?? data.nick ?? data.name,
            );
            const user_id = String(data.user_id ?? data.uin ?? data.qq ?? '').trim();
            if (!nickname) {
                deps.logger?.warn?.('[智能对话] get_login_info 无有效 nickname');
                return null;
            }
            const row: SmartChatBotIdentity = {
                user_id,
                nickname,
                fetched_at: new Date().toISOString(),
            };
            writeBotIdentity(deps, row);
            deps.logger?.info?.(
                `[智能对话] 已缓存登录昵称「${nickname}」→ identity.json`,
            );
            return row;
        } catch (e) {
            deps.logger?.warn?.('[智能对话] get_login_info 失败:', e?.message || e);
            return null;
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

/**
 * 把 prompt 里的 {{BOT_NICK}} / 旧版硬编码「MK」称呼换成真实昵称。
 * 仅替换常见人设槽位，避免误伤正文里偶然出现的 MK 插件名讨论。
 */
export function applyBotNickToSystemPrompt(prompt: string, nickname: string): string {
    const nick = normalizeNick(nickname) || BOT_NICK_FALLBACK;
    let s = String(prompt || '');
    if (s.includes(BOT_NICK_PLACEHOLDER)) {
        s = s.split(BOT_NICK_PLACEHOLDER).join(nick);
    }
    s = s.replace(/老成员「MK」/g, `「${nick}」`);
    s = s.replace(/群友「MK」/g, `「${nick}」`);
    s = s.replace(/熟人「MK」/g, `「${nick}」`);
    s = s.replace(/名字就叫 MK/g, `名字就叫 ${nick}`);
    // 兼容旧稿「老成员「昵称」」→「「昵称」」（资历改走 host-state）
    s = s.replace(/老成员「([^」]+)」/g, '「$1」');
    return s;
}

/** 供 WebUI「恢复默认」：已解析昵称的【你是谁】定义句 */
export function resolvedDefaultSystemPrompt(deps?: SmartChatDeps | null): string {
    const nick = deps ? getBotNickname(deps) : BOT_NICK_FALLBACK;
    return applyBotNickToSystemPrompt(DEFAULT_PERSONA_LINE, nick);
}
