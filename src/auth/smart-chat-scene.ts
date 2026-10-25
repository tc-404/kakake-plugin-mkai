// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 场况（对话指向，不看群身份）
// - atBot / 昵称点名 / 两人互指 / 开放接话点 → silenceBias
// - 群主/管理/成员标记不参与闸门；身份行仍由 compose host-state 照旧输出
// ---------------------------------------------------------------------------

import type { SmartChatBufferEntry } from './smart-chat-types';
import { BOT_NICK_FALLBACK } from './smart-chat-identity';

export type TopicContinuityHint = 'none' | 'related' | 'unrelated';
export type SilenceBias = 'none' | 'soft' | 'hard';

export interface BatchScene {
    atBot: boolean;
    /** none=不压制；soft=未点名且无开放接话点；hard=两人互指或会话闭嘴偏好 */
    silenceBias: SilenceBias;
    /** 写入 host-state 的事实行（非口令） */
    hostLines: string[];
    /** 本批像是两人互 @/互引用 */
    peerLoop?: boolean;
    /** 有无未被点名的开放接话点 */
    openFloor?: boolean;
}

function entryAtsBot(entry: SmartChatBufferEntry, selfId: string): boolean {
    const sid = String(selfId || '').trim();
    if (!sid) return false;
    return (entry.atQqs || []).some((q) => String(q).trim() === sid);
}

function entryQuotesBot(entry: SmartChatBufferEntry, selfId: string): boolean {
    const sid = String(selfId || '').trim();
    if (!sid) return false;
    return String(entry.replyToUserId || '').trim() === sid;
}

function isNoiseText(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/^\[眼睛\s+msgid:/i.test(t)) return true;
    if (/^补充：/.test(t)) return true;
    return false;
}

/** 是否像在点名 bot（@ / 引用 / 叫昵称）；不读群身份 */
export function batchAddressedToBot(
    batch: SmartChatBufferEntry[],
    selfId: string,
    atTriggered: boolean,
    botNickname?: string,
): boolean {
    if (atTriggered) return true;
    const sid = String(selfId || '').trim();
    const nick = String(botNickname || '').trim();
    const nickOk = Boolean(nick && nick !== BOT_NICK_FALLBACK && nick.length >= 2);
    for (const b of batch || []) {
        if (sid && (entryAtsBot(b, sid) || entryQuotesBot(b, sid))) return true;
        const text = String(b.text || '');
        if (nickOk && text.includes(nick)) return true;
    }
    return false;
}

/** A↔B 互 @ 或互引用（指向均非 bot） */
export function detectPeerLoop(batch: SmartChatBufferEntry[], selfId: string): boolean {
    const sid = String(selfId || '').trim();
    const edges = new Map<string, Set<string>>();
    const addEdge = (from: string, to: string) => {
        const a = String(from || '').trim();
        const b = String(to || '').trim();
        if (!a || !b || a === b) return;
        if (sid && (a === sid || b === sid)) return;
        if (!edges.has(a)) edges.set(a, new Set());
        edges.get(a).add(b);
    };

    for (const b of batch || []) {
        const from = String(b.userId || '').trim();
        if (!from || (sid && from === sid)) continue;
        if (isNoiseText(b.text)) continue;
        for (const qq of b.atQqs || []) addEdge(from, qq);
        if (b.replyToUserId) addEdge(from, b.replyToUserId);
    }

    for (const [a, tos] of edges) {
        for (const b of tos) {
            if (edges.get(b)?.has(a)) return true;
        }
    }

    // 无互 @ 时：两人交替多轮（A 问 B / B 答 A）也视为闭环
    return detectAlternatingPeerChat(batch, sid);
}

/**
 * 恰好两人、≥6 条有效发言且严格交替：视为互相对话（无开放地板时抬 hard）。
 */
export function detectAlternatingPeerChat(batch: SmartChatBufferEntry[], selfId: string): boolean {
    const sid = String(selfId || '').trim();
    const humans: { uid: string; text: string }[] = [];
    for (const b of batch || []) {
        const uid = String(b.userId || '').trim();
        if (!uid || (sid && uid === sid)) continue;
        if (isNoiseText(b.text)) continue;
        humans.push({ uid, text: String(b.text || '').trim() });
    }
    if (humans.length < 6) return false;
    const ids = [...new Set(humans.map((h) => h.uid))];
    if (ids.length !== 2) return false;
    for (let i = 1; i < humans.length; i++) {
        if (humans[i].uid === humans[i - 1].uid) return false;
    }
    return true;
}

/**
 * 开放接话点：无明确指向他人的问句 / 喊人接话，或叫 bot 昵称。
 * 已 @/引用他人的问句不算「对群开放」。
 */
export function detectOpenFloor(
    batch: SmartChatBufferEntry[],
    selfId: string,
    botNickname?: string,
): boolean {
    const sid = String(selfId || '').trim();
    const nick = String(botNickname || '').trim();
    const nickOk = Boolean(nick && nick !== BOT_NICK_FALLBACK && nick.length >= 2);

    for (const b of batch || []) {
        const text = String(b.text || '').trim();
        if (isNoiseText(text)) continue;
        if (sid && (entryAtsBot(b, sid) || entryQuotesBot(b, sid))) return true;
        if (nickOk && text.includes(nick)) return true;

        const ats = (b.atQqs || []).map((q) => String(q).trim()).filter(Boolean);
        const atOthers = ats.filter((q) => !sid || q !== sid);
        const replyOther = String(b.replyToUserId || '').trim();
        const repliesOther = Boolean(replyOther && (!sid || replyOther !== sid));

        // 已明确甩给别人：不算开放地板
        if (atOthers.length || repliesOther) continue;

        if (/[?？]/.test(text)) return true;
        if (/(有没有人|谁会|谁懂|求问|请问下|咋整|怎么办|帮看看)/.test(text)) return true;
    }
    return false;
}

/**
 * 结构场况：不读 [群主]/[管理]/[成员]。
 * 要不要回的硬闸由 silenceBias + refineOutboundByScene 执行。
 */
export function assessBatchScene(
    batch: SmartChatBufferEntry[],
    selfId: string,
    _topic: TopicContinuityHint,
    atTriggered: boolean,
    botNickname?: string,
): BatchScene {
    const atBot = batchAddressedToBot(batch, selfId, atTriggered, botNickname);
    const peerLoop = detectPeerLoop(batch, selfId);
    const openFloor = detectOpenFloor(batch, selfId, botNickname);
    const hostLines: string[] = [];

    if (atBot) {
        return { atBot: true, silenceBias: 'none', hostLines, peerLoop, openFloor };
    }

    if (!atBot) hostLines.push('点名: 无');
    if (peerLoop) hostLines.push('拓扑: 两人互指');

    let silenceBias: SilenceBias = 'none';
    if (peerLoop && !openFloor) silenceBias = 'hard';

    return { atBot: false, silenceBias, hostLines, peerLoop, openFloor };
}
