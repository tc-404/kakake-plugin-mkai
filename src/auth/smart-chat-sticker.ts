// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 表情图库（与「消息记录」「临时视频」同级：表情图库/）
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import extractZip from 'extract-zip';
import type { SmartChatDeps } from './smart-chat-types';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** 安装源：kakake 服务器（插件内置域名）/ GitHub 仓库（Releases 直链） */
export type StickerSourceId = 'kakake' | 'github';

export interface StickerGalleryDef {
    id: string;
    /** UI 显示名 */
    name: string;
    /** 解压后目录名（相对 表情图库/） */
    folder: string;
    /** 默认源（缺省 kakake）：老调用方不传 source 时的行为保持不变 */
    zipUrl: string;
    /** 各安装源的下载地址 */
    sources: { id: StickerSourceId; label: string; url: string; hint: string }[];
}

/**
 * GitHub Releases 直链前缀。
 * 注意：GitHub 的 release 资源会 302 到 objects.githubusercontent.com，
 * 下载走的是 httpGetFollow（支持 302 跟随、跨域跟随），无需额外处理。
 */
/** 可安装的图库清单（下载哪个、解压哪个，才能用哪个文件夹） */
export const STICKER_GALLERIES: StickerGalleryDef[] = [
    {
        id: 'feibi',
        name: '菲比表情包',
        folder: '菲比',
        zipUrl: 'http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/AI图库/菲比.zip',
        sources: [
            {
                id: 'kakake',
                label: 'kakake 服务器',
                url: 'http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/AI图库/菲比.zip',
                hint: '插件内置域名，国内直连一般更快',
            },
            {
                id: 'github',
                label: 'GitHub 仓库',
                url: 'https://github.com/tc-404/kakake-plugin-main/releases/download/111/feibi.zip',
                hint: 'GitHub Releases 直链，源站更新更及时',
            },
        ],
    },
    {
        id: 'daimao',
        name: '呆猫八条',
        folder: '呆猫八条',
        zipUrl: 'http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/AI图库/呆猫八条.zip',
        sources: [
            {
                id: 'kakake',
                label: 'kakake 服务器',
                url: 'http://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/image/AI图库/呆猫八条.zip',
                hint: '插件内置域名，国内直连一般更快',
            },
            {
                id: 'github',
                label: 'GitHub 仓库',
                url: 'https://github.com/tc-404/kakake-plugin-main/releases/download/111/daimao.zip',
                hint: 'GitHub Releases 直链，源站更新更及时',
            },
        ],
    },
];

/** 默认安装源：不传 source 时走 kakake 服务器（与历史行为一致） */
export const DEFAULT_STICKER_SOURCE: StickerSourceId = 'kakake';

const STICKER_SOURCE_IDS: StickerSourceId[] = ['kakake', 'github'];

/** 把任意输入收敛成合法源 id（空/非法一律回默认源，不抛错） */
export function normalizeStickerSource(raw: unknown): StickerSourceId {
    const s = String(raw ?? '').trim().toLowerCase();
    return (STICKER_SOURCE_IDS as string[]).includes(s) ? (s as StickerSourceId) : DEFAULT_STICKER_SOURCE;
}

/**
 * 取某图库在指定源下的下载地址。
 * 源缺失（理论上不会，因为注册表是静态的）时回退到该图库的默认 zipUrl，
 * 保证「老图库定义没填 sources 也能下」。
 */
export function resolveStickerGalleryUrl(g: StickerGalleryDef, source: unknown): string {
    const id = normalizeStickerSource(source);
    const hit = (g.sources || []).find((s) => s.id === id);
    return (hit?.url || g.zipUrl || '').trim();
}

/** UI 可选源清单（前端也自己维护一份文案，此处供接口返回做单一事实来源） */
export function listStickerSources() {
    return [
        {
            id: 'kakake' as StickerSourceId,
            label: 'kakake 服务器',
            desc: '从插件内置域名下载，国内直连一般更快',
        },
        {
            id: 'github' as StickerSourceId,
            label: 'GitHub 仓库',
            desc: '从 GitHub Releases 下载，源站更新更及时（可能需要代理）',
        },
    ];
}

export type StickerInstallStatus =
    | 'idle'
    | 'downloading'
    | 'extracting'
    | 'done'
    | 'error';

export interface StickerInstallProgress {
    jobId: string;
    galleryId: string;
    /** 本次安装所用的源（kakake / github）；老 job 可能没有 */
    source?: StickerSourceId;
    status: StickerInstallStatus;
    downloaded: number;
    total: number;
    percent: number;
    /** 瞬时/平滑后的下载速度（字节/秒） */
    speedBps: number;
    /** 预计剩余秒数；未知总量或速度过低时为 null */
    etaSec: number | null;
    error?: string;
    imageCount?: number;
    updatedAt: number;
}

const installJobs = new Map<string, StickerInstallProgress>();
const installLocks = new Set<string>();
/** galleryId → 当前/最近一次 jobId，便于刷新后按图库找回进度 */
const galleryJobIndex = new Map<string, string>();

/** 非 Kakake 宿主：大包下载默认 600s（约 100MB @ 3Mbps 仍有余量） */
const STICKER_NON_KAKAKE_DOWNLOAD_TIMEOUT_MS = 600_000;

/**
 * 下载超时：Kakake 用宿主 apiTimeoutMs；其它宿主固定 600s。
 * 语义为整次下载墙钟超时（与宿主 apiTimeoutMs / 下载 API 一致）。
 */
export function resolveStickerDownloadTimeoutMs(deps: SmartChatDeps): number {
    if (typeof deps.isKakakeLikeFramework === 'function' && deps.isKakakeLikeFramework()) {
        try {
            const raw = typeof deps.resolveApiTimeoutMs === 'function'
                ? Number(deps.resolveApiTimeoutMs())
                : NaN;
            if (Number.isFinite(raw)) {
                return Math.min(600_000, Math.max(5_000, Math.floor(raw)));
            }
        } catch {
            /* resolve 失败则回退默认 */
        }
        return 120_000;
    }
    return STICKER_NON_KAKAKE_DOWNLOAD_TIMEOUT_MS;
}

/** 表情图库根目录：与消息记录、临时视频同级 */
export function getStickerGalleryRoot(deps: SmartChatDeps): string {
    const dataRoot = deps.getDataPath() || '.';
    return path.join(path.dirname(path.dirname(dataRoot)), '表情图库');
}

export function getGalleryDir(deps: SmartChatDeps, folder: string): string {
    return path.join(getStickerGalleryRoot(deps), folder);
}

function countImagesInDir(dir: string): number {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    let n = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            try {
                if (fs.statSync(p).isFile() && IMAGE_EXT_RE.test(name)) n += 1;
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return n;
}

/** 安装成功判定：解压后目录内确有图片文件 */
export function isGalleryInstalled(deps: SmartChatDeps, galleryId: string): boolean {
    const g = STICKER_GALLERIES.find((x) => x.id === galleryId);
    if (!g) return false;
    return countImagesInDir(getGalleryDir(deps, g.folder)) > 0;
}

export function isAnyStickerGalleryReady(deps: SmartChatDeps): boolean {
    return STICKER_GALLERIES.some((g) => isGalleryInstalled(deps, g.id));
}

/** 本机已安装（目录内确有图片）的图库 */
export function listInstalledGalleries(deps: SmartChatDeps): StickerGalleryDef[] {
    return STICKER_GALLERIES.filter((g) => isGalleryInstalled(deps, g.id));
}

/**
 * 已安装图库目录集合（不含张数）。
 * 冻结表情 system 后缀用：装/卸图库才算「换了一份后缀」，
 * 同一图库里多几张少几张（安装任务正在写盘）不算，避免每轮 system 字节漂移。
 */
export function stickerGalleryInstallKey(deps: SmartChatDeps): string {
    return listInstalledGalleries(deps).map((g) => g.folder).join('|');
}

/** 与运行环境 ICU 无关的稳定排序：按码点比，保证同一份文件集在任何 Node 上字节一致 */
function compareByCodePoint(a: string, b: string): number {
    const x = String(a || '');
    const y = String(b || '');
    if (x === y) return 0;
    return x < y ? -1 : 1;
}

export function listGalleryImageNames(deps: SmartChatDeps, folder: string): string[] {
    const dir = getGalleryDir(deps, folder);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    try {
        return fs.readdirSync(dir)
            .filter((name) => {
                try {
                    return fs.statSync(path.join(dir, name)).isFile() && IMAGE_EXT_RE.test(name);
                } catch {
                    return false;
                }
            })
            .sort(compareByCodePoint);
    } catch {
        return [];
    }
}

/** 技能示例用：跳过 loading 等占位图 */
function listGallerySkillFiles(deps: SmartChatDeps, folder: string): string[] {
    return listGalleryImageNames(deps, folder).filter((n) => !/^loading\./i.test(n));
}

/** 历史上被当成万能章狂刷的文件名；多数场景示范时避开 */
const STICKER_OVERUSED_RE = /啊这|啊哈哈哈|(?:^|[\\/])1?OK\.(?:webp|png|jpe?g|gif)$/i;

function isOverusedStickerName(name: string): boolean {
    return STICKER_OVERUSED_RE.test(String(name || ''));
}

/** 技能示例 / 连刷热点：示范与冷却时尽量避开 */
const STICKER_SAMPLE_HOTSPOT_RE = /好诶|疑惑菲比|1?欸嘿|欸嘿/i;

export const RECENT_STICKER_LIMIT = 6;

export function normalizeRecentStickers(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        const rel = String(item || '').trim().replace(/\\/g, '/');
        if (!rel || !looksLikeStickerRelPath(rel) || seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
        if (out.length >= RECENT_STICKER_LIMIT) break;
    }
    return out;
}

/** 出站成功后写入会话冷却队列（新→旧，最多 RECENT_STICKER_LIMIT） */
export function pushRecentStickers(
    session: { recent_stickers?: string[] },
    paths: string[],
): string[] {
    const prev = normalizeRecentStickers(session.recent_stickers);
    const next: string[] = [];
    const seen = new Set<string>();
    for (const p of [...paths, ...prev]) {
        const rel = String(p || '').trim().replace(/\\/g, '/');
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        next.push(rel);
        if (next.length >= RECENT_STICKER_LIMIT) break;
    }
    session.recent_stickers = next;
    return next;
}

export function formatRecentStickerHostHint(recent: string[]): string {
    const list = normalizeRecentStickers(recent);
    if (!list.length) return '';
    return `近几轮已用表情：${list.join('、')}；本轮换别的文件，禁止连刷同一张/同一三张`;
}

/**
 * 未点名要图时，丢掉落在冷却集里的 sticker（文字保留）。
 */
export function filterCooldownStickers<T extends { type: string; text?: string; sticker?: string }>(
    actions: T[],
    recent: string[],
    opts?: { batchWantsSticker?: boolean },
): { actions: T[]; dropped: string[] } {
    if (opts?.batchWantsSticker) return { actions: Array.isArray(actions) ? [...actions] : [], dropped: [] };
    const cool = new Set(normalizeRecentStickers(recent));
    if (!cool.size) return { actions: Array.isArray(actions) ? [...actions] : [], dropped: [] };
    const dropped: string[] = [];
    const next: T[] = [];
    for (const a of actions || []) {
        if (a.type !== 'msg') {
            next.push(a);
            continue;
        }
        const rel = String(a.sticker || '').trim().replace(/\\/g, '/');
        if (rel && cool.has(rel)) {
            dropped.push(rel);
            const text = String(a.text || '').trim();
            if (text) next.push({ ...a, sticker: undefined });
            continue;
        }
        next.push(a);
    }
    return { actions: next, dropped };
}

/**
 * 表情包选取规则场景表（空壳：按 keys/prefer 在已装图库里实扫补全）。
 * 未安装的图库整段不出现。
 */
const STICKER_PICK_SCENES: Array<{
    label: string;
    keys: string[];
    /** 若磁盘存在则优先列入 */
    prefer?: string[];
    /** 该场景允许出现万能章文件名（如无语用啊这） */
    allowOverused?: boolean;
    perGallery?: number;
}> = [
    { label: '开心/得意', keys: ['好诶', '嘿嘿', '欸嘿', '开心', '得意', '不愧是我', '我真棒', '超赞'], prefer: ['好诶.webp', '嘿嘿.webp', '开心菲比.webp', '得意菲比.webp', '哈(第一版).jpg'] },
    { label: '坏笑/搞事', keys: ['嘿嘿', '坏点子', '鬼脸', '坏...', '坏…', '哦吼'], prefer: ['嘿嘿.webp', '坏点子菲比.jpg', '鬼脸菲比.webp'] },
    { label: '难过/委屈/哭', keys: ['呜呜', '大哭', '可怜', '急哭', '失去', '失望', '被抛弃'], prefer: ['呜呜.webp', '可怜菲比.jpg', '失望.webp', '急哭菲比.jpg'] },
    { label: '生气/发火', keys: ['生气', '暴怒', '黑脸', '气鼓鼓', '超级生气', '训话', '揍'], prefer: ['生气菲比.jpg', '暴怒菲比.webp', '黑脸菲比.webp', '超级生气.jpg', '训话(指).jpg'] },
    { label: '破防', keys: ['破防', '心态', '急哭', '呜太过分', '你欺负人', '崩了'], prefer: ['急哭菲比.jpg', '呜太过分了.webp', '你欺负人！！.webp'] },
    { label: '红温', keys: ['红温', '害羞', '好过分'], prefer: ['红温菲比.jpg'] },
    { label: '肯定/同意', keys: ['好诶', '不错', '不赖', '赞成', '是这样没错', '答对了', '赞'], prefer: ['好诶.webp', '不错呢.webp', '我赞成.webp', '赞.webp', '认错.jpg'], allowOverused: false },
    { label: '否定/拒绝', keys: ['不行', '绝对不行', 'NO', '想都别想', '不准'], prefer: ['不行（达美）.webp', '绝对不行.webp', 'NO！NO！.webp', '想都别想.webp'] },
    { label: '反问/抬杠', keys: ['那咋了', '所以呢', '就这', '哈？', '你说啥', '何意味'], prefer: ['那咋了.webp', '所以呢.webp', '就这呀.webp', '哈？.webp'] },
    { label: '疑惑/不懂', keys: ['疑惑', '啊？', '嗯？', '奇怪', '难道说', '质疑', '不对劲'], prefer: ['疑惑菲比.jpg', '啊？.webp', '质疑.png', '不对劲.jpg', '疑惑.png'] },
    { label: '无语', keys: ['无语', '真令人无语', '摊手', '呃'], prefer: ['无语.webp', '无语.jpg', '菲比摊手.jpg', '啊这.webp'], allowOverused: true },
    { label: '怼人/嘲讽', keys: ['招笑', '看扁', '你是', '无礼', '滚出去', '看刀', '嫌弃'], prefer: ['就这？招笑.png', '看扁菲比.webp', '嫌弃.jpg', '看刀.png'] },
    { label: '敷衍', keys: ['哦', '嗯...', '行吧', '随便', '知道了'], prefer: ['哦.webp', '嗯...webp', '哦....webp'] },
    { label: '认真/思考', keys: ['思考', '认真', '托腮'], prefer: ['思考菲比.jpg', '思考中.webp', '托腮菲比.webp'] },
    { label: '求安慰/抱抱', keys: ['抱抱', '求抱抱', '拍拍', '亲额头', '安抚'], prefer: ['抱抱你吧.webp', '求抱抱.webp', '抱抱我嘛.webp', '拍拍头.jpg', '亲额头.jpg'] },
    { label: '抱歉/认错', keys: ['抱歉', '不好意思', '我错了', '认错', '道歉'], prefer: ['抱歉.webp', '不好意思.webp', '菲比道歉.jpg', '认错.jpg'] },
    { label: '吃瓜/看戏', keys: ['吃瓜', '看戏', '围观'], prefer: ['吃瓜菲比.webp'] },
    { label: '盯/怀疑', keys: ['盯', '怀疑', '偷窥'], prefer: ['盯.webp', '盯.jpg'] },
    { label: '哼/不理', keys: ['哼', '不理', '心虚'], prefer: ['哼.webp', '哼!.webp', '不理你了...png', '心虚.jpg'] },
    { label: '震惊/惊吓', keys: ['震惊', '哇', '目瞪口呆', '我的天', '惊讶'], prefer: ['震惊菲比.webp', '菲比震惊.jpg', '惊讶.webp', '目瞪口呆.webp'] },
    { label: '馋/好吃', keys: ['馋', '流口水', '美味', '给我尝'], prefer: ['好馋.webp', '流口水菲比.jpg', '真是美味呢.webp'] },
    { label: '困/熬夜/晚安', keys: ['熬夜', '别睡', '晚安', '再睡', '懒床', '不许睡觉', '趴'], prefer: ['熬夜菲比.png', '别睡了.webp', '晚安.webp', '漂泊者晚安.webp', '再睡五分钟.webp'] },
    { label: '摆烂/躺平', keys: ['摆烂', '生无可恋', '坐牢', '懒'], prefer: ['摆烂菲比.jpg', '生无可恋趴趴菲比.webp', '要不要摆烂？.webp'] },
    { label: '期待/蹲后续', keys: ['期待', '然后呢', '大的要来了', '蹲'], prefer: ['期待.webp', '期待菲比.webp', '然后呢？（真不知道）.webp', '大的要来了.webp'] },
    { label: '搞颜色/开车', keys: ['好色', '香草', '色色', '嘟嘟嘟说什么呢想'], prefer: ['好色菲比.jpg', '好色哦.webp', '香草直说.webp'] },
    { label: '得意/装杯', keys: ['本小姐', '装比', '炫耀', '天下无双'], prefer: ['本小姐登场.webp', '菲比装比.jpg', '炫耀.webp'] },
];

/** 在命中列表里均匀取样（稳定、可缓存；默认可避开万能章） */
function pickExamples(
    files: string[],
    keywords: string[],
    limit = 4,
    opts?: { allowOverused?: boolean },
): string[] {
    const hits = files.filter((f) => keywords.some((k) => f.includes(k)));
    if (!hits.length) return [];
    const preferred = opts?.allowOverused
        ? hits
        : hits.filter((f) => !isOverusedStickerName(f));
    const pool = (preferred.length ? preferred : hits)
        .slice()
        .sort(compareByCodePoint);
    if (pool.length <= limit) return pool;
    const out: string[] = [];
    const step = pool.length / limit;
    for (let i = 0; i < limit; i++) {
        const idx = Math.min(pool.length - 1, Math.floor(i * step + step / 2));
        const name = pool[idx];
        if (!out.includes(name)) out.push(name);
    }
    return out;
}

function pickFilesForScene(
    files: string[],
    scene: (typeof STICKER_PICK_SCENES)[number],
    limit: number,
): string[] {
    const out: string[] = [];
    const lowerMap = new Map(files.map((f) => [f.toLowerCase(), f]));
    for (const p of scene.prefer || []) {
        const exact = lowerMap.get(String(p).toLowerCase());
        if (exact && !out.includes(exact)) out.push(exact);
        // 兼容 1前缀 与 无前缀 同名
        const bare = String(p).replace(/^1/, '');
        const with1 = `1${bare}`;
        for (const cand of [bare, with1]) {
            const hit = lowerMap.get(cand.toLowerCase());
            if (hit && !out.includes(hit)) out.push(hit);
        }
        if (out.length >= limit) return out.slice(0, limit);
    }
    for (const name of pickExamples(files, scene.keys, limit, { allowOverused: scene.allowOverused })) {
        if (!out.includes(name)) out.push(name);
        if (out.length >= limit) break;
    }
    return out.slice(0, limit);
}

function pickSampleRel(deps: SmartChatDeps, g: StickerGalleryDef): string {
    const files = listGallerySkillFiles(deps, g.folder);
    if (!files.length) return `${g.folder}/（按已有文件名自选）`;
    const preferred = files.filter(
        (f) => !isOverusedStickerName(f) && !STICKER_SAMPLE_HOTSPOT_RE.test(f),
    );
    const pool = preferred.length ? preferred : files.filter((f) => !isOverusedStickerName(f));
    const use = pool.length ? pool : files;
    const prefer =
        use.find((f) => /无语|抱抱|吃瓜|哼|黑脸|拍拍|红温|晚安|熬夜|摊手|赞|不错/i.test(f))
        || use[Math.floor(use.length / 3)]
        || use[0];
    return `${g.folder}/${prefer}`;
}

/** 系统级选取规则缓存：图库安装集合不变则复用同一字符串（利于 prompt cache） */
let stickerPickRulesCache: { key: string; text: string } | null = null;

function stickerInstallFingerprint(deps: SmartChatDeps): string {
    return listInstalledGalleries(deps)
        .map((g) => `${g.folder}:${listGallerySkillFiles(deps, g.folder).length}`)
        .join('|');
}

/**
 * 按「已安装图库」动态组装选取规则（未装的不出现）。
 * 挂 system，不进每轮 user，避免重复烧 token。
 */
export function buildStickerPickRules(deps: SmartChatDeps): string {
    const installed = listInstalledGalleries(deps);
    if (!installed.length) return '';
    const key = stickerInstallFingerprint(deps);
    if (stickerPickRulesCache?.key === key) return stickerPickRulesCache.text;

    const galleryIntro = installed.map((g) => {
        const n = listGallerySkillFiles(deps, g.folder).length;
        return `${g.folder}/（${g.name}，约 ${n} 张）`;
    }).join('；');

    const lines: string[] = [
        '[表情包选取规则]',
        `已装图库：${galleryIntro}`,
        '用法：对上当下情绪/语气，从下列路径里选；也可按文件名含义在同库另挑近义图。禁止编造不存在的文件名；宿主只发真实存在的图。',
        '每次 send_sticker 算 1 行为。对方要多张时在建议条数/行为数内连调不同文件。别把啊这/啊哈哈哈/OK 当万能章连刷。',
        '',
    ];

    for (const scene of STICKER_PICK_SCENES) {
        const parts: string[] = [];
        for (const g of installed) {
            const files = listGallerySkillFiles(deps, g.folder);
            const limit = Math.max(2, Number(scene.perGallery) || (files.length > 80 ? 5 : 3));
            const picked = pickFilesForScene(files, scene, limit);
            if (!picked.length) continue;
            parts.push(...picked.map((f) => `${g.folder}/${f}`));
        }
        if (!parts.length) continue;
        lines.push(`◆ ${scene.label}：${parts.join('、')}`);
    }

    lines.push(
        '',
        '上表未覆盖的情绪：自行用文件名语义从已装前缀里挑；勿输出全库清单。',
    );

    const text = lines.join('\n');
    stickerPickRulesCache = { key, text };
    return text;
}

export function listStickerGalleriesStatus(deps: SmartChatDeps) {
    const root = getStickerGalleryRoot(deps);
    return {
        root,
        ready: isAnyStickerGalleryReady(deps),
        sources: listStickerSources(),
        defaultSource: DEFAULT_STICKER_SOURCE,
        galleries: STICKER_GALLERIES.map((g) => {
            const dir = getGalleryDir(deps, g.folder);
            const imageCount = countImagesInDir(dir);
            return {
                id: g.id,
                name: g.name,
                folder: g.folder,
                zipUrl: g.zipUrl,
                sources: g.sources,
                installed: imageCount > 0,
                imageCount,
                dir,
                activeJob: getActiveStickerInstallByGallery(g.id),
            };
        }),
    };
}

/**
 * 解析相对路径「菲比/熬夜菲比.png」→ 绝对路径。
 * 禁止越权；必须落在已安装图库目录内且文件存在。
 */
export function resolveStickerAbsolutePath(
    deps: SmartChatDeps,
    relRaw: string,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
    let rel = String(relRaw || '').trim().replace(/\\/g, '/');
    rel = rel.replace(/^["'`]+|["'`]+$/g, '');
    // 允许 AI 多写一层「表情图库/」
    if (rel.startsWith('表情图库/')) rel = rel.slice('表情图库/'.length);
    if (!rel || rel.includes('..') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
        return { ok: false, error: 'invalid_path' };
    }
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) return { ok: false, error: 'need_folder_file' };
    const folder = parts[0];
    const fileName = parts.slice(1).join('/');
    if (!fileName || fileName.includes('/') || !IMAGE_EXT_RE.test(fileName)) {
        return { ok: false, error: 'bad_filename' };
    }
    const gallery = STICKER_GALLERIES.find((g) => g.folder === folder);
    if (!gallery) return { ok: false, error: 'unknown_gallery' };
    if (!isGalleryInstalled(deps, gallery.id)) return { ok: false, error: 'gallery_not_installed' };

    const root = path.resolve(getStickerGalleryRoot(deps));
    const abs = path.resolve(root, folder, fileName);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
        return { ok: false, error: 'path_escape' };
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return { ok: false, error: 'file_missing' };
    }
    return { ok: true, abs, rel: `${folder}/${fileName}` };
}

/** 最长公共连续子串长度（模糊匹配打分用） */
function longestCommonSubstr(a: string, b: string): number {
    if (!a || !b) return 0;
    const n = b.length;
    let prev = new Array(n + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= a.length; i++) {
        const cur = new Array(n + 1).fill(0);
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                cur[j] = prev[j - 1] + 1;
                if (cur[j] > best) best = cur[j];
            }
        }
        prev = cur;
    }
    return best;
}

/** 归一化文件名：去扩展名、去修饰符号、去前缀序号、小写 */
function normStickerName(s: string): string {
    return String(s || '')
        .replace(IMAGE_EXT_RE, '')
        .replace(/[\s_\-()（）.。,，!！?？~～、]/g, '')
        .replace(/^\d+/, '')
        .toLowerCase();
}

/**
 * 模型给的文件名不存在时，在同图库真实文件里模糊找最接近的一张。
 *
 * 为什么要这一层：菲比库约 631 张，system 选取表只列了约 120 个精选路径；
 * 模型想表达选取表外的情绪时会「按含义猜」一个文件名（如 菲比/无奈.webp），
 * 一猜就 miss → 入队失败 → 触发写死认栽句。这里把「猜错文件名」救回成真实文件，
 * 尊重模型「想发这个情绪的图」的决定，而不是让插件替它认栽。
 *
 * 只救 file_missing / bad_filename / need_folder_file；库未装、路径逃逸不救（按原样返回严格错误）。
 */
export function fuzzyResolveStickerInGallery(
    deps: SmartChatDeps,
    relRaw: string,
):
    | { ok: true; abs: string; rel: string; fuzzy: boolean }
    | { ok: false; error: string } {
    const strict = resolveStickerAbsolutePath(deps, relRaw);
    if (strict.ok) return { ...strict, fuzzy: false };
    if (
        strict.error !== 'file_missing'
        && strict.error !== 'bad_filename'
        && strict.error !== 'need_folder_file'
    ) {
        return strict;
    }
    let rel = String(relRaw || '').trim().replace(/\\/g, '/').replace(/^["'`]+|["'`]+$/g, '');
    if (rel.startsWith('表情图库/')) rel = rel.slice('表情图库/'.length);
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) return strict;
    const folder = parts[0];
    const wantRaw = parts.slice(1).join('/');
    const gallery = STICKER_GALLERIES.find((g) => g.folder === folder);
    if (!gallery || !isGalleryInstalled(deps, gallery.id)) return strict;
    const dir = getGalleryDir(deps, folder);
    let files: string[] = [];
    try {
        files = fs.readdirSync(dir).filter((n) => {
            try {
                return fs.statSync(path.join(dir, n)).isFile() && IMAGE_EXT_RE.test(n);
            } catch {
                return false;
            }
        });
    } catch {
        return strict;
    }
    if (!files.length) return strict;
    const want = normStickerName(wantRaw);
    if (!want) return strict;
    let best = '';
    let bestScore = 0;
    for (const f of files) {
        const cand = normStickerName(f);
        if (!cand) continue;
        let score: number;
        if (cand === want) score = 1000;
        else if (cand.includes(want) || want.includes(cand)) {
            score = 500 + Math.min(cand.length, want.length);
        } else {
            score = longestCommonSubstr(cand, want) * 10;
        }
        if (score > bestScore) {
            bestScore = score;
            best = f;
        }
    }
    // 至少 2 个连续字重叠（*10=20），太弱不配，宁可回严格失败让上层静默
    if (!best || bestScore < 20) return strict;
    const root = path.resolve(getStickerGalleryRoot(deps));
    const abs = path.resolve(dir, best);
    if (!abs.startsWith(root + path.sep) && abs !== root) return { ok: false, error: 'path_escape' };
    return { ok: true, abs, rel: `${folder}/${best}`, fuzzy: true };
}

/** 正文是否像「菲比/xxx.png」表情路径 */
export function looksLikeStickerRelPath(text: string): boolean {
    const t = String(text || '').trim();
    if (!t || t.includes('\n') || t.length > 180) return false;
    const normalized = t.replace(/\\/g, '/').replace(/^表情图库\//, '');
    const m = normalized.match(/^([^/]+)\/([^/]+\.(?:png|jpe?g|webp|gif|bmp))$/i);
    if (!m) return false;
    return STICKER_GALLERIES.some((g) => g.folder === m[1]);
}

/** OpenAI function 名：与 mkapi / web_search 同级 */
export const SEND_STICKER_TOOL_NAME = 'send_sticker';

/**
 * 检测「给你发个/拿去」这类空头许诺短句。scrub 用它把「假装发了图」的空头正文丢弃转沉默，
 * 不再注入任何写死认栽句（插件不替模型编话）。
 */
export function looksLikeStickerVerbalPromise(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    return (
        /先给你|来点表情包|给你这个|给你几个|拿去(?:玩|吧)?|发你|发一张|发几个|发点表情|表情包来|马上发|这就发/i.test(t)
        || /给你一张|来给你|来[，,]\s*给你|发你一张|我发你|给你发|发你几/i.test(t)
    );
}

/**
 * @deprecated 勿再作出站主闸。结构兜底见 scrubStickerHonestyActions。
 */
export function looksLikeStickerFakeRefusal(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    return /留点神秘|等我哪天|哪天想炫耀|先不发(?:了|啦)?|就不发|神秘感|想炫耀再说/i.test(t);
}

/** 本批用户是否在要图（用户侧；含常见英文，让教/逼工具进得去） */
export function batchWantsStickerText(text: string): boolean {
    const t = String(text || '');
    if (!t) return false;
    return (
        /表情包|要图|发张图|发个表情|来点表情|给我.*表情|发表情|来张[图表情]|发个[图呆]/i.test(t)
        || /\bstickers?\b|\bmemes?\b|emoji\s*pack|give\s+me\s+(a\s+)?sticker/i.test(t)
        || /send\s+(me\s+)?(a\s+|an\s+)?(pic|picture|image|sticker|meme)\b/i.test(t)
        || /\b(want|need|gimme)\s+(a\s+|an\s+)?(sticker|meme|pic|picture|image)\b/i.test(t)
    );
}

/**
 * 结构诚实兜底：pending 为空且（要图 / 调过贴纸 / 宿主强制）时。
 *
 * 原则（用户要求）：插件不替模型编任何面向群友的话。发不出图时只有两种合法处理——
 *   1) 保留模型自己写的文字（它的决定，原样放行）；
 *   2) 把「发不出的那张图」这个动作丢掉（图确实发不出，不是编话，是物理事实）。
 * 另外：只有「给你发个/拿去」这种纯空头许诺、且没有任何实质内容时才整条丢弃（转为沉默），
 * 因为留着它等于让模型「假装发了图」；有实质内容的文字一律保留。
 * 不再注入任何写死认栽句。
 */
export function scrubStickerHonestyActions<T extends { type: string; text?: string; sticker?: string }>(
    actions: T[],
    opts: {
        hasPending: boolean;
        stickerAttempted: boolean;
        batchWants: boolean;
        /** B2 等宿主强制要图轮之后仍未入队 */
        honestyForce?: boolean;
    },
): T[] {
    const list = Array.isArray(actions) ? [...actions] : [];
    if (opts.hasPending) return list;

    const needHonesty = Boolean(
        opts.batchWants || opts.stickerAttempted || opts.honestyForce,
    );
    if (!needHonesty) return list;

    const next: T[] = [];
    for (const a of list) {
        if (a.type !== 'msg') {
            next.push(a);
            continue;
        }
        // 带 sticker 字段但没入队 = 这张图发不出：丢掉该动作，不发空图
        if (String(a.sticker || '').trim()) {
            const carried = String(a.text || '').trim();
            if (carried && !looksLikeStickerVerbalPromise(carried)) {
                next.push({ ...a, sticker: '' } as T); // 保留它自己写的文字
            }
            continue;
        }
        const text = String(a.text || '').trim();
        if (!text) continue;
        // 纯空头许诺（「给你发个/拿去」之类）且无实质 → 丢弃转沉默，不留「假装发了」
        if (looksLikeStickerVerbalPromise(text) && text.length <= 24) continue;
        next.push(a); // 模型自己的话，原样放行
    }
    return next;
}

/** 强制本轮调 send_sticker（OpenAI tool_choice） */
export function buildForceSendStickerToolChoice(): {
    type: 'function';
    function: { name: string };
} {
    return { type: 'function', function: { name: SEND_STICKER_TOOL_NAME } };
}

/** 挂到本轮 tools（仅表情输出开且图库就绪时） */
export function buildSendStickerOpenAiTool(deps: SmartChatDeps): {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
} | null {
    const installed = listInstalledGalleries(deps);
    if (!installed.length) return null;
    const sample = pickSampleRel(deps, installed[0]);
    const folders = installed.map((g) => g.folder).join('、');
    return {
        type: 'function',
        function: {
            name: SEND_STICKER_TOOL_NAME,
            description:
                '发送本机表情包图片（宿主先排队，本轮有文字时先发字再发图）。参数 path 为「图库名/文件名.扩展名」，'
                + `已装前缀：${folders}。示例 path="${sample}"。`
                + '对方要表情包/要图时必须调用本工具（可同轮多次、换不同文件）；'
                + '可另写短 <msg>；禁止图后再说「再来一个/别急」凑拍；'
                + '禁止只在正文说「给你几个/拿去/发你」却不调工具——那等于没发。'
                + '与 react（点消息小表情）无关。选图见 system [表情包选取规则]。',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `相对路径，如 ${sample}`,
                    },
                },
                required: ['path'],
            },
        },
    };
}

/** OpenAI function 名：按情绪查真实存在的表情文件（A4：消灭"猜文件名"） */
export const LIST_STICKERS_TOOL_NAME = 'list_stickers';

/** 单次返回的最大条数（防止把整库几百个文件名灌回上下文） */
const LIST_STICKERS_MAX = 30;

/**
 * 挂到本轮 tools：按情绪列出「真实存在」的表情文件路径，供模型据此再调 send_sticker。
 * 只有装了图库才挂。
 */
export function buildListStickersOpenAiTool(deps: SmartChatDeps): {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
} | null {
    const installed = listInstalledGalleries(deps);
    if (!installed.length) return null;
    const folders = installed.map((g) => g.folder).join('、');
    return {
        type: 'function',
        function: {
            name: LIST_STICKERS_TOOL_NAME,
            description:
                '按情绪/关键词查本机「真实存在」的表情包文件名（返回可直接用于 send_sticker 的 path）。'
                + `已装图库：${folders}。`
                + '拿不准某个情绪对应哪个文件、或想发选取表之外的情绪时，先调本工具拿真实文件名，再调 send_sticker，'
                + '不要凭含义猜文件名（猜错会发不出）。参数 emotion 可空（空则返回各库样例）。',
            parameters: {
                type: 'object',
                properties: {
                    emotion: {
                        type: 'string',
                        description: '情绪或关键词，如「无语」「开心」「生气」；可留空',
                    },
                },
                required: [],
            },
        },
    };
}

/** 执行 list_stickers：返回真实存在的 folder/文件名 列表（按 emotion 相关度排序）。 */
export function runListStickers(deps: SmartChatDeps, emotionRaw: string): string {
    const installed = listInstalledGalleries(deps);
    if (!installed.length) {
        return JSON.stringify({ ok: false, error: 'no_gallery', message: '本机未安装表情图库' });
    }
    const all: string[] = [];
    for (const g of installed) {
        for (const name of listGallerySkillFiles(deps, g.folder)) {
            all.push(`${g.folder}/${name}`);
        }
    }
    if (!all.length) {
        return JSON.stringify({ ok: false, error: 'empty_gallery', message: '图库目录内没有可用图片' });
    }
    const want = normStickerName(emotionRaw);
    let matches: string[];
    if (!want) {
        // 无关键词：各库均匀取样，给模型一个概览
        matches = all.slice(0, LIST_STICKERS_MAX);
    } else {
        const scored = all
            .map((rel) => {
                const stem = normStickerName(rel.split('/').slice(1).join('/'));
                let score: number;
                if (stem === want) score = 1000;
                else if (stem.includes(want) || want.includes(stem)) {
                    score = 500 + Math.min(stem.length, want.length);
                } else {
                    score = longestCommonSubstr(stem, want) * 10;
                }
                return { rel, score };
            })
            .filter((x) => x.score >= 10)
            .sort((a, b) => b.score - a.score);
        matches = scored.slice(0, LIST_STICKERS_MAX).map((x) => x.rel);
        // 一个都没匹配上：回退给样例，别让模型以为库是空的
        if (!matches.length) matches = all.slice(0, Math.min(12, all.length));
    }
    return JSON.stringify({
        ok: true,
        emotion: String(emotionRaw || '').trim(),
        total: all.length,
        matches,
        note: '这些是真实存在的文件；发图请把某个 path 原样传给 send_sticker，别改字。',
    });
}

/** 知识库短说明（勿塞完整选取表；完整表只挂 system） */
export function buildStickerSkillBody(deps: SmartChatDeps, opts?: { toolAttached?: boolean }): string {
    const installed = listInstalledGalleries(deps);
    if (!installed.length) {
        const names = STICKER_GALLERIES.map((g) => `「${g.name}」`).join(' / ');
        return (
            '分支：社交 · 未点亮\n'
            + '本机尚未安装可用表情图库（解压后目录内需有图片）。\n'
            + `请到技能树「表情图库管理」安装 ${names} 后再装备本技能。`
            + '下载了哪个图库，才能用哪个文件夹前缀；未安装的禁止编造。\n'
            + '本轮不能发图：禁止口头许诺发图（来，给你一张 / 发你 / 给你几个等）。'
        );
    }
    if (opts?.toolAttached === false) {
        return (
            '分支：社交 · 本轮无发图通道\n'
            + '本轮不能发图，禁止口头许诺发图（来，给你一张 / 发你 / 给你几个等）。'
        );
    }
    const sample = pickSampleRel(deps, installed[0]);
    const counts = installed
        .map((g) => `${g.folder}/约${listGallerySkillFiles(deps, g.folder).length}张`)
        .join('、');
    return (
        '分支：社交 · 已点亮（需本聊天开关「表情输出」开启）\n'
        + `已装：${counts}\n`
        + `释放：tool_calls → ${SEND_STICKER_TOOL_NAME}，参数 path="${sample}"（可同轮多次）\n`
        + '对方要图：同轮必须调工具；纯文字「给你几个/来，给你一张」不算释放，宿主不会补发。\n'
        + '文字用 <msg>；点小表情用 <react>。路径必须真实存在；未装前缀禁止编造。\n'
        + '完整「情绪→文件」选取表在 system 的 [表情包选取规则]（稳定挂载，不进每轮 user）。\n'
        + '每张算 1 行为；对方要多张时在建议条数/行为数内换不同文件连发。\n'
        + '禁止连刷同一张/同一三张。未点名要图：仅情绪合适时再发，含字即可，勿为凑数硬发表情。'
    );
}

/**
 * 挂到 system：仅当本机有可用图库且本聊天开启表情输出时追加。
 * 含完整选取规则；安装集合不变则字节稳定（利于缓存，避免当 user 每轮重灌）。
 */
export function buildStickerSystemSuffix(deps: SmartChatDeps): string {
    const installed = listInstalledGalleries(deps);
    if (!installed.length) return '';
    const sample = pickSampleRel(deps, installed[0]);
    const rules = buildStickerPickRules(deps);
    return (
        '\n\n[技能树 · 表情包]\n'
        + '本聊天已开启表情输出，图库已装好。发图唯一通道是工具 '
        + SEND_STICKER_TOOL_NAME
        + '（宿主执行即发出），不会根据嘴炮补发：\n'
        + `调用：${SEND_STICKER_TOOL_NAME}({ "path": "${sample}" })\n`
        + '可同轮多次、换不同文件。收尾可用短 <msg>；禁止只有「给你几个/拿去/发你」却零次工具调用。\n'
        + '普通闲聊多数只打字；路径必须来自下方已装表，禁止编造未装前缀。\n'
        + `拿不准文件名、或想发选取表外的情绪：先调 ${LIST_STICKERS_TOOL_NAME}({ "emotion": "情绪词" }) 拿真实文件名，再 ${SEND_STICKER_TOOL_NAME}，别凭含义猜（猜错发不出）。\n`
        + '与「表情回应」react（点小表情）不是一类东西。旧 XML <sticker> 仅兼容，不要当主用法。\n'
        + '\n'
        + rules
        + '\n'
    );
}

function calcEtaSec(downloaded: number, total: number, speedBps: number): number | null {
    if (!(total > 0) || !(speedBps > 64)) return null;
    const remain = total - downloaded;
    if (remain <= 0) return 0;
    return Math.max(0, Math.ceil(remain / speedBps));
}

function updateJob(jobId: string, patch: Partial<StickerInstallProgress>): StickerInstallProgress {
    const prev = installJobs.get(jobId) || {
        jobId,
        galleryId: '',
        status: 'idle' as StickerInstallStatus,
        downloaded: 0,
        total: 0,
        percent: 0,
        speedBps: 0,
        etaSec: null as number | null,
        updatedAt: Date.now(),
    };
    const next: StickerInstallProgress = { ...prev, ...patch, updatedAt: Date.now() };
    if (patch.etaSec === undefined) {
        next.etaSec = calcEtaSec(next.downloaded, next.total, next.speedBps);
    }
    installJobs.set(jobId, next);
    if (next.galleryId) galleryJobIndex.set(next.galleryId, jobId);
    return next;
}

export function getStickerInstallProgress(jobId: string): StickerInstallProgress | null {
    const j = installJobs.get(String(jobId || '').trim());
    if (!j) return null;
    return finalizeStaleInstallJob(j);
}

/** 进行中任务若长时间无进度更新，视为中断（避免前端永久轮询刷屏） */
const STALE_DOWNLOADING_MS = 90_000;
const STALE_EXTRACTING_MS = 600_000;

function finalizeStaleInstallJob(job: StickerInstallProgress): StickerInstallProgress {
    if (job.status !== 'downloading' && job.status !== 'extracting') return job;
    const age = Date.now() - Number(job.updatedAt || 0);
    const limit = job.status === 'extracting' ? STALE_EXTRACTING_MS : STALE_DOWNLOADING_MS;
    if (!(age > limit)) return job;
    const next = updateJob(job.jobId, {
        status: 'error',
        error: '安装任务已中断或超时（可重新点安装）',
        speedBps: 0,
        etaSec: null,
    });
    if (job.galleryId) installLocks.delete(job.galleryId);
    return next;
}

export function getActiveStickerInstallByGallery(galleryId: string): StickerInstallProgress | null {
    const gid = String(galleryId || '').trim();
    if (!gid) return null;
    const indexed = galleryJobIndex.get(gid);
    if (indexed) {
        const j = installJobs.get(indexed);
        if (j && (j.status === 'downloading' || j.status === 'extracting')) {
            const cur = finalizeStaleInstallJob(j);
            if (cur.status === 'downloading' || cur.status === 'extracting') return cur;
        }
    }
    let best: StickerInstallProgress | null = null;
    for (const j of installJobs.values()) {
        if (j.galleryId !== gid) continue;
        if (j.status !== 'downloading' && j.status !== 'extracting') continue;
        const cur = finalizeStaleInstallJob(j);
        if (cur.status !== 'downloading' && cur.status !== 'extracting') continue;
        if (!best || cur.updatedAt >= best.updatedAt) best = cur;
    }
    return best;
}

function httpGetFollow(
    url: string,
    redirects = 0,
    timeoutMs = STICKER_NON_KAKAKE_DOWNLOAD_TIMEOUT_MS,
): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        if (redirects > 5) {
            reject(new Error('too_many_redirects'));
            return;
        }
        const idleMs = Math.max(5_000, Number(timeoutMs) || STICKER_NON_KAKAKE_DOWNLOAD_TIMEOUT_MS);
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': 'MKbot-SmartChat/1.0' } }, (res) => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location) {
                const next = new URL(res.headers.location, url).toString();
                res.resume();
                httpGetFollow(next, redirects + 1, idleMs).then(resolve, reject);
                return;
            }
            if (code !== 200) {
                res.resume();
                reject(new Error(`http_${code}`));
                return;
            }
            // 响应体空闲超时（慢速但持续有数据时不会误杀）
            res.setTimeout(idleMs, () => {
                res.destroy(new Error(`ETIMEDOUT 下载空闲超时 ${idleMs}ms`));
            });
            resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(idleMs, () => {
            req.destroy(new Error(`ETIMEDOUT 连接/空闲超时 ${idleMs}ms`));
        });
    });
}

async function downloadWithProgress(
    url: string,
    destFile: string,
    jobId: string,
    timeoutMs: number,
): Promise<void> {
    const wallMs = Math.max(5_000, Number(timeoutMs) || STICKER_NON_KAKAKE_DOWNLOAD_TIMEOUT_MS);
    const res = await httpGetFollow(url, 0, wallMs);
    const total = Number(res.headers['content-length'] || 0) || 0;
    let downloaded = 0;
    let lastTick = Date.now();
    let lastBytes = 0;
    let speedBps = 0;
    const startedAt = Date.now();

    await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
    const ws = createWriteStream(destFile);

    let settled = false;
    const wallTimer = setTimeout(() => {
        if (settled) return;
        const err = new Error(`ETIMEDOUT 下载超时 ${wallMs}ms`);
        try { res.destroy(err); } catch { /* ignore */ }
        try { ws.destroy(err); } catch { /* ignore */ }
    }, wallMs);

    res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        const now = Date.now();
        const dt = now - lastTick;
        if (dt >= 350) {
            const instant = ((downloaded - lastBytes) * 1000) / Math.max(1, dt);
            // EMA 平滑速度，ETA 更稳
            speedBps = speedBps > 0
                ? Math.round(speedBps * 0.65 + instant * 0.35)
                : Math.round(instant);
            lastTick = now;
            lastBytes = downloaded;
        }
        // 起步阶段也用全程平均兜底，避免 ETA 空白太久
        const elapsed = Math.max(1, now - startedAt);
        const avgBps = Math.round((downloaded * 1000) / elapsed);
        const effectiveSpeed = speedBps > 0
            ? Math.round(speedBps * 0.7 + avgBps * 0.3)
            : avgBps;
        const percent = total > 0 ? Math.min(99, Math.floor((downloaded * 100) / total)) : 0;
        updateJob(jobId, {
            status: 'downloading',
            downloaded,
            total,
            percent,
            speedBps: effectiveSpeed,
            etaSec: calcEtaSec(downloaded, total, effectiveSpeed),
        });
    });

    try {
        await pipeline(res as unknown as Readable, ws);
    } finally {
        settled = true;
        clearTimeout(wallTimer);
    }
    updateJob(jobId, {
        status: 'downloading',
        downloaded,
        total: total || downloaded,
        percent: 100,
        speedBps,
        etaSec: 0,
    });
}

function rmrf(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
}

/** 把解压结果整理进 表情图库/<folder>/ */
function normalizeExtractedGallery(extractRoot: string, folder: string, destDir: string): number {
    const nested = path.join(extractRoot, folder);
    let srcDir = extractRoot;
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory() && countImagesInDir(nested) > 0) {
        srcDir = nested;
    } else if (countImagesInDir(extractRoot) > 0) {
        srcDir = extractRoot;
    } else {
        // 再找一层子目录里图片最多的
        try {
            let best = '';
            let bestN = 0;
            for (const name of fs.readdirSync(extractRoot)) {
                const p = path.join(extractRoot, name);
                if (!fs.statSync(p).isDirectory()) continue;
                const n = countImagesInDir(p);
                if (n > bestN) {
                    bestN = n;
                    best = p;
                }
            }
            if (bestN > 0) srcDir = best;
        } catch { /* ignore */ }
    }

    fs.mkdirSync(destDir, { recursive: true });
    // 清空旧图再拷贝，避免半残安装被当成成功
    for (const name of fs.readdirSync(destDir)) {
        rmrf(path.join(destDir, name));
    }

    let n = 0;
    for (const name of fs.readdirSync(srcDir)) {
        const from = path.join(srcDir, name);
        if (!fs.statSync(from).isFile() || !IMAGE_EXT_RE.test(name)) continue;
        fs.copyFileSync(from, path.join(destDir, name));
        n += 1;
    }
    return n;
}

export async function startStickerGalleryInstall(
    deps: SmartChatDeps,
    galleryId: string,
    source: unknown = DEFAULT_STICKER_SOURCE,
): Promise<StickerInstallProgress> {
    const g = STICKER_GALLERIES.find((x) => x.id === galleryId);
    if (!g) {
        throw new Error('unknown_gallery');
    }
    const sourceId = normalizeStickerSource(source);
    const zipUrl = resolveStickerGalleryUrl(g, sourceId);
    if (!zipUrl) {
        throw new Error('no_source_url');
    }
    if (installLocks.has(g.id)) {
        const existing = [...installJobs.values()].find(
            (j) => j.galleryId === g.id && (j.status === 'downloading' || j.status === 'extracting'),
        );
        if (existing) {
            const cur = finalizeStaleInstallJob(existing);
            if (cur.status === 'downloading' || cur.status === 'extracting') return cur;
        }
    }

    const jobId = `${g.id}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    installLocks.add(g.id);
    updateJob(jobId, {
        jobId,
        galleryId: g.id,
        source: sourceId,
        status: 'downloading',
        downloaded: 0,
        total: 0,
        percent: 0,
        speedBps: 0,
        etaSec: null,
    });

    const root = getStickerGalleryRoot(deps);
    const tmpDir = path.join(root, '.tmp', jobId);
    const zipPath = path.join(tmpDir, `${g.folder}.zip`);
    const extractDir = path.join(tmpDir, 'extract');
    const destDir = getGalleryDir(deps, g.folder);

    (async () => {
        try {
            const timeoutMs = resolveStickerDownloadTimeoutMs(deps);
            fs.mkdirSync(extractDir, { recursive: true });
            deps.logger?.info?.(
                `[智能对话·表情图库] 开始下载 ${g.name} source=${sourceId} url=${zipUrl} timeout=${timeoutMs}ms`
                + (deps.isKakakeLikeFramework?.() ? ' (kakake apiTimeoutMs)' : ' (non-kakake 600s)'),
            );
            await downloadWithProgress(zipUrl, zipPath, jobId, timeoutMs);
            updateJob(jobId, { status: 'extracting', percent: 100 });
            await extractZip(path.resolve(zipPath), { dir: path.resolve(extractDir) });
            const imageCount = normalizeExtractedGallery(extractDir, g.folder, destDir);
            if (imageCount <= 0) {
                updateJob(jobId, {
                    status: 'error',
                    error: '解压后未找到图片，安装失败',
                    imageCount: 0,
                });
                return;
            }
            updateJob(jobId, {
                status: 'done',
                percent: 100,
                imageCount,
                source: sourceId,
            });
            deps.logger?.info?.(`[智能对话·表情图库] 安装成功 ${g.name}（源 ${sourceId}）共 ${imageCount} 张 → ${destDir}`);
            // 装完立刻刷新技能树文案（避免仍显示未装/旧图库）
            try {
                const { ensureBuiltinKnowledge } = await import('./smart-chat-knowledge.js');
                ensureBuiltinKnowledge(deps);
            } catch (e) {
                deps.logger?.warn?.('[智能对话·表情图库] 刷新技能树失败:', e?.message || e);
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            updateJob(jobId, { status: 'error', error: msg || 'install_failed' });
            deps.logger?.warn?.(`[智能对话·表情图库] 安装失败:`, msg);
        } finally {
            installLocks.delete(g.id);
            try {
                rmrf(tmpDir);
            } catch { /* ignore */ }
        }
    })();

    return installJobs.get(jobId)!;
}

export const BUILTIN_STICKER_ID = 'kb_builtin_sticker';
export const BUILTIN_STICKER_TITLE = '◆ 表情包输出';
