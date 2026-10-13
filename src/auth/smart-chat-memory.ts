// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 轻量会话记忆（人物画像 + Episode；按需召回，不进 system 前缀）
// ---------------------------------------------------------------------------

import type {
    SmartChatBufferEntry,
    SmartChatDeps,
    SmartChatEpisode,
    SmartChatMemoryFile,
    SmartChatPersonCard,
    SmartChatSessionFile,
} from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';
import { getBotUserId } from './smart-chat-identity';

const MAX_PEOPLE = 40;
const MAX_EPISODES = 30;
const MAX_NOTES_PER_PERSON = 6;
const MAX_EPISODE_CHARS = 240;
/** 近史召回时效：超过该窗口的 episode 不再作为「近史」注入（默认 12 小时） */
const EPISODE_RECALL_TTL_MS = 12 * 3600 * 1000;

/**
 * episode 禁止原样存 <compaction-summary> / 嵌套 digest。
 * 只留 stance 要点或压缩后的白话近史，避免记忆侧教模型「摘要体」。
 */
export function sanitizeEpisodeSummary(raw: string): string {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';

    // 模板污染：style-pack / skill-tree 不得进 episode
    s = s
        .replace(/<style-pack\b[^>]*>[\s\S]*?<\/style-pack>/gi, ' ')
        .replace(/<(?:knowledge|skill-tree)>[\s\S]*?<\/(?:knowledge|skill-tree)>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '';

    // 嵌套 digest：优先抽 stance 条目
    const stanceBits: string[] = [];
    for (const m of s.matchAll(/<digest-stance>\s*([\s\S]*?)\s*<\/digest-stance>/gi)) {
        const inner = String(m[1] || '')
            .replace(/<\/?[^>]+>/g, ' ')
            .replace(/[·\-•]\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (inner && !/本段无明显约定/.test(inner) && inner.length >= 4) {
            stanceBits.push(inner.slice(0, 120));
        }
    }
    if (stanceBits.length) {
        // 有立场要点 → 只用立场，header 的元说明随壳一起丢掉（不再往下清洗）
        s = stanceBits.join('；');
    } else if (
        /近史原文在后面的消息里|人设以 system 为准|本段无明显约定|远史压缩/.test(s)
        || /<digest-(?:stance|users|assistants)>|\[compact\s/i.test(s)
        || /<compaction-summary>/i.test(s)
        // 防御纵深：带时间戳 / msgid 的原始聊天转录、识图 OCR 残留不是「记忆」，
        // 是被误存的历史正文，整条丢。（有 stance 时上面已 return，不会走到这里误伤正常立场句。）
        || /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(s)
        || /\[msgid:|眼睛\s*msgid|图片资源正在解析/i.test(s)
    ) {
        // 无立场要点 → 整段 compaction 摘要都不是「记忆」，丢弃。
        //
        // 为什么「无 stance 必须丢」而不是清洗后留用（19 代实测回归）：
        // header 说明「说明：以下为远史压缩。近史原文在后面的消息里；人设以 system 为准。」
        // 的旧清洗正则只删到第一个句号，后半句会残留；<digest-stance> 的占位句
        // 「（本段无明显约定/立场句）」和 <digest-users> 的远史片段（带时间戳 + 图片 OCR）
        // 在「删标签」后也原样保留；末尾的残留检查查的又是「远史压缩|digest-stance」，
        // 这些词早被删掉了 → 漏网。结果：这条元说明被写成 episode 并每轮召回，
        // 占历史总字符 10.2%，还用它自带的旧时间戳把 batch 跨度污染成 1561 分钟。
        //
        // 为什么这里要按「文本特征」而不是只按 compaction 标签：清洗那一步会把
        // <compaction-summary> / [compact] 标签剥掉，**已存盘的污染数据不带壳**，
        // 仅凭标签 100% 漏网（19 代记忆文件里那条正是这种形态）。
        // 这些字串只可能来自模板，真实群聊不会出现，丢弃是安全的。
        return '';
    }

    if (s.length > MAX_EPISODE_CHARS) s = s.slice(0, MAX_EPISODE_CHARS) + '…';
    return s;
}

/**
 * 容纳式去重：丢掉「被另一条摘要完全包含」的 episode，保留信息更全的那条。
 * 立场句反复压缩/叠加会生成「新句＋旧句」这种互相包含的近史，只按前 40 字比对会漏判，
 * 导致同一段话越滚越长、每轮召回同一坨。按归一化全文的子串包含关系收敛即可根治。
 */
function dedupeEpisodesByContainment(episodes: SmartChatEpisode[]): SmartChatEpisode[] {
    const list = (episodes || []).filter((e) => e && String(e.summary || '').trim());
    const normed = list.map((e) => String(e.summary || '').replace(/\s+/g, ''));
    const drop = new Array(list.length).fill(false);
    for (let i = 0; i < list.length; i += 1) {
        if (drop[i] || normed[i].length < 12) continue;
        for (let j = 0; j < list.length; j += 1) {
            if (i === j || drop[j] || !normed[j]) continue;
            // normed[i] 更长且包含 normed[j] → 丢更短的 j（信息被 i 覆盖）；
            // 完全相同则丢靠前那条（保留更新的一条）。
            if (normed[i].length > normed[j].length && normed[i].includes(normed[j])) drop[j] = true;
            else if (normed[i] === normed[j] && j < i) drop[j] = true;
        }
    }
    return list.filter((_, i) => !drop[i]);
}

/** 目录/文件名安全段（同 session/buffer 侧口径）：id 会拼进路径，禁止任何越界字符 */
function safeSegment(raw: unknown, fallback: string): string {
    const s = String(raw ?? '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
    return s || fallback;
}

function memoryRelPath(fingerprint: string, chatId: string): string {
    const fp = safeSegment(fingerprint, '_');
    const id = safeSegment(chatId, 'unknown');
    return `${SMART_CHAT_ROOT}sessions/by-config/${fp}/${id}.memory.json`;
}

function emptyMemory(): SmartChatMemoryFile {
    return { people: [], episodes: [], updated_at: new Date().toISOString() };
}

export function loadChatMemory(
    deps: SmartChatDeps,
    fingerprint: string,
    chatId: string,
): SmartChatMemoryFile {
    try {
        const raw = deps.readA(memoryRelPath(fingerprint, chatId));
        if (!raw) return emptyMemory();
        const obj = JSON.parse(String(raw));
        const people = Array.isArray(obj?.people) ? obj.people : [];
        const episodes = Array.isArray(obj?.episodes) ? obj.episodes : [];
        return {
            people: people
                .map((p) => ({
                    user_id: String(p?.user_id || '').trim(),
                    nickname: String(p?.nickname || '').trim() || undefined,
                    aliases: Array.isArray(p?.aliases) ? p.aliases.map(String) : [],
                    prefs: Array.isArray(p?.prefs) ? p.prefs.map(String) : [],
                    notes: Array.isArray(p?.notes) ? p.notes.map(String) : [],
                    updated_at: String(p?.updated_at || new Date().toISOString()),
                }))
                .filter((p) => p.user_id),
            episodes: dedupeEpisodesByContainment(
                episodes
                    .map((e) => ({
                        id: String(e?.id || '').trim(),
                        summary: sanitizeEpisodeSummary(String(e?.summary || '')),
                        people: Array.isArray(e?.people) ? e.people.map(String) : [],
                        at: String(e?.at || new Date().toISOString()),
                    }))
                    .filter((e) => e.id && e.summary),
            ),
            updated_at: String(obj?.updated_at || ''),
        };
    } catch {
        return emptyMemory();
    }
}

export function saveChatMemory(
    deps: SmartChatDeps,
    fingerprint: string,
    chatId: string,
    mem: SmartChatMemoryFile,
): void {
    const out: SmartChatMemoryFile = {
        people: (mem.people || []).slice(0, MAX_PEOPLE),
        episodes: (mem.episodes || []).slice(-MAX_EPISODES),
        updated_at: new Date().toISOString(),
    };
    deps.writeA(memoryRelPath(fingerprint, chatId), JSON.stringify(out, null, 2));
}

function upsertPerson(
    mem: SmartChatMemoryFile,
    userId: string,
    nickname: string,
    note?: string,
): void {
    const uid = String(userId || '').trim();
    if (!uid || !/^\d{5,15}$/.test(uid)) return;
    let row = mem.people.find((p) => p.user_id === uid);
    if (!row) {
        row = {
            user_id: uid,
            nickname: nickname || undefined,
            aliases: [],
            prefs: [],
            notes: [],
            updated_at: new Date().toISOString(),
        };
        mem.people.push(row);
    }
    if (nickname) row.nickname = nickname;
    if (note) {
        const notes = Array.isArray(row.notes) ? row.notes : [];
        if (!notes.includes(note)) notes.push(note);
        row.notes = notes.slice(-MAX_NOTES_PER_PERSON);
    }
    row.updated_at = new Date().toISOString();
}

/** 从本批缓冲里读出本账号 QQ（快照里带 self_id），用于把「自己」排除出人物记忆 */
function batchSelfId(batch: SmartChatBufferEntry[]): string {
    for (let i = (batch?.length || 0) - 1; i >= 0; i--) {
        const s = String(batch[i]?.eventSnapshot?.self_id ?? '').trim();
        if (/^\d{5,15}$/.test(s)) return s;
    }
    return '';
}

function addNote(row: SmartChatPersonCard, note: string): void {
    const n = String(note || '').trim();
    if (!n) return;
    const notes = Array.isArray(row.notes) ? row.notes : [];
    if (!notes.includes(n)) notes.push(n);
    row.notes = notes.slice(-MAX_NOTES_PER_PERSON);
}

function roleNote(role: unknown): string {
    const r = String(role || '').trim().toLowerCase();
    if (r === 'owner' || r === '群主') return '群主';
    if (r === 'admin' || r === 'administrator' || r === '管理' || r === '管理员') return '管理';
    return '';
}

/**
 * 从本批缓冲轻量更新人物名片：昵称、别名（改名史）、群头衔/身份都是「看一眼就知道」的
 * 可观察事实，直接落进 prefs/notes/aliases —— 而不是像旧版那样只登记 user_id、
 * 把 notes/prefs/aliases 三个字段永远留空。绝不把机器人自己记成人物。
 */
export function touchPeopleFromBatch(
    mem: SmartChatMemoryFile,
    batch: SmartChatBufferEntry[],
    selfId?: string,
): void {
    const self = String(selfId || '').trim() || batchSelfId(batch);
    // 历史遗留：早期版本把自己（self_id）也写进了人物表，这里顺手清掉
    if (self) mem.people = (mem.people || []).filter((p) => p.user_id !== self);
    for (const b of batch || []) {
        const uid = String(b.userId || '').trim();
        const nick = String(b.nickname || '').trim();
        if (!uid || uid === self || !/^\d{5,15}$/.test(uid)) continue;
        const prev = mem.people.find((p) => p.user_id === uid);
        const oldNick = String(prev?.nickname || '').trim();
        upsertPerson(mem, uid, nick);
        const row = mem.people.find((p) => p.user_id === uid);
        if (!row) continue;
        // 别名：昵称变更史（观察即得）
        if (nick && oldNick && oldNick !== nick) {
            const aliases = Array.isArray(row.aliases) ? row.aliases : [];
            if (!aliases.includes(oldNick)) aliases.push(oldNick);
            row.aliases = aliases.slice(-4);
        }
        // 群头衔 / 群身份 → note
        const title = String(b.groupTitle || '').trim();
        if (title) addNote(row, `头衔「${title}」`);
        const rn = roleNote(b.groupRole);
        if (rn) addNote(row, rn);
    }
}

/**
 * compact 写回：把被折叠远史压成一条 episode，并刷新出现过的人物。
 */
export function writebackFromCompact(
    deps: SmartChatDeps,
    fingerprint: string,
    chatId: string,
    droppedSummary: string,
    peopleIds: string[],
): SmartChatMemoryFile {
    const mem = loadChatMemory(deps, fingerprint, chatId);
    const self = getBotUserId(deps);
    if (self) mem.people = (mem.people || []).filter((p) => p.user_id !== self);
    const summary = sanitizeEpisodeSummary(droppedSummary);
    const normNew = summary.replace(/\s+/g, '');
    // 容纳式去重：新摘要已被某条旧 episode 包含 → 不追加（没有新信息）；
    // 旧 episode 被新摘要包含 → 交给 dedupeEpisodesByContainment 一并清掉，杜绝「同一句越滚越长」。
    const alreadyCovered = (mem.episodes || []).some(
        (e) => String(e?.summary || '').replace(/\s+/g, '').includes(normNew),
    );
    if (summary.length >= 12 && normNew && !alreadyCovered) {
        const ep: SmartChatEpisode = {
            id: `ep_${Date.now().toString(36)}`,
            summary,
            people: (peopleIds || []).filter((x) => x && x !== self).slice(0, 8),
            at: new Date().toISOString(),
        };
        mem.episodes = dedupeEpisodesByContainment([...(mem.episodes || []), ep]).slice(-MAX_EPISODES);
    }
    for (const uid of peopleIds || []) {
        if (uid && uid !== self) upsertPerson(mem, uid, '');
    }
    saveChatMemory(deps, fingerprint, chatId, mem);
    return mem;
}

/** 按本批活跃/被艾特说话人召回画像 + 最近 episode（永不召回机器人自己） */
export function recallMemoryBlock(
    mem: SmartChatMemoryFile,
    batch: SmartChatBufferEntry[],
    maxPeople = 4,
    maxEpisodes = 2,
    selfId?: string,
): string {
    const self = String(selfId || '').trim() || batchSelfId(batch);
    const ids = new Set<string>();
    for (const b of batch || []) {
        const uid = String(b.userId || '').trim();
        if (uid) ids.add(uid);
        for (const q of b.atQqs || []) {
            const qq = String(q || '').trim();
            if (qq) ids.add(qq);
        }
        const rt = String(b.replyToUserId || '').trim();
        if (rt) ids.add(rt);
    }
    if (self) ids.delete(self);
    const people = (mem.people || [])
        .filter((p) => ids.has(p.user_id) && p.user_id !== self)
        .slice(0, maxPeople);
    // 近史召回：按内容去重（同一句 stance 反复压缩会生成一模一样的 episode），
    // 并且只召回 EPISODE_RECALL_TTL_MS 内的——避免「开服第一天那几句」被永久当成近史刷屏。
    const now = Date.now();
    const seenSummary = new Set<string>();
    const episodes = (mem.episodes || [])
        .filter((e) => {
            const t = Date.parse(String(e?.at || ''));
            return !Number.isFinite(t) || (now - t) <= EPISODE_RECALL_TTL_MS;
        })
        .filter((e) => {
            const key = String(e?.summary || '').replace(/\s+/g, '').slice(0, 40);
            if (!key || seenSummary.has(key)) return false;
            seenSummary.add(key);
            return true;
        })
        .slice(-maxEpisodes)
        .reverse();
    if (!people.length && !episodes.length) return '';
    const lines: string[] = ['<memory-recall>', '（轻量召回；别当圣旨念）'];
    for (const p of people) {
        const bits = [
            p.nickname ? `${p.nickname}(${p.user_id})` : p.user_id,
            ...(p.notes || []).slice(-3),
        ];
        lines.push(`· 人物 ${bits.join(' · ')}`);
    }
    for (const e of episodes) {
        lines.push(`· 近史 ${e.summary}`);
    }
    lines.push('</memory-recall>');
    return lines.join('\n');
}

/** 从 session messages 粗抽参与者 QQ（compact 用）；排除机器人自己 */
export function collectPeopleIdsFromMessages(session: SmartChatSessionFile, selfId?: string): string[] {
    const self = String(selfId || '').trim();
    const ids = new Set<string>();
    for (const m of session.messages || []) {
        const c = String(m.content || '');
        for (const hit of c.matchAll(/\((\d{5,15})\)/g)) {
            if (hit[1] !== self) ids.add(hit[1]);
        }
    }
    return [...ids].slice(0, 20);
}
