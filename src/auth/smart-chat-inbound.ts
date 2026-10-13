// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 入站事件元数据（引用 / 艾特 / 群身份，供上下文标注）
// ---------------------------------------------------------------------------
//
// NapCat 上报里 reply 段通常只有 id；被引者 QQ/昵称/正文需：
// 1) 本批缓冲 / 近期会话里按 msgid 反查
// 2) 可选 get_msg 补全
// 当前消息的账号、艾特目标本来就在 event 里。
// 群消息 sender.role → 入站 [群主]/[管理]/[成员]（事实标记，非用户正文）。

import type { SmartChatBufferEntry, SmartChatDeps, SmartChatSessionFile } from './smart-chat-types';

export interface InboundMessageMeta {
    replyToId?: string;
    /** 被引用消息发送者 QQ（能解析到才有） */
    replyToUserId?: string;
    replyToNickname?: string;
    /** 被引用消息正文短摘（给人/模型看楼用） */
    replyToSnippet?: string;
    atQqs: string[];
}

export interface QuoteResolveHint {
    userId?: string;
    nickname?: string;
    snippet?: string;
}

const quoteCache = new Map<string, { at: number; hint: QuoteResolveHint }>();
const QUOTE_CACHE_TTL_MS = 30 * 60 * 1000;
const QUOTE_CACHE_MAX = 200;

function messageSegments(event: Record<string, unknown>): unknown[] {
    const message = event?.message;
    if (Array.isArray(message)) return message;
    if (typeof message === 'object' && message && Array.isArray((message as { message?: unknown }).message)) {
        return (message as { message: unknown[] }).message;
    }
    return [];
}

/** 从 OneBot 消息段提取 reply / at（不依赖 CQ 字符串） */
export function extractInboundMeta(event: Record<string, unknown>): InboundMessageMeta {
    const atQqs: string[] = [];
    let replyToId: string | undefined;
    let replyToUserId: string | undefined;
    let replyToNickname: string | undefined;
    let replyToSnippet: string | undefined;

    for (const seg of messageSegments(event)) {
        if (!seg || typeof seg !== 'object') continue;
        const type = String((seg as { type?: string }).type || '').toLowerCase();
        const data = (seg as { data?: Record<string, unknown> }).data || {};
        if (type === 'reply') {
            const id = String(data.id ?? data.message_id ?? '').trim();
            if (id) replyToId = id;
            // 少数实现会在 reply.data 里带上被引者
            const qq = String(
                data.qq
                ?? data.user_id
                ?? data.sender_id
                ?? (data.sender as { user_id?: unknown })?.user_id
                ?? '',
            ).trim();
            if (qq && /^\d{5,12}$/.test(qq)) replyToUserId = qq;
            const nick = String(
                data.nickname
                ?? data.card
                ?? (data.sender as { nickname?: unknown; card?: unknown })?.nickname
                ?? (data.sender as { nickname?: unknown; card?: unknown })?.card
                ?? '',
            ).trim();
            if (nick) replyToNickname = nick;
            const snip = String(data.text ?? data.content ?? data.message ?? '').trim();
            if (snip) replyToSnippet = snip.slice(0, 48);
        }
        if (type === 'at') {
            const qq = String(data.qq ?? '').trim();
            if (qq && qq !== 'all' && /^\d+$/.test(qq) && !atQqs.includes(qq)) {
                atQqs.push(qq);
            }
        }
    }

    const rawReply = (event as { reply?: unknown }).reply
        || (event as { source?: { message_id?: unknown } }).source?.message_id;
    if (!replyToId && rawReply != null) {
        const id = String(rawReply).trim();
        if (id) replyToId = id;
    }

    return { replyToId, replyToUserId, replyToNickname, replyToSnippet, atQqs };
}

function plainFromSegments(segs: unknown[]): string {
    if (!Array.isArray(segs)) return '';
    const parts: string[] = [];
    for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        const type = String((seg as { type?: string }).type || '').toLowerCase();
        const data = (seg as { data?: Record<string, unknown> }).data || {};
        if (type === 'text') {
            const t = String(data.text ?? '').trim();
            if (t) parts.push(t);
        } else if (type === 'image') {
            parts.push('[图片]');
        } else if (type === 'face') {
            parts.push('[表情]');
        } else if (type === 'at') {
            const qq = String(data.qq ?? '').trim();
            parts.push(qq && qq !== 'all' ? `@${qq}` : '@');
        }
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function rememberQuote(messageId: string, hint: QuoteResolveHint): void {
    const mid = String(messageId || '').trim();
    if (!mid) return;
    if (quoteCache.size >= QUOTE_CACHE_MAX) {
        const oldest = quoteCache.keys().next().value;
        if (oldest) quoteCache.delete(oldest);
    }
    quoteCache.set(mid, { at: Date.now(), hint: { ...hint } });
}

function cachedQuote(messageId: string): QuoteResolveHint | null {
    const mid = String(messageId || '').trim();
    if (!mid) return null;
    const row = quoteCache.get(mid);
    if (!row) return null;
    if (Date.now() - row.at > QUOTE_CACHE_TTL_MS) {
        quoteCache.delete(mid);
        return null;
    }
    return row.hint;
}

/** 把本条入站记入缓存，供后续「引用它」时反查 */
export function rememberInboundAsQuoteTarget(entry: SmartChatBufferEntry): void {
    const mid = String(entry.messageId || '').trim();
    if (!mid) return;
    const text = String(entry.text || '')
        .replace(/\[眼睛[^\]]*\]:[\s\S]*$/gm, ' ')
        .replace(/补充：[\s\S]*$/gm, ' ')
        .replace(/\d+\s*发了\d+张\[图片\][^\n]*/g, '[图片]')
        .trim();
    rememberQuote(mid, {
        userId: entry.userId,
        nickname: entry.nickname,
        snippet: text.slice(0, 48) || undefined,
    });
}

function hintFromBuffer(batch: SmartChatBufferEntry[], messageId: string): QuoteResolveHint | null {
    const mid = String(messageId || '').trim();
    if (!mid) return null;
    for (let i = batch.length - 1; i >= 0; i--) {
        const b = batch[i];
        if (String(b.messageId || '').trim() !== mid) continue;
        const text = String(b.text || '')
            .replace(/\[眼睛[^\]]*\]:[\s\S]*$/gm, ' ')
            .replace(/补充：[\s\S]*$/gm, ' ')
            .trim();
        return {
            userId: b.userId,
            nickname: b.nickname,
            snippet: text.slice(0, 48) || undefined,
        };
    }
    return null;
}

function hintFromSession(session: SmartChatSessionFile | null | undefined, messageId: string): QuoteResolveHint | null {
    const mid = String(messageId || '').trim();
    if (!mid || !session?.messages?.length) return null;
    const re = new RegExp(
        `\\[msgid:${mid}\\][^\\n]*?\\)\\s*:\\s*([^\\n]{0,80})|`
        + `([^\\n]{0,40}?)\\((\\d{5,12})\\)\\s*\\[msgid:${mid}\\]`,
        'i',
    );
    // 从近到远扫 user 内容
    for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role !== 'user') continue;
        const c = String(m.content || '');
        if (!c.includes(`[msgid:${mid}]`)) continue;
        // 行格式：[...] nick(qq) [msgid:mid] ...: text
        const lineRe = new RegExp(
            `\\[[^\\]]+\\]\\s+([^(\\n]+?)\\((\\d{5,12})\\)(?:\\s+\\[[^\\]]+\\])*\\s*\\[msgid:${mid}\\][^:]*:\\s*([^\\n]*)`,
            'i',
        );
        const lm = c.match(lineRe);
        if (lm) {
            return {
                nickname: String(lm[1] || '').trim() || undefined,
                userId: lm[2],
                snippet: String(lm[3] || '').trim().slice(0, 48) || undefined,
            };
        }
        void re;
        break;
    }
    return null;
}

async function hintFromGetMsg(deps: SmartChatDeps, messageId: string): Promise<QuoteResolveHint | null> {
    const mid = String(messageId || '').trim();
    if (!mid || typeof deps.botApi !== 'function') return null;
    try {
        const raw = await deps.botApi('get_msg', { message_id: mid });
        const dp = raw && typeof raw === 'object' && (raw as { data?: unknown }).data != null
            ? (raw as { data: Record<string, unknown> }).data
            : raw;
        if (!dp || typeof dp !== 'object') return null;
        const msg = dp as Record<string, unknown>;
        const userId = String(
            msg.user_id
            ?? (msg.sender as { user_id?: unknown })?.user_id
            ?? '',
        ).trim();
        const nickname = String(
            (msg.sender as { card?: unknown; nickname?: unknown })?.card
            || (msg.sender as { nickname?: unknown })?.nickname
            || '',
        ).trim();
        const segs = Array.isArray(msg.message) ? msg.message : [];
        const snippet = plainFromSegments(segs).slice(0, 48) || undefined;
        const hint: QuoteResolveHint = {
            userId: userId && /^\d{5,12}$/.test(userId) ? userId : undefined,
            nickname: nickname || undefined,
            snippet,
        };
        if (hint.userId || hint.nickname || hint.snippet) return hint;
        return null;
    } catch (e: unknown) {
        deps.logger?.warn?.(
            '[智能对话] get_msg 补全引用失败:',
            e instanceof Error ? e.message : e,
        );
        return null;
    }
}

function mergeHints(...hints: Array<QuoteResolveHint | null | undefined>): QuoteResolveHint {
    const out: QuoteResolveHint = {};
    for (const h of hints) {
        if (!h) continue;
        if (!out.userId && h.userId) out.userId = h.userId;
        if (!out.nickname && h.nickname) out.nickname = h.nickname;
        if (!out.snippet && h.snippet) out.snippet = h.snippet;
    }
    return out;
}

/**
 * 补全被引用消息的发送者 / 短摘：缓冲 → 缓存 → 会话 → get_msg。
 */
export async function enrichReplyMeta(
    deps: SmartChatDeps,
    meta: InboundMessageMeta,
    opts?: {
        buffer?: SmartChatBufferEntry[];
        session?: SmartChatSessionFile | null;
    },
): Promise<InboundMessageMeta> {
    const mid = String(meta.replyToId || '').trim();
    if (!mid) return meta;
    if (meta.replyToUserId && meta.replyToNickname && meta.replyToSnippet) return meta;

    const merged = mergeHints(
        {
            userId: meta.replyToUserId,
            nickname: meta.replyToNickname,
            snippet: meta.replyToSnippet,
        },
        hintFromBuffer(opts?.buffer || [], mid),
        cachedQuote(mid),
        hintFromSession(opts?.session, mid),
    );

    if (!merged.userId || !merged.nickname || !merged.snippet) {
        const remote = await hintFromGetMsg(deps, mid);
        Object.assign(merged, mergeHints(merged, remote));
    }

    if (merged.userId || merged.nickname || merged.snippet) {
        rememberQuote(mid, merged);
    }

    return {
        ...meta,
        replyToUserId: merged.userId || meta.replyToUserId,
        replyToNickname: merged.nickname || meta.replyToNickname,
        replyToSnippet: merged.snippet || meta.replyToSnippet,
    };
}

/** 格式化引用标注：给人看「回谁」，仍保留 msgid 供模型 reply= */
export function formatReplyMetaTag(entry: {
    replyToId?: string;
    replyToUserId?: string;
    replyToNickname?: string;
    replyToSnippet?: string;
}): string {
    const mid = String(entry.replyToId || '').trim();
    if (!mid) return '';
    const qq = String(entry.replyToUserId || '').trim();
    const nick = String(entry.replyToNickname || '').trim();
    const snip = String(entry.replyToSnippet || '').replace(/\s+/g, ' ').trim().slice(0, 36);
    let who = '';
    if (nick && qq) who = `${nick}(${qq})`;
    else if (nick) who = nick;
    else if (qq) who = `(${qq})`;
    const bits = [`msgid:${mid}`];
    if (who) bits.unshift(who);
    if (snip) bits.push(`「${snip}」`);
    return ` [引用→${bits.join(' ')}]`;
}

/** 艾特标注：尽量带上本批已知昵称 */
export function formatAtMetaTag(atQqs: string[] | undefined, nickByQq?: Map<string, string>): string {
    const list = Array.isArray(atQqs) ? atQqs.map((q) => String(q).trim()).filter(Boolean) : [];
    if (!list.length) return '';
    const parts = list.map((qq) => {
        const nick = nickByQq?.get(qq);
        return nick ? `${nick}(${qq})` : qq;
    });
    return ` [艾特:${parts.join(',')}]`;
}

/** 从事件 sender.role 归一化群身份（仅群聊） */
export function normalizeGroupRole(raw: unknown): 'owner' | 'admin' | 'member' | undefined {
    const r = String(raw || '').trim().toLowerCase();
    if (r === 'owner' || r === 'admin' || r === 'member') return r;
    return undefined;
}

/** 入站身份标记：给人看谁是群主/管理；不是用户打的字 */
export function formatGroupRoleTag(role: unknown): string {
    const r = normalizeGroupRole(role);
    if (r === 'owner') return ' [群主]';
    if (r === 'admin') return ' [管理]';
    if (r === 'member') return ' [成员]';
    return '';
}

/** 群头衔保留上限（QQ 侧上限 18 字，留点余量后硬截断） */
export const GROUP_TITLE_MAX_CHARS = 24;

/**
 * 归一化群头衔（OneBot sender.title）。
 * 头衔是用户可自定义的文本，必须剥掉方括号与换行，
 * 否则有人把头衔改成「x] [群主」就能伪造入站标记。
 */
export function normalizeGroupTitle(raw: unknown): string {
    return String(raw ?? '')
        .replace(/[[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, GROUP_TITLE_MAX_CHARS);
}

/** 入站头衔标记：紧跟在 昵称(QQ) 后面；没有头衔则整段不出现 */
export function formatGroupTitleTag(title: unknown): string {
    const t = normalizeGroupTitle(title);
    return t ? ` [头衔:${t}]` : '';
}
