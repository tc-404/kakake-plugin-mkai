// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — compaction 策略（Reasonix：低频 cache-reset）
// 不变量：KEEP + 1 + HYSTERESIS < THRESHOLD；压后至多 1 条 digest 且在 index 0
// ---------------------------------------------------------------------------

import type { SmartChatSessionFile, SmartChatSessionMessage } from './smart-chat-types';
import { stripHostPanelBlocks } from './smart-chat-types';
import { presentImageSupplementsForModel } from './smart-chat-image';
import { presentFileNotesForModel } from './smart-chat-file';
import { estimateMessagesTokens, keepTailForTokens } from './smart-chat-token-meter';
import type { CompactionBudget } from './smart-chat-token-meter';
import {
    looksLikeCustomerServiceText,
    looksLikeEnglishRefusalText,
    looksLikeTechHowtoText,
} from './smart-chat-safety';

/** 文件内硬上限（归档前再 compact） */
export const MAX_FILE_MESSAGES = 360;
/** 超过此条数触发低频 compaction（**硬阀**：token 触发是主判据，这条只防文件无限膨胀） */
export const COMPACT_MESSAGE_THRESHOLD = 96;
/** compaction 后保留的尾部消息数（verbatim） */
export const COMPACT_KEEP_TAIL = 48;
/** 触顶紧急 compact：更短尾，给 NIM 腾 input */
export const OVERFLOW_KEEP_TAIL = 24;
/** 压后目标：1 + keep ≤ threshold - hysteresis，避免每轮再压 */
export const COMPACT_HYSTERESIS = 16;
/** digest 消息内容上限 */
export const DIGEST_MAX_CHARS = 8000;
/** 摘要里最多保留的「立场/约定」条数 */
export const DIGEST_STANCE_MAX = 24;
/** 摘要里最多抽样的对话片段对数（user/assistant 各算） */
export const DIGEST_DIALOGUE_SAMPLE = 18;
/**
 * A② 影子日志：被 digest 遮蔽的原始消息留档额度（有界 FIFO）。
 * 有了它，压缩不再是「就地毁掉历史」：可以从会话文件里回放被折叠的原文，
 * 也能算出「前缀从哪一轮起失效」。额度用超了丢最旧，避免会话文件无限膨胀。
 */
export const SHADOW_LOG_MAX_MESSAGES = 160;
export const SHADOW_LOG_MAX_BYTES = 160 * 1024;
/** compaction 记录条数上限 */
export const COMPACTION_RECORD_MAX = 20;

/**
 * A② 压缩落账：把被遮蔽的**原始**消息留档（有界），并追加一条 compaction 记录。
 *
 * 记录里带 `prefix_invalid_from`：digest 永远插在 index 0，所以服务端前缀缓存
 * 从 messages[0] 起就作废（system 部分仍可复用）。`compaction_epoch` 递增后，
 * 下一轮 compose 的 prefixStable 自检会明确报「刚压过 → 预期失配」，
 * 而不是像以前那样只看到 prefixStable=false 却不知道为什么。
 */
function recordCompaction(
    session: SmartChatSessionFile,
    droppedRaw: SmartChatSessionMessage[],
    kept: number,
    digestContent: string,
    tokensBefore: number | null,
    budget?: CompactionBudget | null,
    kind = 'compact',
    trigger: 'tokens' | 'count' | 'overflow' | 'merge' = 'count',
): void {
    const log = Array.isArray(session.shadow_log) ? session.shadow_log.slice() : [];
    for (const m of droppedRaw || []) {
        log.push({ role: String(m?.role || 'user'), content: String(m?.content ?? '') });
    }
    while (log.length > SHADOW_LOG_MAX_MESSAGES) log.shift();
    let bytes = 0;
    for (const m of log) bytes += Buffer.byteLength(String(m?.content || ''), 'utf8');
    while (log.length > 1 && bytes > SHADOW_LOG_MAX_BYTES) {
        const removed = log.shift();
        bytes -= Buffer.byteLength(String(removed?.content || ''), 'utf8');
    }
    session.shadow_log = log;

    const epoch = Number(session.compaction_epoch || 0) + 1;
    const records = Array.isArray(session.compactions) ? session.compactions.slice() : [];
    records.push({
        at: new Date().toISOString(),
        epoch,
        kind,
        /** 触发来源：tokens=达到 token 预算；count=条数硬阀；overflow=上游触顶应急；merge=叠层合并 */
        trigger,
        dropped: (droppedRaw || []).length,
        kept,
        digest_chars: String(digestContent || '').length,
        tokens_before: tokensBefore,
        retain_tokens: budget?.retainTokens ?? null,
        window: budget?.window ?? null,
        window_source: budget?.source ?? null,
        threshold_ratio: budget?.thresholdRatio ?? null,
        retain_ratio: budget?.retainRatio ?? null,
        prefix_invalid_from: 'messages[0]',
    });
    while (records.length > COMPACTION_RECORD_MAX) records.shift();
    session.compactions = records;
    session.compaction_epoch = epoch;
}

/** 最近一次压缩的 epoch（没有压过就是 0） */
export function currentCompactionEpoch(session: { compaction_epoch?: number } | null | undefined): number {
    return Math.max(0, Number(session?.compaction_epoch) || 0);
}

/** 启动时校验常量不变量（被 verify 脚本引用） */
export function assertCompactPolicyInvariants(): void {
    if (!(COMPACT_KEEP_TAIL + 1 + COMPACT_HYSTERESIS < COMPACT_MESSAGE_THRESHOLD)) {
        throw new Error(
            `compact invariant: KEEP(${COMPACT_KEEP_TAIL})+1+HYSTERESIS(${COMPACT_HYSTERESIS}) `
            + `must be < THRESHOLD(${COMPACT_MESSAGE_THRESHOLD})`,
        );
    }
}

export function clipDigestBody(body: string, maxChars: number): string {
    const raw = String(body || '');
    const cap = Math.max(500, Number(maxChars) || DIGEST_MAX_CHARS);
    if (raw.length <= cap) return raw;
    const headBudget = Math.floor(cap * 0.4);
    const tailBudget = cap - headBudget - 24;
    const head = raw.slice(0, headBudget);
    const tail = raw.slice(-Math.max(200, tailBudget));
    return `${head}\n…[compact truncated]…\n${tail}`;
}

/** 真·远史 digest（含 digest-* 或明确远史说明），不是普通回合被误包 */
export function looksLikeRealCompactionDigest(content: string): boolean {
    const c = String(content || '');
    if (/<digest-(?:stance|users|assistants)>/i.test(c)) return true;
    if (/说明：以下为远史|已并入更早一轮 compaction/i.test(c)) return true;
    if (/\[compact(?: empty| truncated)?\]/i.test(c)) return true;
    return false;
}

export function isDigestMessage(m: { role?: string; content?: string } | null | undefined): boolean {
    if (!m || m.role !== 'user') return false;
    const c = String(m.content || '');
    if (!/<compaction-summary>/i.test(c) && !looksLikeRealCompactionDigest(c)) return false;
    return !isFalselyWrappedLiveTurn(c);
}

/**
 * 普通回合（含 host-state / skill-tree / main-visit）被误包进 compaction-summary。
 */
export function isFalselyWrappedLiveTurn(content: string): boolean {
    const c = String(content || '');
    if (!/<compaction-summary>/i.test(c)) return false;
    if (looksLikeRealCompactionDigest(c)) return false;
    const inner = c.replace(/<\/?compaction-summary>/gi, '').trim();
    return /<(?:host-state|skill-tree|main-visit|side-context|batch-messages)\b/i.test(inner);
}

function unwrapCompactionShell(content: string): string {
    return String(content || '')
        .replace(/^\s*<compaction-summary>\s*/i, '')
        .replace(/\s*<\/compaction-summary>\s*$/i, '')
        .trim();
}

/**
 * 修复历史 compaction：开头孤儿闭合标签 / 空 summary 壳。
 */
export function repairCompactionContent(content: string): string {
    let c = String(content || '');
    if (isFalselyWrappedLiveTurn(c)) {
        return unwrapCompactionShell(c);
    }
    if (!/<compaction-summary>/i.test(c) && !looksLikeRealCompactionDigest(c)) {
        return c;
    }
    const openIdx = c.indexOf('<compaction-summary>');
    if (openIdx > 0) c = c.slice(openIdx);
    if (!c.startsWith('<compaction-summary>')) {
        if (!looksLikeRealCompactionDigest(c)) return String(content || '');
        c = c.replace(/^[\s\S]*?(?=<digest-stance>|<digest-users>|<digest-assistants>|<host-state>|<batch-messages>|<main-visit>)/, '');
        if (!c.includes('<compaction-summary>')) {
            c = `<compaction-summary>\n${c}\n</compaction-summary>`;
        }
    }
    c = c.replace(/^(?:<\/(?:host-state|batch-messages|main-visit|side-context|digest-stance|digest-users|digest-assistants|compaction-summary)>\s*)+/i, '');
    const inner = c.replace(/<\/?compaction-summary>/gi, '').trim();
    if (!inner || inner === '…[compact truncated]…') {
        return '<compaction-summary>\n[compact empty]\n</compaction-summary>';
    }
    if (!c.includes('</compaction-summary>')) {
        c = `${c.trim()}\n</compaction-summary>`;
    }
    return c;
}

/** 连续闭嘴是否占满一条 assistant */
export function isShutUpAssistantContent(content: unknown): boolean {
    const c = String(content || '').trim();
    if (!c) return true;
    if (/^<\/?(?:shut_up|shr_up|shutup|闭嘴)\s*\/?>$/i.test(c)) return true;
    const hasMsg = /<msg\b/i.test(c);
    const hasSticker = /<sticker\b/i.test(c);
    const hasSilence = /<\/?(?:shut_up|shr_up|shutup|闭嘴)\s*\/?>/i.test(c);
    if (hasSilence && !hasMsg && !hasSticker) return true;
    if (!hasMsg && !hasSticker && /<react\b/i.test(c)) return true;
    return false;
}

/**
 * 折叠历史上连续的闭嘴轮：每段连续沉默只保留最后一对 user+assistant。
 * 仅在 compaction / 叠 digest 迁移时调用（不破坏 API 前缀缓存）。
 */
export function collapseRedundantShutUpHistory<T extends { role: string; content: string }>(
    messages: T[],
    keepRuns = 1,
): T[] {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length < 4) return list;
    const keep = Math.max(1, Math.min(3, Math.floor(Number(keepRuns) || 1)));

    type Pair = { user?: T; assistant?: T; shut: boolean };
    const pairs: Pair[] = [];
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.role === 'user') {
            pairs.push({ user: m, shut: false });
            continue;
        }
        if (m.role === 'assistant') {
            const last = pairs[pairs.length - 1];
            if (last && !last.assistant) {
                last.assistant = m;
                last.shut = isShutUpAssistantContent(m.content);
            } else {
                pairs.push({ assistant: m, shut: isShutUpAssistantContent(m.content) });
            }
        }
    }

    const outPairs: Pair[] = [];
    let run: Pair[] = [];
    const flushRun = () => {
        if (!run.length) return;
        if (run.every((p) => p.shut)) {
            outPairs.push(...run.slice(-keep));
        } else {
            outPairs.push(...run);
        }
        run = [];
    };
    for (const p of pairs) {
        if (p.shut) run.push(p);
        else {
            flushRun();
            outPairs.push(p);
        }
    }
    flushRun();

    const out: T[] = [];
    for (const p of outPairs) {
        if (p.user) out.push(p.user);
        if (p.assistant) out.push(p.assistant);
    }
    return out;
}

function clipUserTurnForDigest(content: string, maxChars = 800): string {
    let c = presentFileNotesForModel(presentImageSupplementsForModel(String(content || ''), 56, { dropFailed: true }), 120);
    // 折叠输入侧先剥面板噪音（skill-tree / host-state / memory-recall / talk-graph…），
    // 避免宿主运行事实固化进 digest 被当成群友说过的话
    c = stripHostPanelBlocks(c)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (c.length <= maxChars) return c;
    const lines = c.split('\n');
    const important = lines
        .filter((l) => /\[引用→|\[msgid:|\[艾特:|\[群主\]|\[管理\]|\[成员\]|<main-visit>/.test(l))
        .slice(0, 16);
    const head = c.slice(0, Math.min(320, Math.floor(maxChars * 0.4)));
    const tail = c.slice(-Math.min(220, Math.floor(maxChars * 0.28)));
    const mid = important.length ? `\n${important.join('\n')}\n` : '\n';
    let out = `${head}${mid}…\n${tail}`;
    if (out.length > maxChars) out = clipDigestBody(out, maxChars);
    return out;
}

function extractAssistantSpeakTexts(content: string): string[] {
    const raw = String(content || '').trim();
    if (!raw) return [];
    if (/^<\/?(?:shut_up|shr_up|shutup|闭嘴)\s*\/?>$/i.test(raw)) return [];
    const texts: string[] = [];
    const re = /<msg\b[^>]*>([\s\S]*?)<\/msg>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
        const t = String(m[1] || '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (t && t !== '……' && t !== '...' && t !== '路过瞄一眼') texts.push(t);
    }
    if (texts.length) return texts;
    if (!/<(?:shut_up|react|sticker|replies)\b/i.test(raw)) {
        const t = raw.replace(/\s+/g, ' ').trim();
        if (t && t.length <= 400) return [t];
    }
    return [];
}

function looksLikeRefusalOrPolicyLine(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return true;
    return (
        /抱歉[，,]?\s*我不能帮助/i.test(t)
        || looksLikeEnglishRefusalText(t)
        || /^好的[，,]?\s*已收到[.。]?$/u.test(t)
        || looksLikeCustomerServiceText(t)
    );
}

function looksLikeStanceLine(text: string): boolean {
    const t = String(text || '').trim();
    if (t.length < 4) return false;
    if (looksLikeRefusalOrPolicyLine(t) || looksLikeTechHowtoText(t)) return false;
    return /记住|约定|以后|别再|不要再|从今|算我|我是|叫我|我叫|别叫我|别当|我不是|答应|说过|就这样|默认|禁止|必须|别忘了|你记住/i.test(t);
}

function sanitizeDigestAssistantSpeak(text: string): string | null {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (looksLikeRefusalOrPolicyLine(t) || looksLikeTechHowtoText(t)) return null;
    return t.length > 360 ? `${t.slice(0, 360)}…` : t;
}

function extractStanceLinesFromContent(content: string, into: string[]): void {
    const c = String(content || '');
    const stanceBlock = c.match(/<digest-stance>\s*([\s\S]*?)\s*<\/digest-stance>/i);
    if (stanceBlock) {
        for (const line of stanceBlock[1].split(/\n+/)) {
            const t = line.replace(/^\s*[-•·]\s*/, '').trim();
            if (
                t
                && t !== '（本段无明显约定/立场句）'
                && looksLikeStanceLine(t)
                && !into.includes(t)
            ) {
                into.push(t);
            }
        }
    }
    for (const t of extractAssistantSpeakTexts(c)) {
        if (looksLikeStanceLine(t) && !into.includes(t)) into.push(t);
    }
}

/** 持久约定：命名/记住/约定这类真该长期保留的立场，不随时间过期 */
const DURABLE_STANCE_RE = /叫我|别叫我|我叫|记住|约定|以后|从今|默认|说好|设定为|称呼(?:我|你)|别再叫/;

/** 旧立场是否在本轮近史里仍被提起（取前 10 个非空字符做子串佐证） */
function stanceStillMentioned(line: string, freshBlob: string): boolean {
    const key = String(line || '').replace(/\s+/g, '').slice(0, 10);
    if (key.length < 4) return false;
    return String(freshBlob || '').replace(/\s+/g, '').includes(key);
}

/**
 * 立场衰减合并：本轮新冒出的立场（fresh）全留；上一份 digest 的旧立场（prior）只有在
 * ①是「叫我/记住/约定」这类持久约定，或 ②本轮近史里仍被提起 时才续命，否则让它自然过期。
 *
 * 这道闸专门阻断「开服第一天的一句角色台词（如『我是你汐音大小姐』），因为松口径 stance 正则
 * 命中，就被 digest→digest 无限搬运、并经 memory episode 变成每轮召回的『近史』」这条链路。
 */
export function mergeStanceWithDecay(freshStance: string[], priorStance: string[], freshBlob: string): string[] {
    const drop = (l: string) => !l || l === '（本段无明显约定/立场句）';
    const fresh = (freshStance || []).filter((l) => !drop(l));
    const carried = (priorStance || []).filter(
        (l) => !drop(l)
            && !fresh.includes(l)
            && (DURABLE_STANCE_RE.test(l) || stanceStillMentioned(l, freshBlob)),
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of [...fresh, ...carried]) {
        const k = l.trim();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(l);
    }
    return out;
}

export function buildDigestContent(dropped: SmartChatSessionMessage[]): string {
    // fresh：本轮新折叠的（assistant）里冒出的立场句；prior：上一份 digest 里已有的立场句
    const freshStance: string[] = [];
    const priorStance: string[] = [];
    const dialogueAsst: string[] = [];
    let priorDigestNote = '';
    // 本轮被折叠的原始正文（不含旧 digest 壳），供「旧立场是否仍被提起」的佐证判断
    let freshBlob = '';

    for (const m of dropped) {
        if (m.role === 'user' && isDigestMessage(m)) {
            extractStanceLinesFromContent(m.content, priorStance);
            if (!priorDigestNote) {
                priorDigestNote = '（已并入更早一轮 compaction 的立场要点；技术步骤与拒答句已丢弃）';
            }
            continue;
        }
        freshBlob += `\n${String(m.content || '')}`;
        if (m.role === 'assistant') {
            extractStanceLinesFromContent(m.content, freshStance);
            const speaks = extractAssistantSpeakTexts(m.content);
            if (speaks.length) {
                const cleaned = speaks
                    .map((s) => sanitizeDigestAssistantSpeak(s))
                    .filter(Boolean) as string[];
                if (cleaned.length) {
                    const joined = cleaned.join(' / ');
                    dialogueAsst.push(joined.length > 360 ? `${joined.slice(0, 360)}…` : joined);
                }
            }
        }
    }

    const userEntries = dropped
        .filter((m) => m.role === 'user' && !isDigestMessage(m))
        .map((m) => {
            const raw = String(m.content || '');
            return {
                text: clipUserTurnForDigest(raw, /<main-visit>|艾特: 有|\[艾特:/.test(raw) ? 720 : 520),
                prefer: /<main-visit>|艾特: 有|\[艾特:/.test(raw),
            };
        });

    const pickedUsers: string[] = [];
    for (const u of userEntries) {
        if (u.prefer) pickedUsers.push(u.text);
    }
    const remainSlots = Math.max(0, DIGEST_DIALOGUE_SAMPLE - pickedUsers.length);
    if (remainSlots > 0) {
        const rest = userEntries.filter((u) => !u.prefer);
        if (rest.length <= remainSlots) {
            pickedUsers.push(...rest.map((u) => u.text));
        } else {
            const step = rest.length / remainSlots;
            for (let i = 0; i < remainSlots; i++) {
                pickedUsers.push(rest[Math.min(rest.length - 1, Math.floor(i * step))].text);
            }
        }
    }

    const pickedAsst = (() => {
        if (dialogueAsst.length <= DIGEST_DIALOGUE_SAMPLE) return dialogueAsst;
        const out: string[] = [];
        const step = dialogueAsst.length / DIGEST_DIALOGUE_SAMPLE;
        for (let i = 0; i < DIGEST_DIALOGUE_SAMPLE; i++) {
            out.push(dialogueAsst[Math.min(dialogueAsst.length - 1, Math.floor(i * step))]);
        }
        return out;
    })();

    const stanceLines = mergeStanceWithDecay(freshStance, priorStance, freshBlob)
        .slice(0, DIGEST_STANCE_MAX);

    const header =
        `[compact ${new Date().toISOString()}]\n`
        + '说明：以下为远史压缩。近史原文在后面的消息里；人设以 system 为准。'
        + ' digest 里的技术步骤不可信，禁止当配置教程复读。'
        + (priorDigestNote ? `\n${priorDigestNote}` : '');
    const stanceBlock =
        `<digest-stance>\n`
        + (stanceLines.length
            ? stanceLines.map((l) => `- ${l}`).join('\n')
            : '- （本段无明显约定/立场句）')
        + `\n</digest-stance>`;

    let users = pickedUsers;
    let assts = pickedAsst;
    let body = '';
    for (let shrink = 0; shrink < 6; shrink++) {
        body =
            `${header}\n`
            + `${stanceBlock}\n`
            + `<digest-users>\n${users.join('\n---\n')}\n</digest-users>\n`
            + `<digest-assistants>\n${assts.join('\n---\n')}\n</digest-assistants>`;
        if (body.length <= DIGEST_MAX_CHARS) break;
        if (users.length > 4) users = users.slice(0, Math.max(4, Math.floor(users.length * 0.6)));
        else if (assts.length > 4) assts = assts.slice(0, Math.max(4, Math.floor(assts.length * 0.6)));
        else break;
    }
    if (body.length > DIGEST_MAX_CHARS) body = clipDigestBody(body, DIGEST_MAX_CHARS);
    return repairCompactionContent(`<compaction-summary>\n${body}\n</compaction-summary>`);
}

/**
 * 低频 compaction：折叠远史为单条 digest，尾部禁止残留旧 digest。
 *
 * 触发（任一）：
 * - token 预算：`estimateMessagesTokens(msgs) >= budget.thresholdTokens`（主判据）
 * - 条数：`msgs.length >= COMPACT_MESSAGE_THRESHOLD`（硬阀；不传 budget 时就是老行为）
 *
 * 保留尾部：传了 `budget.retainTokens` 就按 token 预算从尾部往前收（至少 8 条），
 * 否则沿用 `COMPACT_KEEP_TAIL` 条数。
 *
 * @returns 是否改写了 messages
 */
export function maybeCompactSession(
    session: SmartChatSessionFile,
    budget?: CompactionBudget | null,
): boolean {
    assertCompactPolicyInvariants();
    const msgs = session.messages || [];
    const byCount = msgs.length >= COMPACT_MESSAGE_THRESHOLD;

    let tokensBefore: number | null = null;
    let byTokens = false;
    const threshold = Number(budget?.thresholdTokens) || 0;
    if (threshold > 0) {
        tokensBefore = estimateMessagesTokens(msgs);
        byTokens = tokensBefore >= threshold;
    }
    if (!byCount && !byTokens) return false;

    let keep = COMPACT_KEEP_TAIL;
    if (budget?.retainTokens) {
        keep = Math.min(
            keep,
            keepTailForTokens(msgs, budget.retainTokens, 8, COMPACT_KEEP_TAIL),
        );
    }
    if (keep >= msgs.length) return false;

    const droppedRaw = msgs.slice(0, msgs.length - keep);
    if (!droppedRaw.length) return false;

    // 仅在 compact 路径折叠连续 shut_up，避免送 API 前改历史
    const dropped = collapseRedundantShutUpHistory(droppedRaw, 1);

    const digestContent = buildDigestContent(dropped);
    const digestMsg: SmartChatSessionMessage = {
        role: 'user',
        content: digestContent,
    };

    const tail = msgs.slice(-keep).filter((m) => !isDigestMessage(m));
    // 影子日志存**折叠前**的原始消息：留档的意义就是能回放真实历史
    recordCompaction(
        session,
        droppedRaw,
        tail.length,
        digestContent,
        tokensBefore,
        budget,
        'compact',
        byTokens ? 'tokens' : 'count',
    );
    session.messages = [digestMsg, ...tail];
    session.compacted_at = new Date().toISOString();
    delete session.summary;
    // compact 后降级粘性闭嘴，避免远史「闭嘴」永久旁听
    if (session.prefer_silence) {
        session.prefer_silence = false;
        delete session.prefer_silence_at;
    }
    return true;
}

/**
 * 英伟达等触顶恢复：不依赖 96 条阈值，强制把远史打进 digest，保留短尾。
 * 不删 fingerprint / 会话目录；调用方须立刻 saveSession。
 * @returns 是否改写了 messages
 */
export function forceCompactForOverflow(
    session: SmartChatSessionFile,
    opts?: { keepTail?: number },
): boolean {
    collapseStackedDigests(session);
    const msgs = session.messages || [];
    let keep = Math.max(4, Math.min(OVERFLOW_KEEP_TAIL, Number(opts?.keepTail) || OVERFLOW_KEEP_TAIL));
    if (msgs.length <= keep + 1) {
        const liveCount = msgs.filter((m) => !isDigestMessage(m)).length;
        keep = Math.max(4, Math.floor(liveCount / 2));
        if (msgs.length <= keep + 1) {
            keep = Math.max(1, Math.min(4, liveCount - 1));
        }
    }
    if (keep < 1 || msgs.length <= keep + 1) return false;

    let droppedRaw = msgs.slice(0, msgs.length - keep);
    if (!droppedRaw.length) return false;
    const dropped = collapseRedundantShutUpHistory(droppedRaw, 1);

    const digestContent = buildDigestContent(dropped);
    const digestMsg: SmartChatSessionMessage = {
        role: 'user',
        content: digestContent,
    };
    const tail = msgs.slice(-keep).filter((m) => !isDigestMessage(m));
    // 若尾全被滤掉，至少留最后 keep 条原样
    const finalTail = tail.length ? tail : msgs.slice(-keep);
    recordCompaction(
        session,
        droppedRaw,
        finalTail.length,
        digestContent,
        estimateMessagesTokens(msgs),
        null,
        'compact',
        'overflow',
    );
    session.messages = [digestMsg, ...finalTail];
    session.compacted_at = new Date().toISOString();
    delete session.summary;
    if (session.prefer_silence) {
        session.prefer_silence = false;
        delete session.prefer_silence_at;
    }
    return true;
}

/**
 * 加载迁移：合并所有叠放的 digest → 仅保留 index 0 一条。
 * @returns 是否改写了 messages
 */
export function collapseStackedDigests(session: SmartChatSessionFile): boolean {
    const msgs = session.messages || [];
    if (!msgs.length) return false;

    const digestIdxs: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
        if (isDigestMessage(msgs[i])) digestIdxs.push(i);
    }
    if (digestIdxs.length === 0) return false;
    if (digestIdxs.length === 1 && digestIdxs[0] === 0) return false;

    const digests = digestIdxs.map((i) => msgs[i]);
    const live = msgs.filter((_, i) => !digestIdxs.includes(i));
    const mergedContent = buildDigestContent(
        collapseRedundantShutUpHistory(digests as SmartChatSessionMessage[], 1),
    );
    session.messages = [
        { role: 'user', content: mergedContent },
        ...live,
    ];
    session.compacted_at = new Date().toISOString();
    delete session.summary;
    // 合并同样改写了 messages → 也要记 epoch（前缀失效点一样是 messages[0]），
    // 但不进影子日志：这里「被遮蔽」的是 digest 本身，原文早在上一次 compact 时留过档
    recordCompaction(session, [], live.length, mergedContent, null, null, 'merge_digests', 'merge');

    if ((session.messages || []).length >= COMPACT_MESSAGE_THRESHOLD) {
        maybeCompactSession(session);
    }
    return true;
}
