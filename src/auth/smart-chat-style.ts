// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — Style Pack（示例驱动真人化；随稳定 system 挂载，不进每轮 user）
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type StylePackId = 'groupie' | 'rp' | 'teasing';

export interface StylePackExample {
    situation: string;
    say: string;
}

export interface StylePack {
    id: string;
    title: string;
    examples: StylePackExample[];
}

/**
 * 内置回落包：**必须与 style-packs/groupie.json 逐行一致**（磁盘读失败时用，不一致就等于两个人格）。
 * 12 条是 buildStylePackBlock 的截断上限，所以增删要成对做，别只改磁盘那份。
 */
const GROUPIE_FALLBACK: StylePack = {
    id: 'groupie',
    title: '伪装群员',
    examples: [
        { situation: '接梗', say: '短接一下现场，自造一句，接完再补一句自己的，别用固定口头禅' },
        { situation: '抬杠', say: '真想顶的时候才轻轻顶一句，别讲道理、别复读对方结论' },
        { situation: '不确定', say: '承认不懂，或问一句这是啥/再问个细节；别编、别打发人' },
        { situation: '看不懂的梗', say: '说一句没跟上或问一句这是啥，别硬接也别嘲' },
        { situation: '有人示弱', say: '别补刀、别讲道理，接住情绪再给一句具体的' },
        { situation: '被点名', say: '正面短回，用自己的话，别套「在，咋了」' },
        { situation: '要表情', say: '调 send_sticker；文字可有可无，最多一句' },
        { situation: '别人互聊插不上', say: '<shut_up/> 或只 react' },
        { situation: '吐槽', say: '一句情绪即可，别铺成两三拍' },
        { situation: '附和', say: '带一点自己的态度，别只回单字口头禅' },
        { situation: '连发多条', say: '聊得投入时可以连两拍（第二拍补细节或追问一句），一批里别重复同一个句尾符号' },
        { situation: '复读自己', say: '近几轮用过的开头/结尾句式换掉，口头禅不是签名' },
    ],
};

const cache = new Map<string, StylePack | null>();

function tryLoadFromDisk(id: string): StylePack | null {
    try {
        const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'style-packs');
        const raw = fs.readFileSync(path.join(dir, `${id}.json`), 'utf8');
        const obj = JSON.parse(raw);
        const examples = Array.isArray(obj?.examples) ? obj.examples : [];
        const pack: StylePack = {
            id: String(obj?.id || id),
            title: String(obj?.title || id),
            examples: examples
                .map((e) => ({
                    situation: String(e?.situation || '').trim(),
                    say: String(e?.say || '').trim(),
                }))
                .filter((e) => e.situation && e.say),
        };
        return pack.examples.length ? pack : null;
    } catch {
        return null;
    }
}

/** 默认伪装群员包；未知 id 回落 groupie */
export function loadStylePack(id?: string): StylePack {
    const want = String(id || 'groupie').trim() || 'groupie';
    if (cache.has(want)) return cache.get(want) || GROUPIE_FALLBACK;
    const fromDisk = tryLoadFromDisk(want) || (want === 'groupie' ? null : tryLoadFromDisk('groupie'));
    const pack = fromDisk || GROUPIE_FALLBACK;
    cache.set(want, pack);
    return pack;
}

/** 稳定 system 里的示例块（半稳定文案，变更不打指纹） */
export function buildStylePackBlock(packId?: string): string {
    const p = loadStylePack(packId);
    if (!p?.examples?.length) return '';
    const lines = p.examples.slice(0, 12).map(
        (e) => `- ${e.situation} → ${e.say}`,
    );
    return (
        `<style-pack id="${p.id}">\n`
        + `（口吻参考「${p.title}」；只学节奏与态度；右侧不是可发送原文）\n`
        + `${lines.join('\n')}\n`
        + `</style-pack>`
    );
}

/** 句尾符号候选：只做确定性统计，不做语义判断 */
const TAIL_MARKS = '～~!！?？。…♪♡';
/** 开场语气词：只认固定字头，避免把正常词误判成口头禅 */
const OPENER_RE = /^(?:emmm?|awsl|哈哈+|嘿嘿+|嘻嘻+|诶+|哎+|欸+|哦+|噢+|唔+|嗯+|啊+|呀+|哟+|咦+|唉+|草)/i;

/** 去掉开头的 @昵称：点名对象不是口头禅 */
function stripLeadAt(s: string): string {
    return String(s || '').replace(/^(?:@\S+\s*)+/, '').trim();
}

/** 去掉句尾符号与空白：符号本身已单独统计，别混进句式里 */
function stripTailMarks(s: string): string {
    let t = String(s || '').trim();
    while (t && (TAIL_MARKS.includes(t.slice(-1)) || /\s/.test(t.slice(-1)))) t = t.slice(0, -1);
    return t;
}

function commonPrefix(a: string, b: string, maxLen: number): string {
    const n = Math.min(a.length, b.length, maxLen);
    let i = 0;
    while (i < n && a[i] === b[i]) i += 1;
    return a.slice(0, i);
}

function commonSuffix(a: string, b: string, maxLen: number): string {
    const n = Math.min(a.length, b.length, maxLen);
    let i = 0;
    while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
    return i ? a.slice(a.length - i) : '';
}

/** 同族短语只留最长的那个（「本小姐才不」盖过「本小姐」），顺带去重 */
function maximalPhrases(list: string[]): string[] {
    const uniq = [...new Set(list.filter(Boolean))].sort((a, b) => b.length - a.length);
    const out: string[] = [];
    for (const p of uniq) {
        if (out.some((q) => q.includes(p))) continue;
        out.push(p);
    }
    return out;
}

/**
 * 口头禅（复读句式）检测：只看句首与句尾的重复。
 *
 * 为什么只看两端：口头禅长在开头和结尾（「本小姐才不…」「…是不是呀」），
 * 中间的重复词多半是本轮话题词（表情包、图源），报出来只会让它绕开该说的词。
 * 判据是「自己两条发言在同一端撞了 ≥minLen 个字」，确定性、零语义推理。
 */
export function findRepeatedEdgePhrases(
    texts: string[],
    opts?: { minLen?: number; maxLen?: number; exclude?: string },
): { heads: string[]; tails: string[] } {
    const minLen = Math.max(2, Number(opts?.minLen) || 3);
    const maxLen = Math.max(minLen, Number(opts?.maxLen) || 8);
    const exclude = String(opts?.exclude || '').trim();
    const list = (texts || [])
        .map((t) => stripTailMarks(stripLeadAt(t)))
        .filter((t) => t.length >= minLen);
    const usable = (phrase: string): boolean => {
        if (!phrase || phrase.length < minLen) return false;
        // 自己的昵称不算口头禅（人设写死的自称也别拿这条去压）
        if (exclude && (phrase.includes(exclude) || exclude.includes(phrase))) return false;
        return /[\u4e00-\u9fa5a-zA-Z]/.test(phrase);
    };
    const rawHeads: string[] = [];
    const rawTails: string[] = [];
    for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
            const h = commonPrefix(list[i], list[j], maxLen);
            if (usable(h)) rawHeads.push(h);
            const t = commonSuffix(list[i], list[j], maxLen);
            if (usable(t)) rawTails.push(t);
        }
    }
    return {
        heads: maximalPhrases(rawHeads).slice(0, 2),
        tails: maximalPhrases(rawTails).slice(0, 2),
    };
}

/** 抽 <msg> 正文；沉默轮（只有 react / shut_up）自然得空数组 */
function extractMsgTexts(content: string): string[] {
    const out: string[] = [];
    for (const m of String(content || '').matchAll(/<msg\b[^>]*>([\s\S]*?)<\/msg>/g)) {
        const t = String(m[1] || '').trim();
        if (t) out.push(t);
    }
    return out;
}

/**
 * 结构化句式复读检测：补 findRepeatedEdgePhrases 的盲区。
 *
 * 逐字撞头/尾只能抓「本小姐才不…」这种字面复读，抓不住「复述+判定」这类
 * 换了词但骨架一样的句式（实测大量：『X 这就是 Y 吗』『这波属于 Z』『XX 通病』
 * 『F12 一按就搞定的事』），它们没有共享 3 字前后缀，旧检测一条都报不出来。
 * 这里按「判定/吐槽骨架标记」计数：同一骨架在近几轮里出现 ≥2 次就报出来，
 * 让模型换个说法，别每条都是同一个吐槽模板。
 */
const TEMPLATE_MARKERS: Array<{ re: RegExp; label: string }> = [
    { re: /这就是(.{0,8}?)(吗|吧|？|\?)?$/, label: '这就是…吗' },
    { re: /这(波|就)?属于|属于(.{0,6})?(了|吧)?$/, label: '属于…' },
    { re: /(是吧|对吧|不是吗)[\s！!。…]*$/, label: '…是吧/对吧' },
    { re: /通病|典型|名场面|典中典|遥遥领先/, label: '通病/典型…（贴标签）' },
    { re: /笑死|绷不住|绷住了|好家伙|蚌埠住/, label: '笑死/好家伙…（口头吐槽）' },
    { re: /不愧是|果然是|果然还是/, label: '不愧是/果然…' },
    { re: /传说中的|传闻中的/, label: '传说中的…' },
    { re: /什么叫.{0,10}(懂了|明白了)/, label: '什么叫…（反讽句式）' },
];

export function findRepeatedTemplates(texts: string[]): string[] {
    const list = (texts || []).map((t) => stripTailMarks(stripLeadAt(t))).filter(Boolean);
    if (list.length < 2) return [];
    const out: string[] = [];
    for (const { re, label } of TEMPLATE_MARKERS) {
        let hits = 0;
        for (const t of list) if (re.test(t)) hits += 1;
        if (hits >= 2 && !out.includes(label)) out.push(label);
    }
    return out.slice(0, 3);
}

/**
 * 近 N 轮自己用过的句尾符号、开场语气词与复读句式 —— 宿主实测事实，进 turn 尾。
 * 「换一个别复读」这条规则写在 Style Pack（稳定段），这里只报数据，不重复规则。
 * 87% 句尾波浪号、53% 语气词开场都是同一个模板反复用，模型自己看不到这个统计。
 */
export function formatRecentStyleHostHint(
    messages: { role?: string; content?: string }[] | undefined,
    rounds = 3,
    opts?: { botNickname?: string },
): string {
    const list = Array.isArray(messages) ? messages : [];
    const recent = list.filter((m) => m?.role === 'assistant').slice(-Math.max(1, rounds));
    if (!recent.length) return '';
    const tails: string[] = [];
    const openers: string[] = [];
    const texts: string[] = [];
    for (const m of recent) {
        for (const text of extractMsgTexts(m.content)) {
            texts.push(text);
            const last = text.slice(-1);
            if (TAIL_MARKS.includes(last) && !tails.includes(last)) tails.push(last);
            const opener = text.match(OPENER_RE)?.[0];
            if (opener && !openers.includes(opener)) openers.push(opener);
        }
    }
    // 口头禅：句首/句尾撞出来的复读句式；纯语气词开场已由上面的「开场」报过，不重复列
    const edges = findRepeatedEdgePhrases(texts, { exclude: opts?.botNickname });
    const phrases = [
        ...edges.tails,
        ...edges.heads.filter((h) => h.match(OPENER_RE)?.[0] !== h),
    ].slice(0, 2);
    // 结构化句式骨架复读（逐字检测抓不到的「复述+判定」模板）
    const templates = findRepeatedTemplates(texts);

    const parts: string[] = [];
    if (tails.length) parts.push(`句尾 ${tails.slice(0, 3).join('')}`);
    if (openers.length) parts.push(`开场 ${openers.slice(0, 3).join('/')}`);
    if (phrases.length) parts.push(`口头禅 ${phrases.map((p) => `「${p}」`).join('')}`);
    if (templates.length) parts.push(`句式复读 ${templates.map((p) => `「${p}」`).join('')}（换个说法，别老一个吐槽模板）`);
    if (!parts.length) return '';
    return `近 ${recent.length} 轮自己已用：${parts.join(' · ')}`;
}
