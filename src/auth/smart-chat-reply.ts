// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 出站解析（多段气泡 / 贴表情 / 闭嘴；禁止 CQ 码）
// ---------------------------------------------------------------------------

import type { SmartChatBufferEntry } from './smart-chat-types';
import { isAllowedMsgEmojiId } from './smart-chat-emoji';
import { looksLikeToolMarkup } from './smart-chat-provider';
import { stripCustomerServiceTone } from './smart-chat-safety';
import { looksLikeStickerRelPath } from './smart-chat-sticker';

export interface ReplyBubble {
    text: string;
    /** 要艾特的 QQ 列表；空则不艾特（一条消息可多人） */
    at?: string[];
    /** 要引用的 message_id；空则不引用。每条气泡独立；一条消息最多一个引用 */
    replyId?: string;
    /** 表情图库相对路径，如 菲比/熬夜菲比.png */
    sticker?: string;
}

export type AssistantAction =
    | { type: 'shut_up' }
    | { type: 'react'; emojiId: string; messageId?: string }
    | { type: 'msg'; text: string; at?: string[]; replyId?: string; sticker?: string; voiceWanted?: boolean }
    /** 联网前可选说明，立即发出且不计行为数 */
    | { type: 'status'; text: string };

const MAX_ACTIONS = 10;
const MAX_AT_PER_MSG = 8;
const MAX_BUBBLE_CHARS = 1200;

function stripCqAndFences(raw: string): string {
    let s = String(raw || '');
    s = s.replace(/```[\s\S]*?```/g, (block) => {
        const inner = block.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '');
        return inner;
    });
    s = s.replace(/\[CQ:[^\]]*\]/gi, '');
    return s.trim();
}

/** 出站正文清洗：HTML / Markdown / 多余空白 → QQ 可读纯文本 */
export function stripChatMarkdown(raw: string): string {
    let s = String(raw || '');
    // <a href="url">text</a> → text url（先于去标签）
    s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
        const t = String(text || '').replace(/<[^>]+>/g, '').trim();
        const h = String(href || '').trim();
        if (t && h && !t.includes(h)) return `${t} ${h}`;
        return t || h;
    });
    // HTML 换行（QQ 不渲染标签，必须先变成真换行）
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?(?:p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n');
    // 去壳留字
    s = s.replace(/<\/?(?:span|strong|b|em|i|u|font|a|code|pre|ul|ol|table|tbody|thead|td|th|blockquote|hr)\b[^>]*>/gi, '');
    // 残留尖括号标签一律丢掉（正文里不该再有 HTML）
    s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    // 常见实体
    s = s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
    // **bold** / __bold__（可多轮，处理嵌套少见情况）
    for (let i = 0; i < 3; i++) {
        const next = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
        if (next === s) break;
        s = next;
    }
    // 拆坏后残留的 ** / __
    s = s.replace(/\*\*/g, '').replace(/__/g, '');
    // 行首标题
    s = s.replace(/^#{1,6}\s+/gm, '');
    // [文字](url) → 文字
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1');
    // 行内 `code`
    s = s.replace(/`([^`\n]+)`/g, '$1');
    // 常见列表符改成更像聊天的点
    s = s.replace(/^[\t ]*[-*+]\s+/gm, '· ');
    s = s.replace(/^[\t ]*\d+[.)、]\s+/gm, '· ');
    // 空白
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

function parseAttrs(attrText: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([a-zA-Z_\u4e00-\u9fff]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(attrText || ''))) {
        out[m[1].toLowerCase()] = m[2];
    }
    return out;
}

function sanitizeQq(raw: unknown): string | undefined {
    const q = String(raw || '').trim();
    if (!q || q.toLowerCase() === 'all') return undefined;
    if (!/^\d{5,12}$/.test(q)) return undefined;
    return q;
}

/** at="123" 或 at="123,456 789"（逗号/空白分隔，一条消息多人） */
function sanitizeAtList(
    raw: unknown,
    onAtDropped?: (raw: string) => void,
): string[] | undefined {
    const s = String(raw || '').trim();
    if (!s) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of s.split(/[,，\s]+/)) {
        const token = String(part || '').trim();
        if (!token) continue;
        const q = sanitizeQq(token);
        if (!q) {
            onAtDropped?.(token);
            continue;
        }
        if (seen.has(q)) continue;
        seen.add(q);
        out.push(q);
        if (out.length >= MAX_AT_PER_MSG) break;
    }
    return out.length ? out : undefined;
}

function resolveReplyId(raw: unknown, batch: SmartChatBufferEntry[]): string | undefined {
    const v = String(raw || '').trim();
    if (!v) return undefined;
    if (v.toLowerCase() === 'last') {
        for (let i = batch.length - 1; i >= 0; i--) {
            const id = String(batch[i]?.messageId || '').trim();
            if (id) return id;
        }
        return undefined;
    }
    if (/^\d{1,24}$/.test(v)) return v;
    return undefined;
}

function normalizeStickerCandidate(raw: string): string | undefined {
    const t = String(raw || '').trim().replace(/\\/g, '/');
    if (!looksLikeStickerRelPath(t)) return undefined;
    return t.replace(/^表情图库\//, '');
}

function pushMsg(
    list: AssistantAction[],
    text: string,
    at?: string,
    replyId?: string,
    stickerAttr?: string,
    onAtDropped?: (raw: string) => void,
): void {
    // 表情包只用显式通道：<sticker>…</sticker> 或 <msg sticker="…"/>；
    // 禁止把 <msg>正文</msg> 猜成路径，避免和正常文字冲突。
    const sticker = normalizeStickerCandidate(stickerAttr || '');
    if (sticker) {
        list.push({
            type: 'msg',
            text: '',
            sticker,
            at: sanitizeAtList(at, onAtDropped),
            replyId: replyId || undefined,
        });
        return;
    }
    let t = stripChatMarkdown(String(text || '').trim());
    t = t.replace(/\[CQ:[^\]]*\]/gi, '').trim();
    t = stripCustomerServiceTone(t);
    if (!t) return;
    if (t.length > MAX_BUBBLE_CHARS) t = t.slice(0, MAX_BUBBLE_CHARS) + '…';
    list.push({
        type: 'msg',
        text: t,
        at: sanitizeAtList(at, onAtDropped),
        replyId: replyId || undefined,
    });
}

/**
 * 语音气泡：模型用 <voice>短句</voice> 主动点名「这句用语音念」。
 * 语音是单节点——不带 @ / 引用 / 表情；正文照常清洗。是否真转语音由发送层按
 * 分群开关 + 引擎配置决定，未开启 / 合成失败时它就当普通文本气泡发出。
 */
function pushVoiceMsg(list: AssistantAction[], text: string): void {
    let t = stripChatMarkdown(String(text || '').trim());
    t = t.replace(/\[CQ:[^\]]*\]/gi, '').trim();
    t = stripCustomerServiceTone(t);
    if (!t) return;
    if (t.length > MAX_BUBBLE_CHARS) t = t.slice(0, MAX_BUBBLE_CHARS) + '…';
    list.push({ type: 'msg', text: t, voiceWanted: true });
}

/** 从正文里抠出最外层 JSON 对象/数组（兼容前后废话、```json fence） */
function extractJsonCandidate(raw: string): string | null {
    let s = String(raw || '').trim();
    if (!s) return null;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();

    const startObj = s.indexOf('{');
    const startArr = s.indexOf('[');
    if (startObj < 0 && startArr < 0) return null;

    let start: number;
    let openCh: string;
    let closeCh: string;
    if (startObj < 0 || (startArr >= 0 && startArr < startObj)) {
        start = startArr;
        openCh = '[';
        closeCh = ']';
    } else {
        start = startObj;
        openCh = '{';
        closeCh = '}';
    }

    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            continue;
        }
        if (ch === openCh) depth++;
        else if (ch === closeCh) {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

function coerceAtField(v: unknown): string | undefined {
    if (v == null) return undefined;
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(',');
    return String(v);
}

/**
 * 兼容模型误输出的 JSON 协议，例如：
 * {"replies":[{"msg":"…"},{"react":{"emoji":"76","to":"last"}}]}
 */
function tryParseJsonReplies(
    raw: string,
    batch: SmartChatBufferEntry[],
    onAtDropped?: (raw: string) => void,
): AssistantAction[] | null {
    const candidate = extractJsonCandidate(raw);
    if (!candidate) return null;
    let data: unknown;
    try {
        data = JSON.parse(candidate);
    } catch {
        return null;
    }

    let items: unknown[] | null = null;
    if (Array.isArray(data)) {
        items = data;
    } else if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        if (obj.shut_up === true || obj.silence === true || obj['闭嘴'] === true) {
            return [{ type: 'shut_up' }];
        }
        const list = obj.replies ?? obj.actions ?? obj.messages ?? obj.items;
        if (Array.isArray(list)) items = list;
        else if (typeof obj.msg === 'string' || typeof obj.text === 'string') items = [obj];
        else return null;
    } else {
        return null;
    }

    const actions: AssistantAction[] = [];
    for (const item of items) {
        if (actions.length >= MAX_ACTIONS) break;
        if (item == null) continue;
        if (typeof item === 'string') {
            pushMsg(actions, item, undefined, undefined, undefined, onAtDropped);
            continue;
        }
        if (typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;

        if (row.shut_up === true || row.type === 'shut_up' || row['闭嘴'] === true) {
            actions.push({ type: 'shut_up' });
            continue;
        }

        // { "react": { "emoji": "76", "to": "last" } } 或扁平
        const reactObj =
            row.react && typeof row.react === 'object'
                ? (row.react as Record<string, unknown>)
                : row.type === 'react'
                  ? row
                  : null;
        if (reactObj) {
            const emojiId = isAllowedMsgEmojiId(
                reactObj.emoji ?? reactObj.emoji_id ?? reactObj.id ?? row.emoji,
            );
            if (!emojiId) continue;
            const target = reactObj.to ?? reactObj.target ?? reactObj.reply ?? reactObj.msg ?? 'last';
            actions.push({
                type: 'react',
                emojiId,
                messageId: resolveReplyId(target, batch),
            });
            continue;
        }

        const text =
            (typeof row.msg === 'string' && row.msg)
            || (typeof row.text === 'string' && row.text)
            || (typeof row.content === 'string' && row.content)
            || '';
        if (text || row.type === 'msg') {
            pushMsg(
                actions,
                text,
                coerceAtField(row.at ?? row.ats ?? row.qq),
                resolveReplyId(row.reply ?? row.reply_id ?? row.replyId, batch),
                undefined,
                onAtDropped,
            );
        }
    }

    if (!actions.length) return null;
    const hasSpeak = actions.some((a) => a.type === 'msg' || a.type === 'react');
    if (hasSpeak) return actions.filter((a) => a.type !== 'shut_up');
    if (actions.every((a) => a.type === 'shut_up')) return [{ type: 'shut_up' }];
    return actions;
}

/** 闭嘴标签（含模型常见拼写错误 shr_up） */
const SILENCE_TAG_RE = /<\/?(?:shut_up|shr_up|shutup|闭嘴)\s*\/?>/i;
const SILENCE_TAG_GLOBAL_RE = /<\/?(?:shut_up|shr_up|shutup|闭嘴)\s*\/?>/gi;

function isSilenceToken(s: string): boolean {
    const t = String(s || '').trim();
    if (!t) return false;
    return (
        /^<\/?(?:shut_up|shr_up|shutup|闭嘴)\s*\/?>$/i.test(t)
        || /^<(?:shut_up|shr_up|shutup|闭嘴)\s*\/>$/i.test(t)
    );
}

/**
 * 抽出 <think>…</think>（伪装思考草稿，绝不外发）。
 * 返回剥离后的正文与思考文本；镜像 extractStatusTexts 的用法。
 * 兼容 <think>/<thinking> 双写法与模型偶发的未闭合尾块。
 */
export function extractThinkTexts(raw: string): { thinking: string[]; rest: string } {
    const thinking: string[] = [];
    let rest = String(raw || '');
    rest = rest.replace(/<(think|thinking)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => {
        const t = String(inner || '').trim();
        if (t) thinking.push(t);
        return '';
    });
    // 未闭合的 <think> 起始到文本末尾：整段当思考吞掉，避免半截推理进群
    rest = rest.replace(/<(think|thinking)\b[^>]*>([\s\S]*)$/i, (_m, _tag, inner) => {
        const t = String(inner || '').trim();
        if (t) thinking.push(t);
        return '';
    });
    return { thinking, rest: rest.trim() };
}

/**
 * 抽出 <status>…</status>（联网前说明，不计行为）。
 * 返回剥离后的正文，避免最终轮重复发送。
 */
export function extractStatusTexts(raw: string): { statuses: string[]; rest: string } {
    const statuses: string[] = [];
    let rest = String(raw || '');
    rest = rest.replace(/<status\b[^>]*>([\s\S]*?)<\/status>/gi, (_m, inner) => {
        let t = stripChatMarkdown(String(inner || '').trim());
        if (t.length > MAX_BUBBLE_CHARS) t = t.slice(0, MAX_BUBBLE_CHARS) + '…';
        t = t.replace(/\[CQ:[^\]]*\]/gi, '').trim();
        if (t) statuses.push(t);
        return '';
    });
    return { statuses, rest: rest.trim() };
}

/**
 * 工具调用附带的「先说一句」：优先 <status>；否则短纯文本也可当作说明（仅供日志/计划备注）。
 */
export function inferToolPreambleTexts(raw: string): string[] {
    const { statuses, rest } = extractStatusTexts(raw);
    if (statuses.length) return statuses.slice(0, 2);
    const t = String(rest || '').trim();
    if (!t) return [];
    if (looksLikeToolMarkup(t)) return [];
    if (/<(?:msg|replies|react|shut_up|shr_up|闭嘴)\b/i.test(t)) return [];
    // 过长当作误塞的正文，不当 status
    if (t.length > 80) return [];
    return [t];
}

/** 可否发到群里：禁止工具名、计划腔、内心独白 */
export function isSafeGroupStatusText(text: string): boolean {
    const t = String(text || '').trim();
    if (!t || t.length > 36) return false;
    if (/mkapi[_-]?\d*|web_search|web_fetch|tool_calls?|function\s*call|DSML|<invoke\b/i.test(t)) return false;
    if (/调\s*(?:一下)?(?:mkapi|工具|脚本)|下一步|用户要|挑一[张个]|执行\s*MKAPI|评定|续程|宿主/i.test(t)) return false;
    if (/^我(?:先|去|来)?(?:搜|查|调|看)/i.test(t) && /mkapi|工具|脚本|接口/i.test(t)) return false;
    return true;
}

/**
 * 仅显式 <status> 且像人话时，才允许工具前发到群；
 * 模型把想法/工具名写成短正文时不再外发。
 */
export function extractGroupSafeStatusTexts(raw: string): string[] {
    const { statuses } = extractStatusTexts(raw);
    return statuses.filter(isSafeGroupStatusText).slice(0, 1);
}

/**
 * 将模型单次输出解析为动作列表（文字气泡 / 贴表情 / 闭嘴）。
 * <status> 不在此计入；请先用 extractStatusTexts / inferToolPreambleTexts。
 */
export function parseAssistantActions(
    raw: string,
    batch: SmartChatBufferEntry[] = [],
    opts?: { onAtDropped?: (raw: string) => void },
): AssistantAction[] {
    const onAtDropped = opts?.onAtDropped;
    // 先剥伪装思考草稿，再剥 status；两者都不进群消息
    const noThink = extractThinkTexts(raw).rest;
    const { rest } = extractStatusTexts(noThink);
    const cleaned = stripCqAndFences(rest);
    if (!cleaned) return [];
    // 工具调用正文绝不当成群消息
    if (looksLikeToolMarkup(cleaned)) return [];

    {
        const hasSilenceTag = SILENCE_TAG_RE.test(cleaned);
        const hasMsgOrReact = /<(?:msg|react|sticker|voice)\b/i.test(cleaned);
        if (isSilenceToken(cleaned) || (hasSilenceTag && !hasMsgOrReact)) {
            const onlySilence = cleaned
                .replace(SILENCE_TAG_GLOBAL_RE, '')
                .replace(/<\/?(?:replies)[^>]*>/gi, '')
                .trim();
            if (!onlySilence || isSilenceToken(cleaned) || (hasSilenceTag && !hasMsgOrReact)) {
                return [{ type: 'shut_up' }];
            }
        }
    }

    // 模型偶发输出 JSON 协议：优先吃掉，避免整段 JSON 当纯文本发出
    if (!/<(?:msg|react|sticker|voice|replies|shut_up|shr_up|闭嘴)\b/i.test(cleaned)) {
        const fromJson = tryParseJsonReplies(cleaned, batch, onAtDropped);
        if (fromJson?.length) return fromJson;
    }

    const wrap = cleaned.match(/<replies\b[^>]*>([\s\S]*?)<\/replies>/i);
    const scope = wrap ? wrap[1] : cleaned;
    const actions: AssistantAction[] = [];

    const tokenRe =
        /<(shut_up|shr_up|shutup|闭嘴)\s*\/>|<react\b([^>]*)\s*\/?>|<voice\b[^>]*>([\s\S]*?)<\/voice>|<sticker\b([^>]*)>([\s\S]*?)<\/sticker>|<sticker\b([^>]*)\s*\/>|<msg\b([^>]*)>([\s\S]*?)<\/msg>/gi;
    let m;
    while ((m = tokenRe.exec(scope)) && actions.length < MAX_ACTIONS) {
        const full = m[0];
        if (/^<(?:shut_up|shr_up|shutup|闭嘴)/i.test(full)) {
            actions.push({ type: 'shut_up' });
            continue;
        }
        if (/^<react/i.test(full)) {
            const attrs = parseAttrs(m[2] || '');
            const emojiId = isAllowedMsgEmojiId(attrs.emoji || attrs.emoji_id || attrs.id);
            if (!emojiId) continue;
            const target = attrs.to || attrs.target || attrs.reply || attrs.msg || 'last';
            actions.push({
                type: 'react',
                emojiId,
                messageId: resolveReplyId(target, batch),
            });
            continue;
        }
        if (/^<voice/i.test(full)) {
            pushVoiceMsg(actions, m[3] || '');
            continue;
        }
        if (/^<sticker/i.test(full)) {
            const attrs = parseAttrs(m[4] || m[6] || '');
            const body = String(m[5] || attrs.path || attrs.src || attrs.file || '').trim();
            pushMsg(actions, body, undefined, undefined, body, onAtDropped);
            continue;
        }
        const attrs = parseAttrs(m[7] || '');
        pushMsg(
            actions,
            m[8],
            attrs.at,
            resolveReplyId(attrs.reply, batch),
            attrs.sticker || attrs.path,
            onAtDropped,
        );
    }

    if (actions.length) {
        const hasSpeak = actions.some((a) => a.type === 'msg' || a.type === 'react');
        if (hasSpeak) return actions.filter((a) => a.type !== 'shut_up');
        if (actions.every((a) => a.type === 'shut_up')) return [{ type: 'shut_up' }];
        return actions;
    }

    // XML 未命中时再试一次 JSON（有人把 JSON 和说明混写）
    const fromJsonLate = tryParseJsonReplies(cleaned, batch, onAtDropped);
    if (fromJsonLate?.length) return fromJsonLate;

    if (!/<(?:shut_up|shr_up|shutup|闭嘴|react|sticker|voice|msg|replies)\b/i.test(cleaned)) {
        // 整段像 JSON replies 却解析失败：不要把原始 JSON 砸进群
        if (/"replies"\s*:/.test(cleaned) || /^\s*[\{\[]/.test(cleaned)) {
            return [];
        }
        pushMsg(actions, cleaned, undefined, undefined, undefined, onAtDropped);
    }
    return actions;
}

export function parseAssistantReplies(raw: string, batch: SmartChatBufferEntry[] = []): ReplyBubble[] {
    return parseAssistantActions(raw, batch)
        .filter((a) => a.type === 'msg')
        .map((a) => ({ text: a.text, at: a.at, replyId: a.replyId }));
}

/**
 * 按行为限制裁剪动作；处理闭嘴开关与强制开口。
 *
 * shutUp（计入连续闭嘴）：
 * - 显式 <shut_up/>
 * - 仅贴表情、无文字气泡（纯表情回应也算闭嘴的一种）
 *
 * 强制开口时必须至少有一句文字；纯 react 不够。
 */
export function applyActionLimits(
    actions: AssistantAction[],
    opts: {
        actionMin: number;
        actionMax: number;
        silenceAllowed: boolean;
        mustSpeak: boolean;
        /** 强制去掉所有气泡引用（用户要求别引用 / 会话偏好） */
        stripReply?: boolean;
    },
): { actions: AssistantAction[]; shutUp: boolean } {
    const min = Math.max(0, Math.min(10, Number(opts.actionMin) || 0));
    let max = Math.max(0, Math.min(10, Number(opts.actionMax) || 0));
    if (max < min) max = min;
    if (max < 1) max = 1;

    const silenceAllowed = Boolean(opts.silenceAllowed) && min === 0;
    const mustSpeak = Boolean(opts.mustSpeak);

    let list = Array.isArray(actions) ? [...actions] : [];
    // status 不计行为，最终轮不应再执行；若混入则丢掉
    list = list.filter((a) => a.type !== 'status');
    if (opts.stripReply) {
        list = list.map((a) => (a.type === 'msg' ? { ...a, replyId: undefined } : a));
    }
    const hasMsg = list.some((a) => a.type === 'msg');
    const hasReact = list.some((a) => a.type === 'react');
    const wantsExplicitShutUp = list.some((a) => a.type === 'shut_up') && !hasMsg && !hasReact;
    const pureReactOnly = !hasMsg && hasReact;

    // 显式闭嘴
    if (wantsExplicitShutUp) {
        if (silenceAllowed && !mustSpeak) {
            return { actions: [], shutUp: true };
        }
        if (mustSpeak) {
            // 交给上层补一句真人短接，避免「……」假开口
            return { actions: [], shutUp: true };
        }
        return { actions: [{ type: 'msg', text: '嗯' }], shutUp: false };
    }

    list = list.filter((a) => a.type !== 'shut_up');
    // 超上限截断；不靠宿主复制气泡凑下限（机械灌水），节奏由 system 引导
    if (list.length > max) list = list.slice(0, max);
    void min;

    // 纯贴表情 = 闭嘴变体：仍执行 react，但计入连续闭嘴
    if (pureReactOnly || (!hasMsg && list.every((a) => a.type === 'react'))) {
        const reacts = list.filter((a) => a.type === 'react');
        if (mustSpeak) {
            return { actions: reacts.slice(0, max), shutUp: true };
        }
        if (!silenceAllowed) {
            const next = [...reacts];
            if (next.length >= max) next.pop();
            next.push({ type: 'msg', text: '嗯' });
            return { actions: next.slice(0, max), shutUp: false };
        }
        return { actions: reacts.slice(0, max), shutUp: true };
    }

    if (list.length === 0) {
        if (silenceAllowed && !mustSpeak) {
            return { actions: [], shutUp: true };
        }
        if (mustSpeak) {
            return { actions: [], shutUp: true };
        }
        return { actions: [{ type: 'msg', text: '嗯' }], shutUp: false };
    }

    // action_min：仅在「必须开口且已有文字」时作为软提醒由 system 处理；
    // 宿主不自动复制气泡凑数（会显得机械）。仍保证至少 1 条文字（上面已处理）。
    return { actions: list, shutUp: false };
}

/**
 * 出站后处理：按结构场况 bias 校正（不看群身份）。
 * - hard：允许沉默时整轮改写为 shut_up（含贴纸，避免刷存在感）
 * - soft：无文字 → shut_up
 * - 复读：silenceAllowed 且非 mustSpeak 时始终检测（不限 soft）；命中 → shut_up
 * - 旁白复盘：silenceAllowed 且非 mustSpeak 时吞掉围观解说腔
 * - mustSpeak：丢掉与群友重合的文字；若只剩贴纸且未点名要图 → shut_up
 * - toolsUsed：不因 bias 强行闭嘴；仍可剥复读文字
 * - forceSpeak：达限等宿主强制开口，不因 hard 压成 shut_up
 */
export function refineOutboundByScene(
    actions: AssistantAction[],
    opts: {
        silenceAllowed: boolean;
        mustSpeak: boolean;
        silenceBias: 'none' | 'soft' | 'hard';
        toolsUsed: boolean;
        actionMax: number;
        /** 本批人话，用于复读判定 */
        recentHumanTexts?: string[];
        /** 本批是否点名要表情（保留贴纸） */
        batchWantsSticker?: boolean;
        /** 达限/@ 等：不因 hard 压成 shut_up */
        forceSpeak?: boolean;
    },
): { actions: AssistantAction[]; shutUp: boolean; rewritten: boolean } {
    void opts.actionMax;
    let list = Array.isArray(actions) ? [...actions] : [];
    let rewritten = false;
    const humans = opts.recentHumanTexts || [];
    const batchWantsSticker = Boolean(opts.batchWantsSticker);

    const speakState = (arr: AssistantAction[]) => {
        const hasText = arr.some(
            (a) => a.type === 'msg' && Boolean(String(a.text || '').trim()),
        );
        const hasSticker = arr.some(
            (a) => a.type === 'msg' && Boolean(String(a.sticker || '').trim()),
        );
        const hasSpeak = arr.some((a) => {
            if (a.type !== 'msg') return false;
            if (String(a.sticker || '').trim()) return true;
            return Boolean(String(a.text || '').trim());
        });
        return { hasText, hasSticker, hasSpeak };
    };

    const stripEchoTexts = (arr: AssistantAction[]) => {
        const next: AssistantAction[] = [];
        let changed = false;
        for (const a of arr) {
            if (a.type !== 'msg') {
                next.push(a);
                continue;
            }
            const text = String(a.text || '').trim();
            const sticker = String(a.sticker || '').trim();
            if (text && looksLikeEchoOfHumans([text], humans)) {
                changed = true;
                if (sticker) next.push({ ...a, text: '' });
                continue;
            }
            next.push(a);
        }
        return { actions: next, changed };
    };

    // mustSpeak / forceSpeak / 工具汇报：不因 bias 闭嘴，但剥掉复读字
    if (opts.mustSpeak || opts.forceSpeak || opts.toolsUsed) {
        const stripped = stripEchoTexts(list);
        list = stripped.actions;
        rewritten = stripped.changed;
        const { hasText, hasSticker, hasSpeak } = speakState(list);
        if (opts.mustSpeak && !hasText && hasSticker && !batchWantsSticker) {
            return { actions: [], shutUp: true, rewritten: true };
        }
        return { actions: list, shutUp: !hasSpeak, rewritten };
    }

    if (!opts.silenceAllowed) {
        const { hasSpeak } = speakState(list);
        return { actions: list, shutUp: !hasSpeak, rewritten: false };
    }

    const bias = opts.silenceBias || 'none';
    if (bias === 'hard' && !opts.forceSpeak) {
        const { hasSpeak } = speakState(list);
        return { actions: [], shutUp: true, rewritten: hasSpeak || list.length > 0 };
    }

    const { hasText, hasSpeak } = speakState(list);
    if (bias === 'soft' && !hasText) {
        return { actions: [], shutUp: true, rewritten: hasSpeak || list.length > 0 };
    }

    // 常开反复读（不限 soft）：整轮压成沉默
    const botTexts = list
        .filter((a) => a.type === 'msg')
        .map((a) => String(a.text || '').trim())
        .filter(Boolean);
    if (looksLikeEchoOfHumans(botTexts, humans)) {
        return { actions: [], shutUp: true, rewritten: true };
    }

    // 旁白复盘（围观解说）：允许沉默时吞掉，避免「总结会话」腔
    if (looksLikeNarratorCommentary(botTexts)) {
        return { actions: [], shutUp: true, rewritten: true };
    }

    return { actions: list, shutUp: !hasSpeak, rewritten: false };
}

/**
 * 围观复盘/旁白解说腔：第三人称点评别人发言或现场，像读会议纪要。
 * 保守阈值，少误杀「你…」对线与「我…」表态。
 */
export function looksLikeNarratorCommentary(botTexts: string[]): boolean {
    for (const raw of botTexts || []) {
        const t = String(raw || '').replace(/\s+/g, ' ').trim();
        if (t.length < 8) continue;
        // 已在用「我/你」对线的短怼，放行
        if (/^(我|咱|俺|你)/.test(t) && !/建议群友|这位|这句属于|自己艾特自己/.test(t)) {
            continue;
        }
        if (
            /^(这位|这哥|那哥|那位)/.test(t)
            || /建议群友/.test(t)
            || /感天动地|庆功宴|新型自爆|悟性可以/.test(t)
            || /这边(?:nc|突然|又)/.test(t)
            || /自己艾特自己/.test(t)
            || /这句[「"'].+[」"']属于/.test(t)
            || /这句.{0,12}属于/.test(t)
            || /从[「"'].+[」"']到[「"']/.test(t)
            || /(?:老哥|哥们).{0,8}(?:折腾|终于|找到了)/.test(t)
        ) {
            return true;
        }
    }
    return false;
}

/** 规范化用于复读比较：去喵口癖、空白与常见标点 */
export function normalizeEchoText(raw: string): string {
    return String(raw || '')
        .replace(/喵+|～+|~+/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[\s\u3000，。！？、,.!?;；：:\-—…·"'“”‘’（）()【】\[\]《》<>]/g, '')
        .toLowerCase();
}

function levRatio(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length;
    const n = b.length;
    if (Math.max(m, n) > 80) {
        // 长句只用包含关系，避免 O(n*m) 爆
        return 0;
    }
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    const dist = dp[m][n];
    return 1 - dist / Math.max(m, n);
}

/** 出站是否在复读本批近邻人话（阈值保守，少误杀抬杠） */
export function looksLikeEchoOfHumans(botTexts: string[], humanTexts: string[]): boolean {
    const humans = (humanTexts || [])
        .map((t) => normalizeEchoText(t))
        .filter((t) => t.length >= 2);
    if (!humans.length) return false;

    for (const raw of botTexts || []) {
        const bot = normalizeEchoText(raw);
        if (bot.length < 2) continue;
        for (const h of humans) {
            // 原句照抄：短句也拦（「西海」「复读机」）
            if (bot === h) return true;
            if (bot.length < 4 || h.length < 4) continue;
            if (bot.length >= 6 && h.includes(bot)) return true;
            if (h.length >= 6 && bot.includes(h) && h.length / bot.length >= 0.7) return true;
            if (bot.length <= 40 && h.length <= 40 && levRatio(bot, h) >= 0.86) return true;
        }
    }
    return false;
}


/** 从 assistant XML 中剥掉 reply=，避免写入历史后继续教模型每句都引 */
export function stripReplyAttrsFromContent(raw: string): string {
    return String(raw || '').replace(/<msg(\b[^>]*)>/gi, (_full, attrs) => {
        const cleaned = String(attrs || '').replace(/\s*\breply\s*=\s*"[^"]*"/gi, '');
        return `<msg${cleaned}>`;
    });
}

export function sleep(ms: number): Promise<void> {
    const n = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => setTimeout(resolve, n));
}

export function nextReplyGapMs(baseMs: number): number {
    const base = Math.min(8000, Math.max(400, Number(baseMs) || 1200));
    const jitter = 0.85 + Math.random() * 0.3;
    return Math.round(base * jitter);
}
