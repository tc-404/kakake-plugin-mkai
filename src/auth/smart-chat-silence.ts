// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 沉默策略（唯一决策出口）
// ---------------------------------------------------------------------------

import type { SmartChatSessionFile } from './smart-chat-types';
import { PREFER_SILENCE_TTL_MS } from './smart-chat-types';
import type { BatchScene, SilenceBias } from './smart-chat-scene';
import { batchWantsStickerText } from './smart-chat-sticker';

export interface SilenceDecisionInput {
    scene?: BatchScene | null;
    session: SmartChatSessionFile;
    /** action_min === 0 */
    silenceAllowedByConfig: boolean;
    atBot: boolean;
    /** 本批 user 文本（含 queryText） */
    batchText: string;
    /** host-state 检测到要表情张数 */
    requestedStickerCount?: number | null;
    /** 非贴纸工具已执行 */
    nonStickerToolsUsed?: boolean;
    shutUpLimit?: number;
    /** talk-graph 结论：本批有没有人在对你说话（null/undefined = 没算，不作判据） */
    addressedToBot?: boolean | null;
    /** talk-graph 线程数：>0 表示群友已经在互相接话（别人已在回答） */
    peerThreads?: number;
    /** 「没人对你说话」时的否决概率（0-1）；来自 config.silence_veto_ratio */
    vetoRatio?: number;
    /** 否决抽样种子：同一轮两处判定必须给同一个种子，否则 host-state 与预判会说两套 */
    vetoSeed?: string;
}

export interface SilenceDecision {
    atBot: boolean;
    mustSpeak: boolean;
    /** 达限 / @ / 要图 / 工具：本轮禁止 shut_up 与预判 skip */
    forceSpeak: boolean;
    silenceAllowed: boolean;
    skipLlm: boolean;
    sceneBias: SilenceBias;
    batchWantsSticker: boolean;
    /** 写入 host-state 的额外提示行 */
    hostSilenceHints: string[];
    /** 本批检出开放问句（用于开口激励） */
    openQuestion: boolean;
    /** 本轮被「没人对你说话」否决（宿主侧闭嘴，不发请求） */
    addressVetoed: boolean;
}

/** 否决概率：0 = 关掉否决（回到 1.3.1 的软提示），1 = 只要没人对你说话就必闭嘴 */
export const DEFAULT_SILENCE_VETO_RATIO = 0.35;

export function resolveSilenceVetoRatio(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_SILENCE_VETO_RATIO;
    return Math.min(1, Math.max(0, n));
}

/**
 * 种子 → [0,1)。本文件不能 import smart-chat-compose 的 hashStableString（compose 依赖
 * 本文件，会成环），所以这里自带一份 FNV-1a。
 * 空种子回落 Math.random：宁可这一轮不可复现，也不要让所有会话共用一个常量抽样值。
 */
function seedRatio(seed?: string): number {
    const s = String(seed || '');
    if (!s) return Math.random();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0) % 100000) / 100000;
}

/**
 * 否决抽样种子：群 + 沉默计数 + 本批 msgid。
 * 同一轮无论算几次都得同一个值（compose 里那次与 flush 预判那次必须一致），
 * 换一批消息就换一个值（不能让某个群永远命中或永远不命中）。
 */
export function buildSilenceVetoSeed(
    chatId: string,
    streak: number,
    msgIds: Array<string | number | null | undefined>,
): string {
    const ids = (msgIds || [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
    return `veto|${String(chatId || '')}|${Math.max(0, Number(streak) || 0)}|${ids.join(',')}`;
}

function batchWantsSticker(input: SilenceDecisionInput): boolean {
    if (input.requestedStickerCount != null && input.requestedStickerCount > 0) return true;
    return batchWantsStickerText(input.batchText || '');
}

/**
 * 群聊开放问句：未 @ 也可短接。
 * 判据本身保持宽松（问号也算），收紧放在 decideSilence 的上下文门槛上：
 * 非 peerLoop、本批没有别人已在接话、且连续沉默已接近上限才给开口激励。
 * 16 代把「含问号」直接当激励条件，技术群几乎每批命中，沉默率从 42% 掉到 12%。
 */
export function looksLikeOpenQuestion(text: string): boolean {
    const t = String(text || '').trim();
    if (!t || t.length < 2) return false;
    if (/^\[眼睛\s+msgid:/i.test(t) || /^补充：/.test(t)) return false;
    return (
        /[？?]/.test(t)
        || /(?:吗|呢|啥|怎么|怎样|如何|多少|哪里|哪儿|哪个|是否|能不能|可不可以|有没有|支持|咋办|怎么办)(?:[呀啊嘛么呢]?)(?:[？?]|$)/.test(t)
        || /(?:怎么办|怎么弄|咋办|咋整|有没有人|谁会|谁懂)/.test(t)
        || /^(?:为啥|为什么|求问|请问|有人知道)/.test(t)
    );
}

/** prefer_silence 是否仍在 TTL 内；过期则清会话字段并返回 false */
export function refreshPreferSilence(session: SmartChatSessionFile, nowMs = Date.now()): boolean {
    if (!session.prefer_silence) {
        if (session.prefer_silence_at) delete session.prefer_silence_at;
        return false;
    }
    const at = Date.parse(String(session.prefer_silence_at || ''));
    if (!Number.isFinite(at) || at <= 0) {
        // 旧数据无时间戳：给一个「已过半 TTL」的起点，避免永久粘住
        session.prefer_silence_at = new Date(nowMs - Math.floor(PREFER_SILENCE_TTL_MS / 2)).toISOString();
        return true;
    }
    if (nowMs - at >= PREFER_SILENCE_TTL_MS) {
        session.prefer_silence = false;
        delete session.prefer_silence_at;
        return false;
    }
    return true;
}

export function setPreferSilence(session: SmartChatSessionFile, on: boolean, nowMs = Date.now()): void {
    if (on) {
        session.prefer_silence = true;
        session.prefer_silence_at = new Date(nowMs).toISOString();
    } else {
        session.prefer_silence = false;
        delete session.prefer_silence_at;
    }
}

/**
 * 统一沉默策略：是否跳过 LLM、是否必须开口、出站 bias。
 */
export function decideSilence(input: SilenceDecisionInput): SilenceDecision {
    const atBot = Boolean(input.atBot || input.scene?.atBot);
    const wantsSticker = batchWantsSticker(input);
    const nonStickerTools = Boolean(input.nonStickerToolsUsed);
    const mustSpeak = atBot || wantsSticker || nonStickerTools;

    const silenceAllowed = Boolean(input.silenceAllowedByConfig) && !mustSpeak;

    const limit = Math.max(1, Number(input.shutUpLimit) || 5);
    const streak = Math.max(0, Number(input.session.shut_up_streak) || 0);
    const peerLoop = Boolean(input.scene?.peerLoop);
    const openFloor = Boolean(input.scene?.openFloor);
    const preferSilence = refreshPreferSilence(input.session);
    const openQuestion = looksLikeOpenQuestion(input.batchText || '');

    let sceneBias: SilenceBias = input.scene?.silenceBias || 'none';

    const peerLoopHardAllowed =
        peerLoop
        && !openFloor
        && streak < Math.max(2, Math.floor(limit / 2));
    if (sceneBias === 'hard' && peerLoop && !peerLoopHardAllowed) {
        sceneBias = preferSilence && silenceAllowed ? 'soft' : 'none';
    }

    const forceSpeak =
        mustSpeak
        || (silenceAllowed && streak >= limit);

    // 会话闭嘴偏好：仅 soft，不直接 skip（skip 仅 hard）；达限强制开口时不叠加
    if (preferSilence && !atBot && silenceAllowed && !forceSpeak) {
        sceneBias = sceneBias === 'hard' ? 'hard' : 'soft';
    }

    const hostSilenceHints: string[] = [];
    // talk-graph 的确定性结论：别人已经在互相接话 / 没有人在对你说话
    const peersAnswering = (Number(input.peerThreads) || 0) > 0;
    const nobodyAddressingBot = input.addressedToBot === false;
    let addressVetoed = false;

    if (silenceAllowed && streak >= limit) {
        hostSilenceHints.push('沉默已达上限：本轮必须开口');
        if (sceneBias === 'soft' || sceneBias === 'hard') sceneBias = 'none';
    } else if (
        silenceAllowed
        && openQuestion
        && !peerLoop
        && !peersAnswering
        && !preferSilence
        && streak >= Math.max(2, limit - 1)
    ) {
        hostSilenceHints.push('开口激励：场上有开放问句，可短接一条');
        if (sceneBias === 'soft') sceneBias = 'none';
    } else if (silenceAllowed && !forceSpeak && nobodyAddressingBot && sceneBias !== 'hard') {
        // 关系图已算出本批是别人在对话：旁听是正常选项。
        // 问句同样走这一支（16 代 [03] 就是把「你买了吗」这种问别人的话当成问自己），
        // 真要短接由上面的开口激励分支在接近上限时给，不靠「有问号」全批放开。
        //
        // 1.3.1 这里只降到 soft（软提示「接不接都行」），提示写了，模型照样开口 ——
        // 机器自指与自我暴露基本都发生在这种「没人问也硬答」的轮次里。
        // 1.3.2 给这条结论真正的否决权：按 vetoRatio 确定性抽样，命中就抬到 hard，
        // 由 skipLlm 在宿主侧直接闭嘴，连请求都不发（也就省掉一次误开口的机会）。
        // 保底：mustSpeak（@ / 要表情 / 工具已执行）与达限强制开口都在上面的分支里，
        // 走不到这里；沉默计数照常累加，攒到 shut_up_limit 必然被上面那支放出来。
        const ratio = resolveSilenceVetoRatio(input.vetoRatio);
        addressVetoed = ratio > 0 && seedRatio(input.vetoSeed) < ratio;
        if (addressVetoed) {
            sceneBias = 'hard';
            hostSilenceHints.push('本批没人在对你说话：本轮不开口');
        } else {
            sceneBias = 'soft';
            hostSilenceHints.push('本批没人在对你说话：接不接都行');
        }
    }

    if (preferSilence && !atBot && !forceSpeak) {
        hostSilenceHints.push('会话偏好：暂不主动开口（将自动过期）');
    }

    // 可预判跳过 LLM 的两种情形：
    //   1) 早期 peerLoop hard（或 prefer 叠加后的 hard）
    //   2) 「没人对你说话」被否决（addressVetoed，同样落在 hard 上）
    // 达限/@/要图/工具（forceSpeak）一律禁止跳过。
    const skipLlm = !forceSpeak && silenceAllowed && sceneBias === 'hard';

    return {
        atBot,
        mustSpeak,
        forceSpeak,
        silenceAllowed,
        skipLlm,
        sceneBias,
        batchWantsSticker: wantsSticker,
        hostSilenceHints,
        openQuestion,
        addressVetoed,
    };
}

/** compose 用：合并 host-state 沉默提示 */
export function mergeSilenceHostHints(lines: string[], hints: string[]): string[] {
    const out = [...(lines || [])];
    for (const h of hints || []) {
        if (h && !out.includes(h)) out.push(h);
    }
    return out;
}
