// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 技能树 CRUD + 启用开关 + 顺序 Top-M
// ---------------------------------------------------------------------------
//
// 注入策略（Reasonix 回合尾）：
// - 只取 enabled !== false 的自定义技能
// - 按文件内顺序（仅本群作用域）取前 Top-M 条
// - 挂在当前 user turn，不写进稳定 system 前缀 → 不破坏历史前缀缓存
// - 宿主技（钉楼/表情/沉默）固定进 system「技能树」，不占 Top-M
// - 工具技能（MKAPI）另册：知识默认挂 system，开关只挡后端执行
//
// 磁盘路径仍为 knowledge/（兼容旧数据）；对内对外文案统一叫技能树。

import fs from 'fs';
import path from 'path';
import type { SmartChatDeps, SmartChatKnowledgeEntry } from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';
import { formatEmojiCatalogForKnowledge } from './smart-chat-emoji';
import {
    BUILTIN_STICKER_ID,
    BUILTIN_STICKER_TITLE,
    buildStickerSkillBody,
    isAnyStickerGalleryReady,
    listInstalledGalleries,
} from './smart-chat-sticker';

function knowledgePath(scope: string): string {
    const safe = scope === 'global' ? 'global' : String(scope).replace(/[^\d]/g, '');
    return `${SMART_CHAT_ROOT}knowledge/${safe}.json`;
}

function normalizeEntry(raw: Partial<SmartChatKnowledgeEntry> | null | undefined): SmartChatKnowledgeEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    const title = String(raw.title || '').trim();
    const content = String(raw.content || '').trim();
    if (!id || !title || !content) return null;
    const kindRaw = String(raw.kind || 'skill').trim().toLowerCase();
    const kind = kindRaw === 'lore' || kindRaw === 'persona_fact' ? kindRaw : 'skill';
    const keys = Array.isArray(raw.keys)
        ? raw.keys.map((k) => String(k || '').trim()).filter(Boolean)
        : [];
    const priority = Number(raw.priority);
    return {
        id,
        title,
        content,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
        enabled: raw.enabled !== false && raw.enabled !== 'false',
        kind,
        keys,
        priority: Number.isFinite(priority) ? Math.floor(priority) : 0,
    };
}

function loadEntries(deps: SmartChatDeps, scope: string): SmartChatKnowledgeEntry[] {
    const raw = deps.readA(knowledgePath(scope));
    if (!raw) return [];
    try {
        const obj = JSON.parse(raw);
        const list = Array.isArray(obj?.entries) ? obj.entries : [];
        return list.map(normalizeEntry).filter(Boolean);
    } catch {
        return [];
    }
}

function saveEntries(deps: SmartChatDeps, scope: string, entries: SmartChatKnowledgeEntry[]): void {
    deps.writeA(knowledgePath(scope), JSON.stringify({ entries }, null, 2));
}

function genId(): string {
    return `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 列表按文件内顺序（即启用加载顺序） */
export function listKnowledge(deps: SmartChatDeps, scope = 'global'): SmartChatKnowledgeEntry[] {
    return loadEntries(deps, scope);
}

export function upsertKnowledge(
    deps: SmartChatDeps,
    scope: string,
    entry: Partial<SmartChatKnowledgeEntry> & { title: string; content: string },
): SmartChatKnowledgeEntry {
    const entries = loadEntries(deps, scope);
    const now = new Date().toISOString();
    let idx = -1;
    if (entry.id) idx = entries.findIndex((e) => e.id === entry.id);
    const prev = idx >= 0 ? entries[idx] : null;
    if (prev && isBuiltinSkillId(prev.id)) {
        // 宿主技内容由代码刷新；允许改 enabled，禁止改写正文/标题覆盖
        const row: SmartChatKnowledgeEntry = {
            ...prev,
            enabled: entry.enabled !== undefined
                ? (entry.enabled !== false && entry.enabled !== 'false')
                : prev.enabled !== false,
            updated_at: now,
        };
        entries[idx] = row;
        saveEntries(deps, scope, entries);
        return row;
    }
    const row: SmartChatKnowledgeEntry = {
        id: entry.id && idx >= 0 ? entry.id : (entry.id ? String(entry.id) : genId()),
        title: String(entry.title || '').trim(),
        content: String(entry.content || '').trim(),
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : (prev?.tags || []),
        updated_at: now,
        enabled: entry.enabled !== undefined
            ? (entry.enabled !== false && entry.enabled !== 'false')
            : (prev ? prev.enabled !== false : true),
        kind: entry.kind === 'lore' || entry.kind === 'persona_fact' || entry.kind === 'skill'
            ? entry.kind
            : (prev?.kind || 'skill'),
        keys: Array.isArray(entry.keys)
            ? entry.keys.map((k) => String(k || '').trim()).filter(Boolean)
            : (prev?.keys || []),
        priority: entry.priority !== undefined
            ? Math.floor(Number(entry.priority) || 0)
            : (prev?.priority || 0),
    };
    if (idx >= 0) entries[idx] = row;
    else entries.push(row);
    saveEntries(deps, scope, entries);
    return row;
}

export function setKnowledgeEnabled(
    deps: SmartChatDeps,
    scope: string,
    id: string,
    enabled: boolean,
): SmartChatKnowledgeEntry | null {
    const entries = loadEntries(deps, scope);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    entries[idx] = {
        ...entries[idx],
        enabled: Boolean(enabled),
        updated_at: new Date().toISOString(),
    };
    saveEntries(deps, scope, entries);
    return entries[idx];
}

export function deleteKnowledge(deps: SmartChatDeps, scope: string, id: string): boolean {
    if (isBuiltinSkillId(id)) return false;
    const entries = loadEntries(deps, scope);
    const next = entries.filter((e) => e.id !== id);
    if (next.length === entries.length) return false;
    saveEntries(deps, scope, next);
    return true;
}

/**
 * 加载已装备技能（按列表顺序取前 Top-M）。
 * - 本群自定义优先，再补 global 里非宿主技条目（兼容旧 global 装备 / 表情包技能）
 * - 宿主技（钉楼/react/沉默）不进本列表（已挂稳定 system）
 * - 表情包：需本聊天表情输出开着 + 图库真实安装；未安装会被 ensureBuiltinKnowledge 清掉
 * topM ≤0 时不注入。
 */
export function searchKnowledgeTopM(
    deps: SmartChatDeps,
    _query: string,
    groupId: string | null,
    topM: number,
    opts?: { stickerOutput?: boolean },
): SmartChatKnowledgeEntry[] {
    if (topM <= 0) return [];
    // 先同步表情包技能与磁盘安装状态，避免「已装呆猫」假文案进回合
    try {
        ensureBuiltinKnowledge(deps);
    } catch {
        /* ignore */
    }
    const wantSticker = Boolean(opts?.stickerOutput) && isAnyStickerGalleryReady(deps);
    const scopes: string[] = [];
    if (groupId) scopes.push(String(groupId));
    scopes.push('global');
    const merged: SmartChatKnowledgeEntry[] = [];
    const seen = new Set<string>();
    for (const scope of scopes) {
        for (const e of loadEntries(deps, scope)) {
            if (e.enabled === false) continue;
            // lore / persona_fact 走关键词召回，不占 skill Top-M
            if (e.kind === 'lore' || e.kind === 'persona_fact') continue;
            if (BUILTIN_PROTOCOL_IDS.has(e.id)) continue;
            if (e.id === BUILTIN_STICKER_ID && !wantSticker) continue;
            if (seen.has(e.id)) continue;
            seen.add(e.id);
            // 表情包正文按现场图库重算，避免磁盘卸掉后仍念旧清单
            if (e.id === BUILTIN_STICKER_ID) {
                merged.push({
                    ...e,
                    kind: 'skill',
                    content: buildStickerSkillBody(deps),
                    tags: ['技能', '表情包', '图库', ...listInstalledGalleries(deps).map((g) => g.folder)],
                });
            } else {
                merged.push({ ...e, kind: e.kind || 'skill' });
            }
        }
    }
    // 开关开着且已装图库时，即使列表被关掉也现场补一条（与 system suffix 对齐）
    if (wantSticker && !seen.has(BUILTIN_STICKER_ID)) {
        const stick = getStickerKnowledgeIfReady(deps);
        if (stick) {
            merged.push(stick);
            seen.add(BUILTIN_STICKER_ID);
        }
    }
    const limit = Math.max(0, Math.floor(Number(topM) || 0));
    merged.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
    let out = merged.slice(0, limit);
    // 表情包技能不被 Top-M 挤掉：截断后若丢失则钉回末尾
    if (wantSticker && !out.some((e) => e.id === BUILTIN_STICKER_ID)) {
        const stick = merged.find((e) => e.id === BUILTIN_STICKER_ID) || getStickerKnowledgeIfReady(deps);
        if (stick) {
            if (out.length >= limit && limit > 0) out = out.slice(0, limit - 1);
            out.push(stick);
        }
    }
    return out;
}

/**
 * Lorebook：关键词命中才注入（学 SillyTavern World Info）。
 * 无 keys 的 lore 条目不自动注入。
 */
export function selectLoreByKeys(
    deps: SmartChatDeps,
    queryText: string,
    groupId: string | null,
    maxEntries = 4,
): SmartChatKnowledgeEntry[] {
    const blob = String(queryText || '').toLowerCase();
    if (!blob.trim()) return [];
    const scopes: string[] = [];
    if (groupId) scopes.push(String(groupId));
    scopes.push('global');
    const hits: SmartChatKnowledgeEntry[] = [];
    const seen = new Set<string>();
    for (const scope of scopes) {
        for (const e of loadEntries(deps, scope)) {
            if (e.enabled === false) continue;
            if (e.kind !== 'lore' && e.kind !== 'persona_fact') continue;
            if (seen.has(e.id)) continue;
            const keys = Array.isArray(e.keys) ? e.keys : [];
            if (!keys.length) continue;
            const matched = keys.some((k) => {
                const kk = String(k || '').trim().toLowerCase();
                return kk.length >= 2 && blob.includes(kk);
            });
            if (!matched) continue;
            seen.add(e.id);
            hits.push(e);
        }
    }
    hits.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
    return hits.slice(0, Math.max(0, Math.floor(Number(maxEntries) || 0)));
}

export function buildLoreBlock(entries: SmartChatKnowledgeEntry[]): string {
    const list = (entries || []).filter((e) => e && e.title && e.content);
    if (!list.length) return '';
    const body = list.map((e) => `◆ ${e.title}\n${String(e.content).trim()}`).join('\n\n');
    return `<lorebook>\n（本轮关键词命中；相关再用，别背全本）\n${body}\n</lorebook>`;
}

export function listKnowledgeScopes(deps: SmartChatDeps): string[] {
    const set = new Set<string>();
    // 已有技能文件的群
    try {
        const dir = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'knowledge');
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.json')) continue;
                const s = f.replace(/\.json$/, '');
                if (s !== 'global' && /^\d{5,12}$/.test(s)) set.add(s);
            }
        }
    } catch {
        /* ignore */
    }
    // 群聊开关里出现过的群（方便还没建技能文件也能选）
    try {
        const switchRaw = deps.readA(`${SMART_CHAT_ROOT}群聊开关.json`);
        if (switchRaw) {
            const obj = JSON.parse(String(switchRaw));
            if (obj && typeof obj === 'object') {
                for (const k of Object.keys(obj)) {
                    if (/^\d{5,12}$/.test(k)) set.add(k);
                }
            }
        }
    } catch {
        /* ignore */
    }
    // 已有会话的群
    try {
        const sessRoot = path.join(deps.getDataPath(), SMART_CHAT_ROOT, 'sessions', 'by-config');
        if (fs.existsSync(sessRoot)) {
            for (const ns of fs.readdirSync(sessRoot)) {
                if (ns.startsWith('_') || ns.startsWith('.')) continue;
                const dir = path.join(sessRoot, ns);
                let st;
                try { st = fs.statSync(dir); } catch { continue; }
                if (!st.isDirectory()) continue;
                for (const f of fs.readdirSync(dir)) {
                    const m = /^g_(\d{5,12})\.json$/i.exec(f);
                    if (m) set.add(m[1]);
                }
            }
        }
    } catch {
        /* ignore */
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

const BUILTIN_AT_REPLY_TITLE = '◆ 钉楼点名';
const BUILTIN_REACT_TITLE = '◆ 表情回应';
const BUILTIN_SHUT_UP_TITLE = '◆ 沉默控场';

/** 宿主技 id：进稳定 system 技能树，不占每轮自定义 Top-M */
export const BUILTIN_PROTOCOL_IDS = new Set([
    'kb_builtin_at_reply',
    'kb_builtin_react',
    'kb_builtin_shut_up',
]);

/** 内置但可装备进 Top-M 的技能（表情包清单较大，不塞死 system） */
export const BUILTIN_EQUIPPABLE_IDS = new Set([
    BUILTIN_STICKER_ID,
]);

export function isBuiltinSkillId(id: unknown): boolean {
    const s = String(id || '').trim();
    return BUILTIN_PROTOCOL_IDS.has(s) || BUILTIN_EQUIPPABLE_IDS.has(s);
}

function skillAtReplyBody(): string {
    return (
        '分支：社交 · 已点亮\n'
        + '释放：在 <msg> 上挂 at / reply（结构化标签，不是 CQ）。\n'
        + '- at="QQ"：点名；多人 at="111,222"；QQ 从本批昵称(号)抄数字\n'
        + '- reply="last|msgid"：顶住某条气泡（和艾特不是一回事）\n'
        + '入站：[msgid] 本条；[头衔:…] 群里挂的专属头衔（装饰性，没头衔的人不带这段，别拿它当权限）；'
        + '[群主]/[管理]/[成员] 发言人在本群身份（事实标记，不是正文）；'
        + '[引用→昵称(QQ) msgid:… 「短摘」] 对方引用了谁；[艾特:…] 对方艾特了谁。\n'
        + '规则：对方要你点名/艾特某人，或要把话钉到具体 QQ 时必须带 at=；闲聊对楼、不点名可不带。对方有偏好时听人话。'
    );
}

function skillReactBody(): string {
    return (
        '分支：社交 · 已点亮 · 仅群聊\n'
        + '释放：<react emoji="ID" to="last|msgid"/> —— 给某条消息点表情，不是发一条表情消息。\n'
        + '可一次多放（多个 <react>，各算 1 行为）；可与 <msg> 同在 <replies>。\n'
        + '只有 react、没有文字 msg：也算沉默（仍会贴上）。\n'
        + '\n'
        + formatEmojiCatalogForKnowledge(48)
    );
}

function skillShutUpBody(): string {
    return (
        '分支：节奏 · 已点亮\n'
        + '释放：\n'
        + '1) <shut_up/>（或 <闭嘴/>）：不发消息、不贴表情\n'
        + '2) 只有 <react>、没有 <msg>：贴表情也算沉默\n'
        + '都会记入会话，并累计连续沉默。\n'
        + '条件：行为下限为 0 才可沉默；下限>0 时不要用。\n'
        + '沉默计数见 <host-state>；达限后本轮必须开口（禁止 <shut_up/>）。\n'
        + '用法：先评定有没有必要回，再决定回什么——像普通群友，不是把每个问题都当 AI 问答；'
        + '不必回就沉默，要回就短接最想接的那一条（可一句或多短拍）。\n'
        + '认人：昵称(QQ)才是说话人；别人互称「你」不是在问你。\n'
        + '有 <main-visit> 时接主访问；次访问里明确对你/未答完的提问可短带，别整批当作业。'
    );
}

/**
 * 宿主技：固定挂 system，技能树文风。
 * 教「会什么 + 怎么放」；何时放由模型按群友判断。
 */
export const PROTOCOL_SYSTEM_SUFFIX =
    '\n\n[技能树 · 宿主技]\n' +
    '你已点亮下列技能，写法即释放方式；何时放你自己按场况判断，别刷屏也别装不会。\n' +
    '开口一律用 <replies> 包 <msg>/<react>（不要裸文本、CQ、JSON、HTML、Markdown 代码块）。发图走 send_sticker，不靠正文标签。\n' +
    '\n' +
    '◆ 钉楼点名\n' +
    '- 释放：<msg at="QQ">…</msg>（多人 at="111,222"）；<msg reply="last|msgid">…</msg>\n' +
    '- at=点名，reply=顶气泡，别和点小表情 / 发表情包混；QQ 从本批昵称(号)抄数字\n' +
    '- [msgid] 本条；[群主]/[管理]/[成员] 是发言人身份标记，不是对方打的字，别念出来\n' +
    '- [引用→…] 对方引用了谁/哪条（含 QQ 与短摘）；[艾特:…] 点了谁\n' +
    '- 受话人看 <talk-graph>：引用/艾特关系宿主已算好，照结论办，别自己再推，也别把「针对谁」念给群友听\n' +
    '- 代词：正文「我/你/他」先绑本行昵称(QQ)；talk-graph 写「没有人在对你说话」时，别人的「你」不是你——别抢答或替对方编经历，想接就以旁人身份插一句\n' +
    '- 读史：历史里 assistant 那几行是你自己说过的话；里面的「你」指当时的对话对象，别把旧话当成别人发言去复读\n' +
    '- 身份只用来认人分寸：群主/管理说话时少抬杠抢答；你仍是普通群友，别假装管理/系统\n' +
    '- 认清真人还是自动账号：群里除了真人，还有 QQ 官方机器人（如「Q群管家」，自动发欢迎新人/公告/播报），以及普通号接了 AI（跟你同类的框架：官腔套话、机械复读、动辄「抱歉我无法…如需套餐/反诈请…」、自称助手或客服、礼貌却答非所问）——都不是真人。认出来后别把它当人认真对话、别把它的播报/自动回复当话题、别被那股官腔带跑；除非有真人在接它的话你才顺带提一句，拿不准就少搭理，别当众质问「你是不是机器人」\n' +
    '- 要你点名/艾特某人、或把话钉到具体 QQ 时必须带 at=；闲聊对楼不点名可不带\n' +
    '\n' +
    '◆ 表情回应（仅群聊）\n' +
    '- 释放：<react emoji="ID" to="last|msgid"/> —— 给消息点系统小表情，不是发表情包图\n' +
    '- 可与 <msg> 同在 <replies>；只有 react 也算沉默\n' +
    '- 常用：76赞 / 201点赞 / 324吃糖 / 319比心 / 271吃瓜 / 268问号脸\n' +
    '- 偶尔贴就行，别几乎每条都 react\n' +
    '\n' +
    '◆ 沉默控场\n' +
    '- 释放：<shut_up/>，或只有 react、没有 msg（且未调 send_sticker）\n' +
    '- 行为下限为 0 才可沉默；计数见 host-state，达限必须开口（禁止 shut_up）\n' +
    '- 行为数 min-max 是范围：上限是天花板，不是每次都要凑满；建议条数只是参考——有话就说，没话少说，别凑数灌水\n' +
    '- host-state 只认本轮那一份（最靠后的那个）：历史里旧的行为数/沉默计数是过期快照，别照旧的办\n' +
    '- 先评定有没有必要回，再决定回什么；拿不准就旁听，别为了回而回\n' +
    '- 有 main-visit 接主访问；次访问里明确对你/未答完的提问可短带，别整批当作业\n' +
    '- host-state / chat-facts / talk-graph / skill-tree 是宿主播报给你自己看的运行事实（不是群友发言），不代替你做场况判决；「别刷屏 / 建议条数 / 行为数 / 沉默计数」禁止念给群友听\n' +
    '\n' +
    '◆ 表情包输出（需装图库且本聊天开「表情输出」；完整选取表见 system [表情包选取规则]）\n' +
    '- 释放：tool_calls → send_sticker，path="图库名/文件名.扩展名"（可同轮多次）；每张算 1 行为\n' +
    '- 要图：同轮必须调 send_sticker；文字最多一句短 <msg>（先字后图）；禁止纯文字「给你几个」当发图；未点名仅情绪合适才发，勿为凑建议条数硬发表情\n' +
    '- 工具回执 error：换真实 path 再调，或短说发不出；别装神秘\n' +
    '- 与上条「表情回应」不同：react=点小表情；send_sticker=发本地图库图片\n' +
    '\n' +
    '◆ 发语音（偶尔用；默认打字）\n' +
    '- <voice>一句短话</voice>：这条以语音发出、单独成条；只在真想「说」而非打字时偶尔用，别句句都塞\n' +
    '- 只放念得出的短句：别带 @/引用/表情/网址/特殊符号；太长或念不出就改回 <msg>；一轮最多一两条\n' +
    '- 真出不出语音由本聊天开关与配置定；没开或失败会自动当文字发，你照常写\n';

function upsertBuiltin(
    entries: SmartChatKnowledgeEntry[],
    id: string,
    title: string,
    content: string,
    tags: string[],
    preferredIndex = 0,
): void {
    const idx = entries.findIndex((e) => e.id === id || e.title === title);
    if (idx >= 0) {
        const prev = entries[idx];
        if (prev.content === content && prev.title === title && prev.enabled !== false) return;
        entries[idx] = {
            ...prev,
            id: prev.id || id,
            title,
            content,
            tags,
            enabled: prev.enabled !== false,
            updated_at: new Date().toISOString(),
        };
        return;
    }
    // 旧标题迁移：同 id 已在上面；再扫一遍旧协议标题
    const legacyIdx = entries.findIndex((e) => e.id === id);
    if (legacyIdx >= 0) {
        const prev = entries[legacyIdx];
        entries[legacyIdx] = {
            ...prev,
            id,
            title,
            content,
            tags,
            enabled: prev.enabled !== false,
            updated_at: new Date().toISOString(),
        };
        return;
    }
    const row: SmartChatKnowledgeEntry = {
        id,
        title,
        content,
        tags,
        enabled: true,
        updated_at: new Date().toISOString(),
    };
    const at = Math.max(0, Math.min(Number(preferredIndex) || 0, entries.length));
    entries.splice(at, 0, row);
}

/** 写入/刷新全局技能树：钉楼点名、表情回应、沉默控场 */
export function ensureBuiltinKnowledge(deps: SmartChatDeps): void {
    const entries = loadEntries(deps, 'global');
    const before = JSON.stringify(entries);

    // 清掉仍挂着旧「宿主协议」标题的残留（同 id 会在 upsert 覆盖）
    upsertBuiltin(
        entries,
        'kb_builtin_at_reply',
        BUILTIN_AT_REPLY_TITLE,
        skillAtReplyBody(),
        ['技能', '宿主技', '钉楼', '艾特', '引用'],
        0,
    );

    upsertBuiltin(
        entries,
        'kb_builtin_react',
        BUILTIN_REACT_TITLE,
        skillReactBody(),
        ['技能', '宿主技', '表情'],
        1,
    );

    upsertBuiltin(
        entries,
        'kb_builtin_shut_up',
        BUILTIN_SHUT_UP_TITLE,
        skillShutUpBody(),
        ['技能', '宿主技', '沉默'],
        2,
    );

    if (isAnyStickerGalleryReady(deps)) {
        const galleryTags = listInstalledGalleries(deps).map((g) => g.folder);
        upsertBuiltin(
            entries,
            BUILTIN_STICKER_ID,
            BUILTIN_STICKER_TITLE,
            buildStickerSkillBody(deps),
            ['技能', '表情包', '图库', ...galleryTags],
            3,
        );
    } else {
        const stickIdx = entries.findIndex((e) => e.id === BUILTIN_STICKER_ID || e.title === BUILTIN_STICKER_TITLE);
        if (stickIdx >= 0) {
            entries.splice(stickIdx, 1);
        }
    }

    if (JSON.stringify(entries) !== before) {
        saveEntries(deps, 'global', entries);
    }
}

/** 表情输出开启时强制附带表情包技能（不占 Top-M 名额时可额外注入） */
export function getStickerKnowledgeIfReady(deps: SmartChatDeps): SmartChatKnowledgeEntry | null {
    if (!isAnyStickerGalleryReady(deps)) return null;
    const entries = loadEntries(deps, 'global');
    const hit = entries.find((e) => e.id === BUILTIN_STICKER_ID);
    if (hit && hit.enabled !== false) return hit;
    // 未写入或被卸下：仍返回现场生成的正文，保证开关打开就能用
    return {
        id: BUILTIN_STICKER_ID,
        title: BUILTIN_STICKER_TITLE,
        content: buildStickerSkillBody(deps),
        tags: ['技能', '表情包', '图库', ...listInstalledGalleries(deps).map((g) => g.folder)],
        enabled: true,
        updated_at: new Date().toISOString(),
    };
}
