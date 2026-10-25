// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — Compose（Reasonix：cache-stable system + turn 尾）
// ---------------------------------------------------------------------------
//
// - config.system_prompt：仅【你是谁】定义句；拼上插件默认策略后整段会话 byte-stable
// - session.messages：与送进 API 的内容 byte-identical（prepend-only）
// - 技能树自定义：会话内冻结一份文本挂稳定 system（不再每轮重复灌 user turn）
// - chat-facts：本群静态事实（群号/群名/资历/群身份/入群），会话锁定 → 同样进稳定 system
// - compaction digest：已作为消息永久写入 session，不再每轮重复注入
// - host-state：只留本轮真正会变的运行事实（行为范围、沉默计数、艾特主/次访问、联网识图等）
//   不写场况死检测标签；要不要回 / 回什么留给固定【在场】两步自判

import type { SmartChatBufferEntry, SmartChatConfig, SmartChatKnowledgeEntry, SmartChatSessionFile } from './smart-chat-types';
import { assembleSystemPromptBase, stripHostPanelBlocks, DEFAULT_PERSONA_LINE, FAKE_THINK_SYSTEM_SUFFIX, hasSeenNativeThinking, nativeThinkingKey } from './smart-chat-types';
import { getPrependOnlyMessages, sliceMessagesByRounds } from './smart-chat-session';
import { TOOLS_SYSTEM_SUFFIX, hasAnySearchKey, toolsShouldAttach } from './smart-chat-tools';
import { IMAGE_RECOGNIZE_SYSTEM_SUFFIX, presentImageSupplementsForModel } from './smart-chat-image';
import { presentFileNotesForModel } from './smart-chat-file';
import { CHINA_SENSITIVE_SYSTEM_SUFFIX, FACTUALITY_SYSTEM_SUFFIX } from './smart-chat-safety';
import { PROTOCOL_SYSTEM_SUFFIX, buildLoreBlock } from './smart-chat-knowledge';
import { buildMkApiSystemSuffix } from '../ai/index.js';
import { assessBatchScene, batchAddressedToBot, type BatchScene } from './smart-chat-scene';
import { buildSilenceVetoSeed, decideSilence, mergeSilenceHostHints } from './smart-chat-silence';
import { formatAtMetaTag, formatGroupRoleTag, formatGroupTitleTag, formatReplyMetaTag } from './smart-chat-inbound';
import { applyBotNickToSystemPrompt, BOT_NICK_FALLBACK } from './smart-chat-identity';
import { buildStylePackBlock, formatRecentStyleHostHint } from './smart-chat-style';
import { formatRecentStickerHostHint, batchWantsStickerText } from './smart-chat-sticker';

export interface ComposedTurn {
    systemPrompt: string;
    apiMessages: Array<{ role: string; content: string }>;
    /** 与送进 API 的当前 user 消息完全一致，必须原样写入 session */
    userContentExact: string;
    userTurnPlain: string;
    knowledgeBlock: string;
    /** 结构场况：silenceBias 供出站校正；身份行不进闸门 */
    scene: BatchScene;
    /** system + 历史（不含本轮 tip）的稳定 hash */
    prefixHash: string;
    /** 本轮 system+history 是否等于上轮全文 hash（Reasonix 前缀可命中判据） */
    prefixStable: boolean;
    /** prefixStable=false 的归因：compacted（刚压过，预期内）/ drifted（前缀被改脏） */
    prefixResetReason: string;
    /** 本轮会话的压缩代数（A② 台账用） */
    compactionEpoch: number;
    /** historyRounds>0 等显式截断时为 true（cache-reset） */
    cacheReset: boolean;
    /** 本轮实际用于 system 后缀的冻结能力 */
    systemCaps: { tools: boolean; image: boolean; sticker: boolean; think: boolean };
    /** 确定性对话关系图（供沉默决策与日志核对） */
    talkGraph: TalkGraphResult;
}

/** 话题与上次访问的关系（供 host-state / 测调用） */
export type TopicContinuity = 'none' | 'related' | 'unrelated';

const TOPIC_STOPWORDS = new Set([
    '这个', '那个', '什么', '怎么', '怎样', '可以', '不是', '就是', '我们', '你们', '他们', '没有', '还是',
    '一个', '一下', '真的', '觉得', '知道', '然后', '因为', '所以', '如果', '已经', '现在', '时候',
    '东西', '问题', '直接', '出来', '过来', '起来', '这样', '那样', '哈哈', '呵呵', '嗯嗯', '好的',
    '收到', '谢谢', '请问', '大家', '自己', '怎么了', '怎么样', '为什么', '是不是', '有没有',
    // 识图/布局噪声，避免「话题相关」误判
    '图片', '解析', '整体', '布局', '画面', '界面', '视觉', '元素', '风格', '区域', '顶部', '底部',
    '左侧', '右侧', '详细', '描述', '展示', '呈现', '补充', '眼睛', 'msgid', '加载', '不出来',
    '签到', '欢迎', '加入', '通过', '审核',
    '图片', '解析', '结果', '补充', '加载', '不出', '发了', '张图', '眼睛', '引用', '艾特',
    'msgid', 'http', 'https', 'www', 'com', 'html', 'json', 'null', 'true', 'false',
]);

function formatBatchLines(batch: SmartChatBufferEntry[]): string {
    const nickByQq = new Map<string, string>();
    for (const b of batch) {
        const qq = String(b.userId || '').trim();
        const nick = String(b.nickname || '').trim();
        if (qq && nick) nickByQq.set(qq, nick);
        const rq = String(b.replyToUserId || '').trim();
        const rn = String(b.replyToNickname || '').trim();
        if (rq && rn) nickByQq.set(rq, rn);
    }
    const lines = batch
        .map((b) => {
            const text = presentFileNotesForModel(presentImageSupplementsForModel(b.text || ''));
            // 纯眼睛/文件备注：不挂昵称，避免被当成用户发言
            if (/^\[眼睛\s+msgid:/i.test(text.trim()) || /^\[文件\s+msgid:/i.test(text.trim())) {
                return text.trim();
            }
            const nick = b.nickname || b.userId;
            // 头衔紧跟 昵称(QQ)，再挂群身份；没头衔时整段不出现
            let meta = formatGroupTitleTag(b.groupTitle);
            meta += formatGroupRoleTag(b.groupRole);
            if (b.messageId) meta += ` [msgid:${b.messageId}]`;
            meta += formatReplyMetaTag(b);
            meta += formatAtMetaTag(b.atQqs, nickByQq);
            return `[${b.time}] ${nick}(${b.userId})${meta}: ${text}`;
        })
        .join('\n');
    return lines;
}

/** talk-graph 段字符上限：不能让它把面板占比顶回去 */
export const TALK_GRAPH_MAX_CHARS = 400;

/** 关系图跳过的非发言行（识图补充、眼睛备注） */
function isRelationNoise(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/^\[眼睛\s+msgid:/i.test(t)) return true;
    if (/^\[文件\s+msgid:/i.test(t)) return true;
    if (/^补充：/.test(t)) return true;
    return false;
}

export interface TalkGraphResult {
    /** 渲染好的 <talk-graph> 段；无可用关系时为空串 */
    text: string;
    /** 直接对 bot 说话的人（QQ，按出现顺序去重） */
    toBot: string[];
    /** 会话线程数（不含独立话头） */
    threads: number;
    /**
     * 结论是否可用（与 text 是否渲染无关）。
     * 单条批次不渲染 text，但 toBot 照样算得出来 —— 沉默决策要看的是这个标志，
     * 不是 text 是否为空。1.3.1 用 Boolean(text) 当判据，等于把「一个人自言自语、
     * 没在跟你说话」这类批次全判成「没信号」，正好漏掉最该闭嘴的场合。
     * 拿不到 self_id 时算不出对谁说话，标 false。
     */
    computed: boolean;
}

/**
 * 确定性对话关系图：只用 OneBot 事件里已有的引用 / 艾特字段算，零模型推理、零延迟。
 *
 * 模型缺的不是原始标记（[引用→X] [艾特 Y] 一直都在），而是「所以这句不是对我说的」
 * 这个结论。16 代实测它会自己做关系解析、还把解析过程当回复念出来
 * （"寒愁洛的『你买了吗』是针对潇的…，不是在问你哦"），既错又出戏。
 */
export function buildTalkGraph(
    batch: SmartChatBufferEntry[],
    selfId: string,
    botNickname?: string,
): TalkGraphResult {
    const sid = String(selfId || '').trim();
    const list = (batch || []).filter((b) => b && !isRelationNoise(b.text));
    const empty: TalkGraphResult = { text: '', toBot: [], threads: 0, computed: false };
    if (!list.length) return empty;

    const nickByQq = new Map<string, string>();
    for (const b of list) {
        const qq = String(b.userId || '').trim();
        const nick = String(b.nickname || '').trim();
        if (qq && nick) nickByQq.set(qq, nick);
        const rq = String(b.replyToUserId || '').trim();
        const rn = String(b.replyToNickname || '').trim();
        if (rq && rn && !nickByQq.has(rq)) nickByQq.set(rq, rn);
    }
    // 昵称先裁到 8 字，再按「裁完的短名」判重名——裁剪本身也会撞名，
    // 撞了不补尾号会把两个人并成一个，正好毁掉关系图要解决的问题。
    const shortOf = (nick: string): string => (nick.length > 8 ? `${nick.slice(0, 8)}…` : nick);
    const shortByQq = new Map<string, string>();
    for (const [qq, nick] of nickByQq) shortByQq.set(qq, shortOf(nick));
    const qqByShort = new Map<string, Set<string>>();
    for (const [qq, s] of shortByQq) {
        if (!qqByShort.has(s)) qqByShort.set(s, new Set());
        qqByShort.get(s).add(qq);
    }
    const label = (qq: string): string => {
        const q = String(qq || '').trim();
        if (!q) return '?';
        if (sid && q === sid) return '你';
        const s = shortByQq.get(q) || q;
        return (qqByShort.get(s)?.size || 0) > 1 ? `${s}(…${q.slice(-4)})` : s;
    };

    const edges: { from: string; to: string }[] = [];
    const solo: string[] = [];
    const toBot: string[] = [];
    const toBotMsgIds: string[] = [];
    for (const b of list) {
        const from = String(b.userId || '').trim();
        if (!from || (sid && from === sid)) continue;
        const targets: string[] = [];
        const rq = String(b.replyToUserId || '').trim();
        if (rq && rq !== from) targets.push(rq);
        for (const q of b.atQqs || []) {
            const t = String(q || '').trim();
            if (t && t !== from && !targets.includes(t)) targets.push(t);
        }
        if (sid && targets.includes(sid)) {
            if (!toBot.includes(from)) toBot.push(from);
            const mid = String(b.messageId || '').trim();
            if (mid && !toBotMsgIds.includes(mid)) toBotMsgIds.push(mid);
        }
        if (!targets.length) {
            if (!solo.includes(from)) solo.push(from);
            continue;
        }
        for (const t of targets) {
            if (!edges.some((e) => e.from === from && e.to === t)) edges.push({ from, to: t });
        }
    }

    // 有向边并成无向连通分量 = 一条会话线
    const parent = new Map<string, string>();
    const find = (x: string): string => {
        let r = x;
        while (parent.get(r) && parent.get(r) !== r) r = parent.get(r);
        parent.set(x, r);
        return r;
    };
    for (const e of edges) {
        if (!parent.has(e.from)) parent.set(e.from, e.from);
        if (!parent.has(e.to)) parent.set(e.to, e.to);
        const ra = find(e.from);
        const rb = find(e.to);
        if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map<string, string[]>();
    for (const e of edges) {
        const root = find(e.from);
        if (!groups.has(root)) groups.set(root, []);
        const arrows = groups.get(root);
        const arrow = `${label(e.from)}→${label(e.to)}`;
        if (!arrows.includes(arrow)) arrows.push(arrow);
    }

    const rel: string[] = [];
    let n = 0;
    for (const arrows of groups.values()) {
        n += 1;
        rel.push(`线${n} ${arrows.join(' · ')}`);
    }
    const soloOutside = solo.filter((q) => !parent.has(q));
    if (soloOutside.length) rel.push(`独立话头 ${soloOutside.map(label).join('、')}`);

    // 单条消息：关系图只会是空话（被艾特这个事实 host-state 已经报了，msgid 就在正文行里）；
    // 但 toBot 仍要算出来给沉默决策用，所以只清文本、不清结论数据。
    if (list.length < 2) return { text: '', toBot, threads: groups.size, computed: Boolean(sid) };

    let conclusion: string;
    if (!sid) {
        conclusion = '';
    } else if (toBot.length) {
        const who = toBot.map(label).join('、');
        conclusion = toBotMsgIds.length
            ? `结论 指向本账号: ${who}（msgid ${toBotMsgIds.slice(0, 3).join(',')}）`
            : `结论 指向本账号: ${who}`;
    } else {
        conclusion = '结论 指向本账号: 无';
        // 「你」错位是 16 代最典型的翻车：别人互相说「你」，它当成在问自己，
        // 还反过来指责对方「突然插嘴」。这句只在确实没人点你时补，属于按需强化。
        // 昵称点名没有事件字段，复用 scene 的同一个判定（别在这儿再写一套昵称匹配）。
        const addressed = batchAddressedToBot(list, sid, false, botNickname);
        const secondPerson = list.some((b) => String(b.text || '').includes('你'));
        if (!addressed && secondPerson) conclusion += '；批内「你」均非指向本账号';
    }

    // 怎么读这段（照结论办、别念出来）写在稳定 system 的 [钉楼点名] 里，这里只放事实
    const render = (keep: string[], dropped: number): string => {
        const body = [...keep];
        if (dropped > 0) body.push(`…另 ${dropped} 条关系省略`);
        const inner = [...body, conclusion].filter(Boolean).join('\n');
        return `<talk-graph>\n${inner}\n</talk-graph>`;
    };

    let keep = rel;
    let text = render(keep, 0);
    while (text.length > TALK_GRAPH_MAX_CHARS && keep.length > 0) {
        keep = keep.slice(0, -1);
        text = render(keep, rel.length - keep.length);
    }
    return { text, toBot, threads: groups.size, computed: Boolean(sid) };
}

function buildSkillTreeBlock(entries: SmartChatKnowledgeEntry[]): string {
    if (!entries.length) return '';
    const lines = entries.map((e) => `${e.title.startsWith('◆') ? e.title : `◆ ${e.title}`}\n${e.content}`);
    return `<skill-tree>\n（本会话已装备的自定义技能；相关就释放，别当说明书背）\n${lines.join('\n\n')}\n</skill-tree>`;
}

/**
 * 技能树进稳定 system：会话内冻结一份文本，知识库没动就字节不变。
 * 技能增删（hash 变）才重新冻结 —— 只打断一次前缀缓存，历史与记忆一律不动。
 * searchKnowledgeTopM 本身不看 query（按 priority 取前 M），所以冻结不丢召回能力。
 */
export function resolveFrozenSkillTree(
    session: SmartChatSessionFile,
    entries: SmartChatKnowledgeEntry[],
): { text: string; hash: string; refrozen: boolean } {
    const text = buildSkillTreeBlock(Array.isArray(entries) ? entries : []);
    const hash = hashStableString(text);
    const prev = session?.frozen_skill_tree;
    if (!prev || String(prev.hash || '') !== hash) {
        if (session) session.frozen_skill_tree = { hash, text };
        return { text, hash, refrozen: Boolean(prev) };
    }
    return { text: String(prev.text || ''), hash, refrozen: false };
}

/**
 * 表情包 system 后缀进稳定前缀：按「已安装图库目录集合」冻结一份文本。
 * 装/卸图库（key 变）才重新冻结；同一图库里文件数变动（安装任务正在写盘、
 * 手动加了几张）不重算 —— 否则每轮 system 字节都在动，整段会话前缀缓存全丢。
 */
export function resolveFrozenStickerSuffix(
    session: SmartChatSessionFile,
    liveText: string,
    installKey: string,
): { text: string; key: string; refrozen: boolean } {
    const text = String(liveText || '');
    const key = String(installKey || '');
    if (!session) return { text, key, refrozen: false };
    const prev = session.frozen_sticker_suffix;
    if (!text) {
        // 本轮没有可用后缀（图库全卸/开关关闭）：不动已冻结的那份，交由 systemCaps 决定是否拼进 system
        return { text: String(prev?.text || ''), key: String(prev?.key || ''), refrozen: false };
    }
    if (!prev || String(prev.key || '') !== key) {
        session.frozen_sticker_suffix = { key, text };
        return { text, key, refrozen: Boolean(prev) };
    }
    return { text: String(prev.text || ''), key, refrozen: false };
}

function batchMentionsBot(batch: SmartChatBufferEntry[], selfId: string): boolean {
    const sid = String(selfId || '').trim();
    if (!sid) return false;
    return batch.some((b) => (b.atQqs || []).some((q) => String(q).trim() === sid));
}

function entryAtsBot(entry: SmartChatBufferEntry, selfId: string): boolean {
    const sid = String(selfId || '').trim();
    if (!sid) return false;
    return (entry.atQqs || []).some((q) => String(q).trim() === sid);
}

function eyeMsgidFromText(text: string): string | null {
    const m = String(text || '').match(/\[眼睛\s+msgid:(\d+)/i);
    return m ? m[1] : null;
}

/**
 * 艾特触发：艾特你的消息（及其眼睛补充）= 主访问；缓冲里其它 = 次访问。
 * 非艾特：不拆，整批 batch-messages。
 */
export function splitVisitByAtFocus(
    batch: SmartChatBufferEntry[],
    selfId: string,
): { atTriggered: boolean; primary: SmartChatBufferEntry[]; secondary: SmartChatBufferEntry[] } {
    const sid = String(selfId || '').trim();
    const primaryHuman = sid ? batch.filter((b) => entryAtsBot(b, sid)) : [];
    if (!primaryHuman.length) {
        return { atTriggered: false, primary: [], secondary: batch };
    }
    const primaryMsgIds = new Set(
        primaryHuman.map((b) => String(b.messageId || '').trim()).filter(Boolean),
    );
    const primary: SmartChatBufferEntry[] = [];
    const secondary: SmartChatBufferEntry[] = [];
    for (const b of batch) {
        if (entryAtsBot(b, sid)) {
            primary.push(b);
            continue;
        }
        const mid = String(b.messageId || '').trim();
        if (mid && primaryMsgIds.has(mid)) {
            primary.push(b);
            continue;
        }
        const eyeId = eyeMsgidFromText(b.text || '');
        if (eyeId && primaryMsgIds.has(eyeId)) {
            primary.push(b);
            continue;
        }
        secondary.push(b);
    }
    return { atTriggered: true, primary, secondary };
}

/** 缓冲条目时间戳（'YYYY-MM-DD HH:mm:ss'，本地时区）→ ms；无法解析返回 NaN */
export function parseBufferTimeMs(time: string): number {
    const m = String(time || '').trim().match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
    );
    if (!m) return Number.NaN;
    return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6]), 0,
    ).getTime();
}

/**
 * 按时间戳升序稳定排序（无法解析时间的条目保持原相对位置）。
 * 缓冲顺序目前非单调（实测有 03:52:59 → 03:52:42），排一次让正文时间轴可读。
 */
export function sortBatchByTime(batch: SmartChatBufferEntry[]): SmartChatBufferEntry[] {
    const list = Array.isArray(batch) ? batch.map((b, i) => ({ b, i, t: parseBufferTimeMs(b?.time) })) : [];
    list.sort((x, y) => {
        const xt = Number.isFinite(x.t) ? x.t : Number.NaN;
        const yt = Number.isFinite(y.t) ? y.t : Number.NaN;
        if (Number.isFinite(xt) && Number.isFinite(yt) && xt !== yt) return xt - yt;
        return x.i - y.i;
    });
    return list.map((x) => x.b);
}

/** 陈旧拆批最少条数：不到这个数就整批同等对待，不值得拆 */
export const STALE_SPLIT_MIN_ENTRIES = 5;

/**
 * 陈旧拆批：距本批最新一条超过 cutoff 的消息降级为背景。
 * 参照点用「本批最新一条的时间戳」而非 Date.now()，保证同一批重算结果一致
 * （userContentExact 要原样进史，不能带墙上时钟）。
 */
export function splitVisitByStaleness(
    batch: SmartChatBufferEntry[],
    cutoffMs: number,
): { staleSplit: boolean; fresh: SmartChatBufferEntry[]; stale: SmartChatBufferEntry[]; staleMinutes: number } {
    const none = { staleSplit: false, fresh: batch || [], stale: [], staleMinutes: 0 };
    const list = Array.isArray(batch) ? batch : [];
    const cutoff = Number(cutoffMs);
    if (list.length < STALE_SPLIT_MIN_ENTRIES || !Number.isFinite(cutoff) || cutoff <= 0) return none;
    const stamps = list.map((b) => parseBufferTimeMs(b?.time)).filter((n) => Number.isFinite(n));
    if (stamps.length < 2) return none;
    const newest = Math.max(...stamps);
    const fresh: SmartChatBufferEntry[] = [];
    const stale: SmartChatBufferEntry[] = [];
    let oldestStale = newest;
    for (const b of list) {
        const t = parseBufferTimeMs(b?.time);
        // 时间戳缺失/不可解析：当新消息处理，不误降级
        if (!Number.isFinite(t) || newest - t <= cutoff) {
            fresh.push(b);
            continue;
        }
        stale.push(b);
        if (t < oldestStale) oldestStale = t;
    }
    // 全陈旧（整批都是老消息）：没有「近窗口」可言，不拆
    if (!stale.length || !fresh.length) return none;
    return {
        staleSplit: true,
        fresh,
        stale,
        staleMinutes: Math.max(1, Math.round((newest - oldestStale) / 60000)),
    };
}

/** 本轮访问分层：主访问 / 次访问的来源与理由 */
export interface BatchVisitLayout {
    /** 艾特触发（主访问 = 艾特你的消息） */
    atTriggered: boolean;
    /** 陈旧拆批触发（主访问 = 近窗口的新消息） */
    staleSplit: boolean;
    primary: SmartChatBufferEntry[];
    secondary: SmartChatBufferEntry[];
    /** 次访问里最早一条比本批最新一条老了多少分钟（仅 staleSplit） */
    staleMinutes: number;
}

/**
 * 决定本轮怎么分层：艾特优先，其次陈旧拆批，都不成立则整批同等。
 * 艾特与陈旧不叠加——被点名时整批都算当前话题，不该把点名前的上下文降级。
 */
export function resolveBatchVisit(
    batch: SmartChatBufferEntry[],
    selfId: string,
    staleCutoffMs: number,
): BatchVisitLayout {
    const at = splitVisitByAtFocus(batch, selfId);
    if (at.atTriggered) {
        return {
            atTriggered: true,
            staleSplit: false,
            primary: at.primary,
            secondary: at.secondary,
            staleMinutes: 0,
        };
    }
    const stale = splitVisitByStaleness(batch, staleCutoffMs);
    if (stale.staleSplit) {
        return {
            atTriggered: false,
            staleSplit: true,
            primary: stale.fresh,
            secondary: stale.stale,
            staleMinutes: stale.staleMinutes,
        };
    }
    return {
        atTriggered: false,
        staleSplit: false,
        primary: [],
        secondary: batch,
        staleMinutes: 0,
    };
}

function extractBatchBlobFromUserContent(userContent: string): string {
    const raw = String(userContent || '');
    const chunks: string[] = [];
    const re = /<(?:main-visit|side-context|batch-messages)>\s*([\s\S]*?)\s*<\/(?:main-visit|side-context|batch-messages)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
        chunks.push(m[1]);
    }
    if (chunks.length) return chunks.join('\n');
    return raw
        .replace(/<host-state>[\s\S]*?<\/host-state>/gi, ' ')
        .replace(/<(?:knowledge|skill-tree)>[\s\S]*?<\/(?:knowledge|skill-tree)>/gi, ' ')
        .replace(/<talk-graph>[\s\S]*?<\/talk-graph>/gi, ' ');
}

/** 从一批正文抽话题词（中英），用于与上次访问比相关性 */
export function extractTopicTokens(text: string): Set<string> {
    let s = String(text || '');
    s = s
        .replace(/<host-state>[\s\S]*?<\/host-state>/gi, ' ')
        .replace(/<(?:knowledge|skill-tree)>[\s\S]*?<\/(?:knowledge|skill-tree)>/gi, ' ')
        .replace(/<talk-graph>[\s\S]*?<\/talk-graph>/gi, ' ')
        .replace(/\[眼睛[^\]]*\]:[^\n]*/gi, ' ')
        .replace(/补充：[\s\S]*?(?=\n\[|\n<|$)/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\[[^\]]{0,40}\]/g, ' ')
        .replace(/\b\d{4,}\b/g, ' ');

    const out = new Set<string>();
    for (const w of s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []) {
        if (!TOPIC_STOPWORDS.has(w)) out.add(w);
    }
    const hans = s.match(/[\u4e00-\u9fff]{2,8}/g) || [];
    for (const chunk of hans) {
        if (chunk.length <= 4) {
            if (!TOPIC_STOPWORDS.has(chunk)) out.add(chunk);
        } else {
            for (let i = 0; i + 2 <= chunk.length; i += 1) {
                const bi = chunk.slice(i, i + 2);
                if (!TOPIC_STOPWORDS.has(bi)) out.add(bi);
            }
            for (let i = 0; i + 3 <= chunk.length; i += 1) {
                const tri = chunk.slice(i, i + 3);
                if (!TOPIC_STOPWORDS.has(tri)) out.add(tri);
            }
        }
    }
    return out;
}

/**
 * 看本轮缓冲/主访正文里，是否还有与「上一次访问」相关的内容。
 * related = 话题未刷新；unrelated = 已换场；none = 无上次可对比。
 * 会把上一轮 assistant 可见回复一并纳入对比（避免「你刚说完、对方顺着问」被判无关）。
 */
export function detectTopicContinuity(
    prevUserContent: string | null | undefined,
    currentBlob: string,
    prevAssistantContent?: string | null,
): TopicContinuity {
    const prevUserBlob = extractBatchBlobFromUserContent(String(prevUserContent || ''));
    const prevAsst = String(prevAssistantContent || '')
        .replace(/<\/?replies>/gi, ' ')
        .replace(/<\/?msg\b[^>]*>/gi, ' ')
        .replace(/<sticker>[\s\S]*?<\/sticker>/gi, ' ')
        .replace(/<react\b[^>]*?\/>/gi, ' ')
        .replace(/<shut_up\s*\/?\s*>/gi, ' ');
    const prevBlob = [prevUserBlob, prevAsst].filter((s) => s.trim()).join('\n');
    if (!prevBlob.trim() || !String(currentBlob || '').trim()) return 'none';
    const prev = extractTopicTokens(prevBlob);
    const curr = extractTopicTokens(currentBlob);
    if (prev.size < 2 || curr.size < 2) return 'none';

    let hits = 0;
    let strongHits = 0;
    for (const t of prev) {
        if (!curr.has(t)) continue;
        hits += 1;
        if (t.length >= 3) strongHits += 1;
    }
    const denom = Math.min(prev.size, curr.size, 24);
    const ratio = hits / Math.max(1, denom);
    // 提高门槛，减少跨场误报「与上次相关」
    if (strongHits >= 3 || (hits >= 4 && ratio >= 0.22) || ratio >= 0.32) return 'related';
    return 'unrelated';
}

function getLastUserTurnContent(session: SmartChatSessionFile): string | null {
    const msgs = session?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === 'user' && String(msgs[i].content || '').trim()) {
            return String(msgs[i].content);
        }
    }
    return null;
}

function getLastAssistantTurnContent(session: SmartChatSessionFile): string | null {
    const msgs = session?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === 'assistant' && String(msgs[i].content || '').trim()) {
            return String(msgs[i].content);
        }
    }
    return null;
}

/** 本轮正文分段：拆批时 main-visit + side-context，整批同等时 batch-messages */
export function formatVisitBody(
    visit: BatchVisitLayout,
    all: SmartChatBufferEntry[],
): { body: string; plain: string } {
    const { atTriggered, staleSplit, primary, secondary, staleMinutes } = visit;
    if ((atTriggered || staleSplit) && primary.length) {
        const main = formatBatchLines(primary);
        const side = secondary.length ? formatBatchLines(secondary) : '';
        const mainNote = atTriggered
            ? '主访问：艾特你的消息，优先接这里；挑一句直接接，别把这批复述成结论'
            : '主访问：刚刚这几条才是当前话题，只接这里；挑其中你想接的那一句回，别把整段聊天复盘成「从X到Y」';
        const parts = [
            '<main-visit>\n（' + mainNote + '）\n' + main + '\n</main-visit>',
        ];
        if (side) {
            const sideNote = atTriggered
                ? '次访问：缓冲背景；主访答完后，明确指向本账号/未答完的提问可短带一句，禁止整批当作业逐条答'
                : `次访问：陈旧背景，最早的已过去约 ${staleMinutes} 分钟，多半不是同一件事；只当背景看，别逐条点评、别硬串成一个话题，更别替大家做总结`;
            parts.push('<side-context>\n（' + sideNote + '）\n' + side + '\n</side-context>');
        }
        const body = parts.join('\n\n');
        return { body, plain: side ? `${main}\n${side}` : main };
    }
    const plain = formatBatchLines(all);
    return {
        body: `<batch-messages>\n${plain}\n</batch-messages>`,
        plain,
    };
}

/** 用户口头偏好：仅「禁止引用」进会话；「要引用」只清除禁止，不强制定时触发 */
export function detectReplyPreference(text: string): 'ban' | 'ask' | null {
    const t = String(text || '');
    if (/别引用|不要引用|别再引用|禁止引用|别回复气泡|发消息别引用|不要用引用|别带引用/i.test(t)) {
        return 'ban';
    }
    if (/引用我|引用这条|回复这条|顶一下这条|请引用|带上引用|可以引用了|再用引用/i.test(t)) {
        return 'ask';
    }
    return null;
}

/** 用户口头偏好：闭嘴 / 解除闭嘴（不看群身份；被点名仍可由宿主放行） */
export function detectSpeakPreference(text: string): 'ban' | 'ask' | null {
    const t = String(text || '');
    if (
        /你可以闭嘴|准备闭嘴|别再回[了啦啊]?|不要再回|别插嘴|别吭声|别说话|不要说话|别回了|不要回[了复]?|闭嘴/i.test(t)
    ) {
        return 'ban';
    }
    if (/继续聊|你可以说话了|可以说了|解除闭嘴|回来聊天|回来吧(?!.*闭嘴)/i.test(t)) {
        return 'ask';
    }
    return null;
}

/** FNV-1a 32-bit → 8 位 hex（本地前缀稳定性观测用） */
export function hashStableString(input: string): string {
    let h = 0x811c9dc5;
    const s = String(input || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** system + 历史消息（不含本轮 tip）→ 前缀指纹 */
export function hashApiPrefix(
    systemPrompt: string,
    history: Array<{ role: string; content: string }>,
): string {
    const parts = [`system\n${String(systemPrompt || '')}`];
    for (const m of history || []) {
        parts.push(`${m.role}\n${String(m.content || '')}`);
    }
    return hashStableString(parts.join('\n\u0001\n'));
}

/**
 * 本轮若开口，从允许范围内确定性取一个建议条数（每条 msg / 每次 react / 每次 send_sticker 各算 1）。
 * min=0 时开口至少建议 1。禁止 Math.random——该字段会进 tip 永久进史。
 */
export function sampleSpeakActionCount(
    actionMin: number,
    actionMax: number,
    seedKey = '',
): number {
    let max = Math.min(10, Math.max(1, Math.floor(Number(actionMax) || 1)));
    let min = Math.max(0, Math.min(max, Math.floor(Number(actionMin) || 0)));
    const lo = Math.max(1, min);
    const hi = max;
    if (lo >= hi) return hi;
    const span = hi - lo + 1;
    const h = Number.parseInt(hashStableString(String(seedKey || '0')), 16) || 0;
    return lo + (h % span);
}

/** 历史 user 轮剥离（仅后台 UI / 旧数据迁移；禁止进 API 路径） */
export function stripHistoryUserMeta(content: string): string {
    return stripHostPanelBlocks(content).trim();
}

/**
 * 后台展示用：给历史 assistant 加「当时发出」标签（绝不进 API）。
 */
export function labelAssistantHistoryForApi(
    content: string,
    botNickname?: string,
    selfId?: string,
): string {
    const raw = String(content || '');
    if (!raw.trim()) return raw;
    if (/^（你「/.test(raw.trim())) return raw;
    const nick = String(botNickname || '').trim() || BOT_NICK_FALLBACK;
    const qq = String(selfId || '').trim();
    const who = qq ? `你「${nick}」(${qq})` : `你「${nick}」`;
    return `（${who} 当时发出）\n${raw}`;
}

/**
 * 会话内冻结 tools/image/sticker system 后缀；中途改开关不改写已冻结前缀。
 * think 例外：它跟着「当前模型」走，换模型时单独重算（模型换了前缀缓存本来也已失效）。
 */
export function resolveFrozenSystemCaps(
    session: SmartChatSessionFile,
    live: { tools: boolean; image: boolean; sticker: boolean; think: boolean },
    thinkModelKey?: string,
): { caps: { tools: boolean; image: boolean; sticker: boolean; think: boolean }; justFrozen: boolean; drifted: boolean } {
    const modelKey = String(thinkModelKey || '').trim().toLowerCase();
    if (!session.frozen_system_caps) {
        session.frozen_system_caps = {
            tools: Boolean(live.tools),
            image: Boolean(live.image),
            sticker: Boolean(live.sticker),
            think: Boolean(live.think),
            think_model: modelKey,
        };
        return { caps: { ...session.frozen_system_caps }, justFrozen: true, drifted: false };
    }
    // 模型换了（含轮替换厂商/换模型）→ think 重新按新模型冻结，其余三项保持不动
    const frozenModel = String(session.frozen_system_caps.think_model || '').trim().toLowerCase();
    if (modelKey && frozenModel !== modelKey) {
        session.frozen_system_caps.think = Boolean(live.think);
        session.frozen_system_caps.think_model = modelKey;
    }
    const caps = {
        tools: Boolean(session.frozen_system_caps.tools),
        image: Boolean(session.frozen_system_caps.image),
        sticker: Boolean(session.frozen_system_caps.sticker),
        think: Boolean(session.frozen_system_caps.think),
    };
    const drifted = caps.tools !== Boolean(live.tools)
        || caps.image !== Boolean(live.image)
        || caps.sticker !== Boolean(live.sticker)
        || caps.think !== Boolean(live.think);
    return { caps, justFrozen: false, drifted };
}

/**
 * 本群静态事实：会话锁定字段，整段会话不变 → 进稳定 system，不再每轮重复进 user。
 * 只陈述客观站位，不下达行为口令（分寸怎么拿捏在 WHO_LOCKED）。
 */
export function buildChatFactsBlock(
    session: SmartChatSessionFile,
    caps?: { tools?: boolean; image?: boolean; searchKey?: boolean },
): string {
    const lines: string[] = [];
    const gid = String(session?.group_id || '').trim();
    const isGroup = session?.chat_type === 'group' || Boolean(gid);
    if (isGroup) {
        lines.push('聊天：群聊');
        if (gid) lines.push(`群号：${gid}`);
        const gname = String(session?.group_name || '').trim();
        if (gname) lines.push(`群名：${gname}`);
        // 资历：会话锁定字段（禁止每轮按入群日边界跳变）
        const standing = String(session?.bot_standing || '').trim();
        if (standing) lines.push(`我的资历：${standing}`);
        const role = String(session?.bot_role_label || session?.bot_role || '').trim();
        if (role) lines.push(`我的群身份：${role}`);
        const joinAt = String(session?.bot_join_at || '').trim();
        if (joinAt) lines.push(`我的入群：${joinAt}`);
    } else {
        lines.push('聊天：私聊');
    }
    // 能力开关：会话内已冻结（中途改开关不改写已冻结前缀），属静态事实，不再每轮复述
    if (caps) {
        if (caps.tools) lines.push(caps.searchKey ? '联网：已开启' : '联网：开关已开但未配置搜索 Key');
        else lines.push('联网：未开启');
        lines.push(caps.image ? '识图：已开启' : '识图：未开启');
    }
    return `<chat-facts>\n${lines.join('\n')}\n</chat-facts>`;
}

/** 会话首次组 system 前把群号/群名/聊天类型补齐，保证 chat-facts 与后续轮字节一致 */
function backfillSessionChatFacts(session: SmartChatSessionFile, batch: SmartChatBufferEntry[]): void {
    if (!session) return;
    const snap = batch?.[batch.length - 1]?.eventSnapshot || {};
    const snapGid = String(snap.group_id || '').trim();
    if (!session.chat_type) {
        session.chat_type = String(snap.message_type || '') === 'group' || snapGid ? 'group' : 'private';
    }
    if (session.chat_type !== 'group') return;
    if (!session.group_id && snapGid) session.group_id = snapGid;
    const snapName = String(snap.group_name || '').trim();
    if (!session.group_name && snapName) session.group_name = snapName;
}

export function buildSessionSystemPrompt(
    config: SmartChatConfig,
    session: SmartChatSessionFile,
    systemCaps: { tools: boolean; image: boolean; sticker: boolean; think?: boolean },
    opts?: {
        botNickname?: string;
        stickerSystemSuffix?: string;
        /** 已安装图库目录集合；用于冻结表情后缀（缺省则按后缀文本自身冻结） */
        stickerInstallKey?: string;
        stylePackId?: string;
    },
): string {
    let systemPrompt = applyBotNickToSystemPrompt(
        assembleSystemPromptBase(config.system_prompt),
        opts?.botNickname || BOT_NICK_FALLBACK,
    );
    // 风格包（伪装群员示例）默认挂载；config.style_pack_enabled=false 时不挂 —— 避免通用群友腔盖过自定义人设
    const stylePackEnabled = config.style_pack_enabled !== false;
    const styleBlock = stylePackEnabled
        ? buildStylePackBlock(opts?.stylePackId || config.style_pack_id || 'groupie')
        : '';
    systemPrompt += PROTOCOL_SYSTEM_SUFFIX;
    if (styleBlock) systemPrompt += `\n${styleBlock}`;
    systemPrompt += FACTUALITY_SYSTEM_SUFFIX;
    systemPrompt += CHINA_SENSITIVE_SYSTEM_SUFFIX;
    // 能力段统一排在事实与硬边界之后：人设 → 身份在场 → 输出协议 → 风格 → 事实/硬边界 → 能力段
    systemPrompt += buildMkApiSystemSuffix();
    if (systemCaps.tools) systemPrompt += TOOLS_SYSTEM_SUFFIX;
    if (systemCaps.image) systemPrompt += IMAGE_RECOGNIZE_SYSTEM_SUFFIX;
    // 伪装思考：条件能力段（开关开且模型无原生思考）；剥离后不外发，只落盘
    if (systemCaps.think) systemPrompt += FAKE_THINK_SYSTEM_SUFFIX;
    if (systemCaps.sticker && opts?.stickerSystemSuffix) {
        // 会话内冻结：装/卸图库才换文本，图库内文件数变动不动已发出的前缀
        systemPrompt += resolveFrozenStickerSuffix(
            session,
            opts.stickerSystemSuffix,
            opts.stickerInstallKey || hashStableString(opts.stickerSystemSuffix),
        ).text;
    }
    // 会话内不变的两块收尾：本群静态事实 + 已冻结技能树（各只出现一次）
    systemPrompt += `\n\n${buildChatFactsBlock(session, {
        tools: systemCaps.tools,
        image: systemCaps.image,
        searchKey: hasAnySearchKey(config),
    })}\n`;
    const skillTree = String(session?.frozen_skill_tree?.text || '').trim();
    if (skillTree) systemPrompt += `\n${skillTree}\n`;
    // 人设复述放在整段 system 最尾（最强近因位）：几千字通用规则之后，让「你是谁」成为
    // 模型进对话前读到的最后一条约束，压住被稀释/被风格示例带平的问题。仅抬高人设优先级，
    // 不改写身份锚/硬边界（那些仍在前文各自的段里，此处不复制）。
    systemPrompt += buildPersonaRestatement(config, opts?.botNickname || BOT_NICK_FALLBACK);
    return systemPrompt;
}

/**
 * 人设复述块：把有效【你是谁】定义句原样放到 system 末尾，并声明其为最高优先。
 * 只强调「以人设的语气/脾气/用词为准，别被通用模板抹平」，不涉及任何内容边界。
 */
function buildPersonaRestatement(config: SmartChatConfig, botNickname: string): string {
    const personaLine = applyBotNickToSystemPrompt(
        String(config?.system_prompt ?? '').trim() || DEFAULT_PERSONA_LINE,
        botNickname || BOT_NICK_FALLBACK,
    );
    return (
        '\n\n【人设复述 · 最高优先】\n'
        + `开口前先对齐【你是谁】：${personaLine}\n`
        + '这是你唯一的身份底色，语气、脾气、用词、态度都以它为准。'
        + '上文的输出协议只约束格式，风格示例只作节奏参考，都不得把你的说话方式抹平成千篇一律的通用群友腔；'
        + '凡与人设冲突，一律以人设为准。\n'
        + '【接话规则 · 同样最高优先】\n'
        + '接话就是接话：挑现场某个人刚说的那一句，用自己的话直接回过去，像他们中间那个人一样开口。'
        + '禁止把别人几轮对话串成「从X到Y，结论是Z」的群聊播报；禁止用「刚才大家都在聊…」「这帮人聊得热火…」这种从外部点评群聊的口气——你是在群里说话的人，不是看台解说员。'
        + '只有对方明确要你「总结一下」时才总结；没人让你概括，就别概括、别复盘、别当群聊播报员。\n'
    );
}

const CN_NUM: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * 本批是否点名要表情包，以及约几张（仅写 host-state 事实；无请求/无数字则 null）。
 *
 * 只认真正的「要表情」请求。识图/文件备注（[眼睛]/[文件] 开头）与
 * 「发了N张[图片]」占位一律剔除——它们的 OCR 正文里满是「表情呆萌」「发了1张」，
 * 旧口径「命中`表情` + 任意`N张`」在二次元头像刷屏时会稳定误判成
 * 「对方点名要表情约 1 张」，把没人要图的轮次强行抬成 mustSpeak、还乱发一张表情。
 */
export function detectRequestedStickerCount(texts: string[]): number | null {
    const blob = (Array.isArray(texts) ? texts : [])
        .flatMap((t) => String(t || '').split(/\n+/))
        .map((l) => l.trim())
        .filter(Boolean)
        // 识图/文件备注不是群友发言：整行丢弃
        .filter((l) => !/^\[(?:眼睛|文件)\s/i.test(l))
        // 「…发了N张[图片]…」是宿主占位，不是「要表情」：剥掉这一段再看
        .map((l) => l.replace(/发了\s*\d+\s*张\s*\[图片\][^\n]*/g, ' '))
        .join('\n');
    if (!blob) return null;
    // 必须落在「发/来/整/求/要…表情/贴纸/斗图」这种请求语境里；OCR 里孤零零的「表情」不算
    const wantRe = /(?:发|来|整|搞|求|要|给|扔|甩|贴|想看|想要)[^。！？\n]{0,6}(?:表情包|表情|贴纸|斗图|动图|gif)|(?:表情包|表情|贴纸|斗图|动图|gif)[^。！？\n]{0,4}(?:来|发|整|搞|扔|甩|安排|走一个)/i;
    if (!wantRe.test(blob) && !batchWantsStickerText(blob)) return null;
    // 数量只认与表情词就近的量词，杜绝「发了1张[图片]」式误抓
    const near =
        blob.match(/(?:表情包|表情|贴纸|斗图|动图|gif)[^。！？\n]{0,6}?(\d+|[一二两三四五六七八九十])\s*[个张份]/i)
        || blob.match(/(\d+|[一二两三四五六七八九十])\s*[个张份][^。！？\n]{0,4}?(?:表情包|表情|贴纸|斗图|动图|gif)/i);
    if (near) {
        const g = String(near[1] || '');
        const n = /^\d+$/.test(g) ? Math.floor(Number(g)) : CN_NUM[g];
        if (n >= 1 && n <= 10) return n;
    }
    return null;
}

/** 次访问里像在找 bot 的条数（轻量启发式，仅写 host-state 事实） */
function countSideAddressedToBot(
    secondary: SmartChatBufferEntry[],
    selfId: string,
    botNickname?: string,
): number {
    const nick = String(botNickname || '').trim();
    const nickOk = nick && nick !== BOT_NICK_FALLBACK;
    let n = 0;
    for (const b of secondary) {
        const text = String(b.text || '').trim();
        if (!text || /^\[眼睛\s+msgid:/i.test(text)) continue;
        if (entryAtsBot(b, selfId)) {
            n += 1;
            continue;
        }
        // 明确 @ 了别人 / 引用了别人：这条是冲第三方去的，不算「在找 bot」
        const atsSomeoneElse = Array.isArray(b.atQqs)
            && b.atQqs.some((q) => String(q || '').trim() && String(q).trim() !== selfId);
        const repliesSomeoneElse = String(b.replyToUserId || '').trim()
            && String(b.replyToUserId).trim() !== selfId;
        if (atsSomeoneElse || repliesSomeoneElse) continue;
        if (nickOk && text.includes(nick)) {
            n += 1;
            continue;
        }
        if (/帮我|问你|你觉得|你会不会|能不能帮|求你|麻烦你|你怎么看|你说说|你懂/.test(text)) {
            n += 1;
            continue;
        }
        // 收紧旧口径：不再「含你 + 含问号」就算对你提问（群里第二人称多半指别人），
        // 只有第二人称紧贴疑问（你…吗/你…?）且没指向第三方时才算
        if (/你[^，。！？\n]{0,10}(?:吗|呢|吧)?[？?]/.test(text) && /你/.test(text)) {
            n += 1;
        }
    }
    return n;
}

/**
 * 本轮运行态快照：只报事实与数字，不下达行为口令。
 * 人设 / 参与方式 / 能力用法由 system_prompt 负责。
 */
function buildHostConstraint(
    config: SmartChatConfig,
    session: SmartChatSessionFile,
    batch: SmartChatBufferEntry[],
    visit: BatchVisitLayout,
    _topic: TopicContinuity,
    opts?: {
        imageRecognize?: boolean;
        toolsEnabled?: boolean;
        botNickname?: string;
        speakSeed?: string;
        /** 「没人对你说话」否决抽样种子；与 flush 预判必须同源，否则两处说两套 */
        vetoSeed?: string;
        /** 本轮确定性关系图：结论供沉默策略用（不再让模型自己推） */
        talkGraph?: TalkGraphResult | null;
    },
): { text: string; scene: BatchScene } {
    const lines: string[] = [];
    const min = Number(config.action_min) || 0;
    const max = Number(config.action_max) || 3;
    // 建议条数：确定性（chat+streak+batch）；硬截断仍看行为数 max
    const speakN = sampleSpeakActionCount(min, max, opts?.speakSeed || '');
    lines.push(`行为数 ${min}-${max}`);
    lines.push(`建议条数 ${speakN}`);

    const silenceAllowed = min === 0;
    if (silenceAllowed) {
        const limit = Math.max(1, Number(config.shut_up_limit) || 5);
        const streak = Math.max(0, Number(session.shut_up_streak) || 0);
        if (streak >= limit) {
            lines.push('沉默: 达上限（本轮必须开口）');
        } else {
            lines.push(`沉默计数 ${streak}/${limit}`);
        }
    } else {
        lines.push('不允许沉默');
    }

    const selfId = String(batch[batch.length - 1]?.eventSnapshot?.self_id ?? '');
    const atBot = batchMentionsBot(batch, selfId) || visit.atTriggered;
    lines.push(atBot ? '艾特: 有' : '艾特: 无');

    if (visit.atTriggered || visit.staleSplit) {
        lines.push(visit.atTriggered ? '访问：艾特主访' : '访问：近窗口主访');
        const ids = visit.primary
            .map((b) => String(b.messageId || '').trim())
            .filter(Boolean);
        const uniq = [...new Set(ids)];
        if (uniq.length) lines.push(`主访问 msgid: ${uniq.join(',')}`);
        lines.push(`次访问条数 ${visit.secondary.length}`);
        if (visit.staleSplit) lines.push(`次访问陈旧 ${visit.staleMinutes} 分钟`);
        const sideToYou = countSideAddressedToBot(visit.secondary, selfId, opts?.botNickname);
        if (sideToYou > 0) lines.push(`次访问指向本账号: ${sideToYou}`);
    } else {
        lines.push('访问：整批同等');
    }

    // 结构场况（对话指向）；群身份不进 bias
    const scene = assessBatchScene(batch, selfId, 'none', visit.atTriggered, opts?.botNickname);
    for (const line of scene.hostLines || []) {
        if (line && !lines.includes(line)) lines.push(line);
    }

    const focusTexts = (visit.atTriggered || visit.staleSplit ? visit.primary : batch).map((b) => String(b.text || ''));
    const wantStickers = detectRequestedStickerCount(focusTexts);
    if (wantStickers != null) {
        lines.push(`对方点名要表情约 ${wantStickers} 张`);
    }

    const batchBlob = batch.map((b) => b.text || '').join('\n');
    // 关系图算出了结论就当判据（单条批次不渲染 text，但 toBot 一样算得出来）
    const graph = opts?.talkGraph || null;
    const graphUsable = Boolean(graph?.computed);
    const silenceDecision = decideSilence({
        scene,
        session,
        silenceAllowedByConfig: silenceAllowed,
        atBot: scene.atBot || atBot,
        batchText: batchBlob,
        requestedStickerCount: wantStickers,
        shutUpLimit: config.shut_up_limit,
        addressedToBot: graphUsable ? graph.toBot.length > 0 : null,
        peerThreads: graphUsable ? graph.threads : 0,
        vetoRatio: config.silence_veto_ratio,
        vetoSeed: opts?.vetoSeed,
    });
    const mergedLines = mergeSilenceHostHints(lines, silenceDecision.hostSilenceHints);
    lines.length = 0;
    lines.push(...mergedLines);
    scene.silenceBias = silenceDecision.sceneBias;

    // 群号 / 群名 / 资历 / 群身份 / 入群时间：会话锁定的静态事实，已上移到 system 的 <chat-facts>

    if (session.prefer_no_reply) {
        lines.push('会话偏好：不带 reply');
    }

    const stickerCoolHint = formatRecentStickerHostHint(session.recent_stickers || []);
    if (stickerCoolHint) lines.push(stickerCoolHint);

    // 句尾/开场/口头禅重复率（wave 87%、语气词开场 53%）：只报自己近几轮用过什么，换不换由 Style Pack 那条规则管
    const styleHint = formatRecentStyleHostHint(session.messages, 3, { botNickname: opts?.botNickname });
    if (styleHint) lines.push(styleHint);

    // 联网/识图开关是会话冻结的静态事实，已写进 system 的 <chat-facts>；这里只报本批的识图进展
    if (opts?.imageRecognize) {
        const batchBlob = batch.map((b) => b.text || '').join('\n');
        const hasSupplement = /补充：\S*\s*图片第\d+张解析结果/.test(batchBlob)
            || /补充：.+图片第.+解析结果/.test(batchBlob)
            || /\[眼睛\s+msgid:/i.test(batchBlob);
        const hasPending = /发了\d+张\[图片\]\(图片资源正在解析/.test(batchBlob);
        if (hasSupplement) lines.push('识图：已有补充');
        else if (hasPending) lines.push('识图：解析中');
    }

    return {
        text: `<host-state>\n${lines.join('\n')}\n</host-state>`,
        scene,
    };
}

export function composeTurn(
    config: SmartChatConfig,
    session: SmartChatSessionFile,
    batch: SmartChatBufferEntry[],
    knowledge: SmartChatKnowledgeEntry[],
    historyRounds = 0,
    opts?: {
        imageRecognize?: boolean;
        stickerOutput?: boolean;
        stickerSystemSuffix?: string;
        /** 已安装图库目录集合（冻结表情后缀用；见 resolveFrozenStickerSuffix） */
        stickerInstallKey?: string;
        toolsEnabled?: boolean;
        /** 登录账号昵称；替换 system 里 {{BOT_NICK}} */
        botNickname?: string;
        /** 供建议条数确定性种子；默认用群号+沉默+batch */
        chatId?: string;
        /** lore 分槽（关键词命中） */
        loreEntries?: SmartChatKnowledgeEntry[];
        /** 轻量记忆召回块（已格式化） */
        memoryBlock?: string;
        /** Style Pack id；默认 groupie */
        stylePackId?: string;
        /** 伪装思考开关（当前群/好友） */
        fakeThink?: boolean;
        /** 模型是否自带原生思考（true 则伪装思考 auto-skip） */
        modelNativeThinking?: boolean;
        /** 本轮实际要用的厂商 / 模型；原生思考名单按模型记，不按会话记 */
        currentVendor?: string;
        currentModel?: string;
    },
): ComposedTurn {
    const selfId = String(batch[batch.length - 1]?.eventSnapshot?.self_id ?? '');
    backfillSessionChatFacts(session, batch);
    const visit = resolveBatchVisit(batch, selfId, Number(config.batch_max_age_ms) || 0);
    const formatted = formatVisitBody(visit, batch);
    const talkGraph = buildTalkGraph(batch, selfId, opts?.botNickname);
    // 技能树只在稳定 system 出现一次；这里只负责冻结/取用，不再拼进本轮 user
    const knowledgeBlock = resolveFrozenSkillTree(session, knowledge).text;
    const loreBlock = buildLoreBlock(opts?.loreEntries || []);
    const memoryBlock = String(opts?.memoryBlock || '').trim();

    const thinkModelKey = nativeThinkingKey(opts?.currentVendor, opts?.currentModel);
    const liveCaps = {
        tools: toolsShouldAttach(config, Boolean(opts?.toolsEnabled)),
        image: Boolean(opts?.imageRecognize),
        sticker: Boolean(opts?.stickerOutput),
        // 伪装思考：开关开 + 当前模型无原生思考 + 当前模型没露过原生思考（按模型判，不按会话判）
        think: Boolean(opts?.fakeThink)
            && !Boolean(opts?.modelNativeThinking)
            && !hasSeenNativeThinking(session, opts?.currentVendor, opts?.currentModel),
    };
    const { caps: systemCaps } = resolveFrozenSystemCaps(session, liveCaps, thinkModelKey);

    const lastMsgId = String(batch[batch.length - 1]?.messageId || '').trim();
    const speakSeed = [
        String(opts?.chatId || session.group_id || ''),
        String(session.shut_up_streak || 0),
        String(batch.length),
        lastMsgId,
    ].join('|');
    // 否决抽样种子：同一轮 compose 与 flush 预判必须抽到同一个值
    const vetoSeed = buildSilenceVetoSeed(
        String(opts?.chatId || session.group_id || ''),
        Number(session.shut_up_streak || 0),
        batch.map((b) => b?.messageId),
    );

    const host = buildHostConstraint(config, session, batch, visit, 'none', {
        imageRecognize: systemCaps.image,
        toolsEnabled: systemCaps.tools,
        botNickname: opts?.botNickname,
        speakSeed,
        vetoSeed,
        talkGraph,
    });

    const parts: string[] = [];
    if (memoryBlock) parts.push(memoryBlock);
    if (loreBlock) parts.push(loreBlock);
    parts.push(host.text);
    // 关系图紧贴正文前：先给结论，再给原始消息，模型不用自己重建关系
    if (talkGraph.text) parts.push(talkGraph.text);
    // 读史/代词规则已进锁定 system；tip 只挂本轮动态
    parts.push(formatted.body);
    const userContentExact = parts.join('\n\n');

    // Reasonix：历史 append-only，字节原样进 API；禁止 strip/label/每轮 shut-up 折叠
    const roundsN = Number(historyRounds);
    const cacheReset = Number.isFinite(roundsN) && roundsN > 0;
    const history = cacheReset
        ? sliceMessagesByRounds(getPrependOnlyMessages(session), historyRounds)
        : getPrependOnlyMessages(session);
    const apiMessages = [
        ...history.map((m) => ({
            role: m.role,
            content: String(m.content || ''),
        })),
        { role: 'user', content: userContentExact },
    ];

    // system_prompt 仅存【你是谁】定义句；其余策略为插件默认稳定前缀
    const systemPrompt = buildSessionSystemPrompt(config, session, systemCaps, {
        botNickname: opts?.botNickname,
        stickerSystemSuffix: opts?.stickerSystemSuffix,
        stickerInstallKey: opts?.stickerInstallKey,
        stylePackId: opts?.stylePackId,
    });

    const prefixHash = hashApiPrefix(systemPrompt, history);
    // 上轮全文 = system + […, tipN]；落盘后多了 assistant。
    // DeepSeek 公共前缀 = 去掉尾部 assistant 后的 history → 应等于上轮全文。
    const prev = String(session.last_api_prefix_hash || '');
    const histForHit = history.length && history[history.length - 1]?.role === 'assistant'
        ? history.slice(0, -1)
        : history;
    const prefixStable = Boolean(prev) && prev === hashApiPrefix(systemPrompt, histForHit);
    // A② 失配归因：刚压过（epoch 变了）时前缀必然 miss，这是预期内的，
    // 与「开关变更/草稿改写把前缀弄脏」是两回事，日志要能分开看
    const compactionEpoch = Math.max(0, Number(session.compaction_epoch) || 0);
    const lastPrefixEpoch = Math.max(0, Number(session.last_api_prefix_epoch) || 0);
    const prefixResetReason = !prefixStable && compactionEpoch !== lastPrefixEpoch
        ? 'compacted'
        : (!prefixStable && prev ? 'drifted' : '');

    return {
        systemPrompt,
        apiMessages,
        userContentExact,
        userTurnPlain: formatted.plain,
        knowledgeBlock,
        scene: host.scene,
        prefixHash,
        prefixStable,
        prefixResetReason,
        compactionEpoch,
        cacheReset,
        systemCaps,
        talkGraph,
    };
}

/**
 * 本轮请求「全文」指纹（system + 含本 tip 的全部 apiMessages）。
 * 下一轮在 tip 入史后，其 prefixHash 应等于本轮 fullHash → 前缀缓存可命中。
 */
export function hashApiFullRequest(
    systemPrompt: string,
    apiMessages: Array<{ role: string; content: string }>,
): string {
    return hashApiPrefix(systemPrompt, apiMessages);
}

/**
 * 记账口径唯一入口：只有「真正发出去的请求」才能刷新前缀基准。
 * - 传入的 apiMessages 必须是实际送出的那份，末尾是本轮 tip，不含模型回复
 * - 预判沉默等没发请求的轮不要调用：那轮的 tip 服务端没见过，基准仍是上一次发出的请求
 * flush 与人设融合预热共用本函数，避免两处各写一套（含/不含 assistant）导致永久 miss。
 */
export function recordSentApiPrefix(
    session: SmartChatSessionFile,
    systemPrompt: string,
    apiMessages: Array<{ role: string; content: string }>,
): string {
    const hash = hashApiFullRequest(systemPrompt, apiMessages);
    if (session) {
        session.last_api_prefix_hash = hash;
        // A② 同时记下压缩代数：下一轮 epoch 变了就说明「前缀必失配，原因是刚压过」，
        // 而不是像以前那样只看到 prefixStable=false 却查不出原因
        session.last_api_prefix_epoch = Math.max(0, Number(session.compaction_epoch) || 0);
    }
    return hash;
}
