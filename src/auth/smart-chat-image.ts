// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 图片识别（PearAPI airecognizeimg）
// ---------------------------------------------------------------------------
//
// 宿主侧异步队列：先写入占位文案，解析完成后以「补充：」再入 buffer。
// 不走模型 function-calling；封装为可 await 的 recognizeImageUrl。

import * as fs from 'fs';
import * as path from 'path';
import type { SmartChatBufferEntry, SmartChatDeps, SmartChatImageRecognizeSettings, SmartChatConfig } from './smart-chat-types';
import { defaultImageRecognizeSettings, resolveChatPreset } from './smart-chat-config';
import { buildChatUrl, resolveApiProtocol, resolveEffectiveChatPath } from './smart-chat-api-url';
import { fetchTextWithDeadline, resolveChatCompletionTimeoutMs } from './smart-chat-provider';

export const IMAGE_RECOGNIZE_API = 'https://api.pearapi.ai/api/airecognizeimg/';

/**
 * 本群/好友开启识图时追加到 system（固定文案；仅 imageRecognize 开启时挂上）。
 * batch 里「[眼睛 …]」= 视网膜私货，不是用户打的字。
 */
export const IMAGE_RECOGNIZE_SYSTEM_SUFFIX =
    '\n\n[眼睛]\n' +
    '本会话开了识图：你能看见图，像正常人一样把看见的当聊天素材。\n' +
    '占位（正在解析）= 还在瞄；「[眼睛 msgid:…]」= 已经看见的短备注——不是对方发的正文，别当成用户原话去答、去引用、去复述成布局说明书。\n' +
    '备注是「加载不出来」= 这轮没看清，略过图即可，别当成用户在抱怨加载，也别追问对方描述画面。看见了就直接接话，别单独汇报「我在看图」。\n' +
    '别念色块/分区/按钮清单；只抓对方可能在问的那一点。禁止编识图厂商、OCR 接口、免费额度。\n' +
    '看不到图时（没解析出来 / 加载不出来）：绝不把「加载 / 解析 / 没刷出来 / 图片资源 / 我这边图…」这类状态说出口——当没看见、顺着文字接，或直接闭嘴。\n';

/** @deprecated 兼容旧常量引用 */
export const IMAGE_RECOGNIZE_TIMEOUT_MS = 30_000;
export const IMAGE_QUEUE_LIMIT = 3;
export const IMAGE_PER_MSG_NORMAL_MAX = 3;
export const IMAGE_PER_MSG_AT_MAX = 2;

/** 进模型的识图备注默认字数上限（约一两句要点） */
export const IMAGE_OCR_MODEL_MAX_CHARS = 72;

export interface ImageRecognizeResult {
    ok: boolean;
    result?: string;
    error?: string;
    timedOut?: boolean;
}

export interface ImagePlan {
    /** 是否把图片占位写入对话文本 */
    recordImages: boolean;
    urls: string[];
    /** 占位行（不含用户正文） */
    placeholderLine: string;
    skipReason?: string;
}

export interface ImageJobMeta {
    chatId: string;
    messageId: string;
    index: number;
    total: number;
    url: string;
    /** 视觉后端：收到即落盘的本地副本；用户撤回后 URL 失效，靠此仍能识别 */
    localPath?: string;
    isAt: boolean;
    forceFlushAfter: boolean;
    timeoutMs: number;
    userId: string;
    nickname: string;
    time: string;
    eventSnapshot: Record<string, unknown>;
}

type QueueKind = 'normal' | 'at';

interface QueueState {
    pending: ImageJobMeta[];
    running: number;
}

const queues: Record<QueueKind, QueueState> = {
    normal: { pending: [], running: 0 },
    at: { pending: [], running: 0 },
};

let supplementHandler: ((entry: SmartChatBufferEntry) => void) | null = null;
let imageLogger: SmartChatDeps['logger'] | null = null;

export function bindSmartChatImageRuntime(
    onSupplement: (entry: SmartChatBufferEntry) => void,
    logger?: SmartChatDeps['logger'],
): void {
    supplementHandler = onSupplement;
    imageLogger = logger || null;
}

// --- 视觉后端（模型自带看图）运行时绑定 ---------------------------------
// 开启 model_vision_enabled 后，识图不再走 PearAPI，改由本聊天模型看图。
// 这两个 getter 在 createSmartChatRuntime 时注入，runJob 时实时读取当前配置与数据根。
let imageVisionConfig: (() => SmartChatConfig) | null = null;
let imageDataPath: (() => string) | null = null;
/** 本地识图缓存最长保留 30 天，避免磁盘无限增长 */
const IMAGE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 本地缓存根（相对数据根）：智能对话/识图缓存/<chatId>/ */
const IMAGE_CACHE_SUBDIR = '识图缓存';

export function bindSmartChatImageVision(
    getConfig: () => SmartChatConfig,
    getDataPath: () => string,
): void {
    imageVisionConfig = getConfig;
    imageDataPath = getDataPath;
}

function imageCacheDir(chatId: string): string {
    const root = imageDataPath ? imageDataPath() : '';
    return path.join(root, '智能对话', IMAGE_CACHE_SUBDIR, String(chatId || 'unknown'));
}

function extFromUrl(u: string): string {
    const m = /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.exec(u || '');
    return m ? m[1].toLowerCase().replace('jpg', 'jpeg') : 'jpg';
}

function mimeFromExt(ext: string): string {
    switch ((ext || '').toLowerCase()) {
        case 'png': return 'image/png';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        case 'bmp': return 'image/bmp';
        default: return 'image/jpeg';
    }
}

/**
 * 收到图片即落盘（防撤回）：QQ 内图片/表情发出后被撤回，原 URL 直接失效，
 * 机器人再也无法拉到。故在入站当下就把字节存到本地缓存，识别时优先用本地副本。
 * 返回本地路径；任何失败都回 null（退化为原始 URL， PearAPI 旧链路或模型远端拉取）。
 */
export async function cacheImageLocally(
    url: string,
    chatId: string,
    messageId: string,
    index: number,
): Promise<string | null> {
    if (!imageDataPath || !/^https?:\/\//i.test(url)) return null;
    try {
        const dir = imageCacheDir(chatId);
        await fs.promises.mkdir(dir, { recursive: true });
        const ext = extFromUrl(url);
        const dest = path.join(dir, `${String(messageId || 'unknown')}_${index}.${ext}`);
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length) return null;
        await fs.promises.writeFile(dest, buf);
        void pruneImageCache(dir);
        return dest;
    } catch {
        return null;
    }
}

/** 惰性清理：删除超过保留期的缓存文件（每个 chatId 目录独立） */
async function pruneImageCache(dir: string): Promise<void> {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const now = Date.now();
        for (const e of entries) {
            if (!e.isFile()) continue;
            try {
                const st = await fs.promises.stat(path.join(dir, e.name));
                if (now - st.mtimeMs > IMAGE_CACHE_MAX_AGE_MS) {
                    await fs.promises.unlink(path.join(dir, e.name));
                }
            } catch { /* 忽略单文件清理失败 */ }
        }
    } catch { /* 目录不可用忽略 */ }
}

function safeJson(text: string): Record<string, unknown> {
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** 从 OB11 message 段提取可识别的 http(s) 图片 URL */
export function extractImageHttpUrls(message: unknown): string[] {
    if (!Array.isArray(message)) return [];
    const out: string[] = [];
    const pushUrl = (u: unknown) => {
        const url = String(u ?? '').trim();
        if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
    };
    for (const seg of message) {
        if (!seg || typeof seg !== 'object') continue;
        const type = String((seg as { type?: string }).type || '').toLowerCase();
        const data = (seg as { data?: Record<string, unknown> }).data;
        const d = data && typeof data === 'object' ? data : {};
        if (type === 'image') {
            pushUrl(d.url);
            pushUrl(d.file);
            continue;
        }
        if (type === 'file') {
            const name = String(d.file ?? d.name ?? '').toLowerCase();
            if (/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name)) pushUrl(d.url);
        }
    }
    return out;
}

export function buildImagePlaceholderLine(messageId: string, count: number): string {
    const mid = String(messageId || '').trim() || 'unknown';
    const n = Math.max(1, Number(count) || 1);
    return `${mid} 发了${n}张[图片](图片资源正在解析，也可能没有)`;
}

export function buildImageSupplementLine(
    messageId: string,
    index: number,
    body: string,
): string {
    const mid = String(messageId || '').trim() || 'unknown';
    const i = Math.max(1, Number(index) || 1);
    const compact = compactImageOcrBody(String(body || '').trim() || '加载不出来');
    return `补充：${mid} 图片第${i}张解析结果 ${compact}`;
}

/** 识图 OCR 正文压缩：去 Markdown/布局说明书，截到一两句要点（进 buffer / 会话 / 模型都用） */
export function compactImageOcrBody(body: string, maxChars = IMAGE_OCR_MODEL_MAX_CHARS): string {
    let s = String(body || '').trim();
    if (!s) return '加载不出来';
    if (/^加载不出来|^加载超时/.test(s)) return s.split(/\s/)[0] || '加载不出来';
    s = s
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)、]\s+/gm, '')
        .replace(/\n{3,}/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
    // 砍掉典型「布局说明书」前缀与分区清单噪声
    s = s
        .replace(/^这是一张[^。\n]{0,40}[。！!]?\s*/u, '')
        .replace(/^这张图片(?:展示了|显示了|是)[^。\n]{0,60}[。！!]?\s*/u, '')
        .replace(/^(?:整体|界面|画面|视觉元素|细描述|详细描述)[^：:\n]{0,30}[：:]\s*/u, '')
        .replace(/(?:整体布局与风格|布局清晰|具体描述如下|以下是详细描述|包含以下细节|各区域内容如下|区域内容如下)[：:]?\s*/gu, '')
        .replace(/\d+\.\s*(?:核心|界面|区域|顶部|底部|左侧|右侧|中间|视觉|布局|应用|窗口)[^。；;\n]{0,100}[。；;\n]?\s*/gu, '')
        .replace(/\n/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    const cap = Math.max(40, Math.min(120, Number(maxChars) || IMAGE_OCR_MODEL_MAX_CHARS));
    if (s.length <= cap) return s || '加载不出来';
    // 尽量在句读处截断
    const slice = s.slice(0, cap);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('，'), slice.lastIndexOf(' '));
    if (cut >= Math.floor(cap * 0.45)) return `${slice.slice(0, cut + (slice[cut] === ' ' ? 0 : 1)).trim()}…`;
    return `${slice.trim()}…`;
}

/**
 * 压缩文本里所有「补充：…解析结果」段（历史会话瘦身；与 API 字节一致需在写入前做）。
 */
export function compressImageSupplementsInText(text: string, maxChars = IMAGE_OCR_MODEL_MAX_CHARS): string {
    const raw = String(text || '');
    if (!raw.includes('补充：') || !raw.includes('解析结果')) return raw;

    const re = /补充：(\S+)\s*图片第(\d+)张解析结果\s*/g;
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
        out += raw.slice(last, m.index);
        const bodyStart = m.index + m[0].length;
        let bodyEnd = raw.length;
        const rest = raw.slice(bodyStart);
        const nextSup = rest.search(/\n补充：/);
        const nextEyes = rest.search(/\n\[眼睛\s/);
        const nextBatchLine = rest.search(/\n\[\d{4}-\d{2}-\d{2}[^\]]*\]/);
        const cuts = [nextSup, nextEyes, nextBatchLine].filter((n) => n >= 0);
        if (cuts.length) bodyEnd = bodyStart + Math.min(...cuts);
        const body = raw.slice(bodyStart, bodyEnd).trim();
        out += `补充：${m[1]} 图片第${m[2]}张解析结果 ${compactImageOcrBody(body, maxChars)}`;
        last = bodyEnd;
    }
    out += raw.slice(last);
    return out;
}

/**
 * B4：把「加载不出来/加载超时」的眼睛行整条删掉。
 * 失败图对回复毫无信息量，却会随历史每轮重灌占 token；历史/压缩路径直接丢弃。
 * （当轮 batch 不调用本函数，保留占位让模型知道"这轮有张图没看清"。）
 */
export function dropFailedEyesLines(text: string): string {
    let raw = String(text || '');
    if (!raw.includes('[眼睛')) return raw;
    // 独占一行的失败眼睛行：连同该行一起去掉
    raw = raw.replace(/(^|\n)[ \t]*\[眼睛\s+msgid:\S+\s+第\d+张\]:\s*(?:加载不出来|加载超时)[ \t]*(?=\n|$)/g, '');
    // 行内追加的失败眼睛段：只去掉该段
    raw = raw.replace(/[ \t]*\[眼睛\s+msgid:\S+\s+第\d+张\]:\s*(?:加载不出来|加载超时)(?=\s|$)/g, '');
    // 收敛多余空行
    raw = raw.replace(/\n{3,}/g, '\n\n');
    return raw;
}

/** 模型可见形态：眼睛备注，避免挂在昵称后被当成用户打字 */
export function formatEyesVisionLine(messageId: string, index: number, body: string, maxChars = IMAGE_OCR_MODEL_MAX_CHARS): string {
    const mid = String(messageId || '').trim() || 'unknown';
    const i = Math.max(1, Number(index) || 1);
    const compact = compactImageOcrBody(String(body || '').trim() || '加载不出来', maxChars);
    return `[眼睛 msgid:${mid} 第${i}张]: ${compact}`;
}

/**
 * 把 buffer/历史里的「补充：…」改写成 [眼睛 …]，供 compose / 会话瘦身。
 * 纯补充行会去掉「昵称:」归因，避免模型以为用户发了 OCR 正文。
 * 已是 [眼睛 …] 的长备注也会再压一遍，避免历史膨胀回灌。
 */
export function presentImageSupplementsForModel(
    text: string,
    maxChars = IMAGE_OCR_MODEL_MAX_CHARS,
    opts?: { dropFailed?: boolean },
): string {
    let raw = compressImageSupplementsInText(String(text || ''), maxChars);
    if (!raw.includes('补充：') && !raw.includes('[眼睛 ')) {
        return opts?.dropFailed ? dropFailedEyesLines(raw) : raw;
    }

    // 整行：时间戳 昵称(qq) …: 补充：mid …
    raw = raw.replace(
        /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[^(]+\(\d+\)(?:\s+\[[^\]]+\])*\s*:\s*补充：(\S+)\s*图片第(\d+)张解析结果\s*/gm,
        (_all, mid: string, idx: string) => `[眼睛 msgid:${mid} 第${idx}张]: `,
    );

    // 残留「补充：」标记（含无时间戳的纯 buffer 行）
    if (raw.includes('补充：') && raw.includes('解析结果')) {
        const re = /补充：(\S+)\s*图片第(\d+)张解析结果\s*/g;
        let out = '';
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw))) {
            out += raw.slice(last, m.index);
            const bodyStart = m.index + m[0].length;
            let bodyEnd = raw.length;
            const rest = raw.slice(bodyStart);
            const nextSup = rest.search(/\n补充：/);
            const nextEyes = rest.search(/\n\[眼睛\s/);
            const nextBatchLine = rest.search(/\n\[\d{4}-\d{2}-\d{2}[^\]]*\]/);
            const cuts = [nextSup, nextEyes, nextBatchLine].filter((n) => n >= 0);
            if (cuts.length) bodyEnd = bodyStart + Math.min(...cuts);
            const body = raw.slice(bodyStart, bodyEnd).trim();
            out += formatEyesVisionLine(m[1], Number(m[2]), body, maxChars);
            last = bodyEnd;
        }
        out += raw.slice(last);
        raw = out;
    }

    // 已写成 [眼睛 …] 的仍可能超长（旧会话）：再压 body
    raw = raw.replace(
        /\[眼睛\s+msgid:(\S+)\s+第(\d+)张\]:\s*([^\n]*)/gi,
        (_all, mid: string, idx: string, body: string) => formatEyesVisionLine(mid, Number(idx), body, maxChars),
    );

    if (opts?.dropFailed) raw = dropFailedEyesLines(raw);
    return raw;
}

/** 整段文本是否为识图补充（入队 / leftover 判定） */
export function isImageSupplementText(text: string): boolean {
    const t = String(text || '').trim();
    return /^补充：\S*\s*图片第\d+张解析结果/.test(t)
        || /^\[眼睛\s+msgid:/i.test(t);
}
/** 调用 Pear 识图；超时由 timeoutMs 控制 */
export async function recognizeImageUrl(
    fileUrl: string,
    timeoutMs = IMAGE_RECOGNIZE_TIMEOUT_MS,
): Promise<ImageRecognizeResult> {
    const file = String(fileUrl || '').trim();
    if (!/^https?:\/\//i.test(file)) {
        return { ok: false, error: 'invalid_image_url' };
    }
    const wait = Math.max(5000, Math.min(120_000, Number(timeoutMs) || IMAGE_RECOGNIZE_TIMEOUT_MS));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), wait);
    try {
        const resp = await fetch(IMAGE_RECOGNIZE_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file }),
            signal: controller.signal,
        });
        const text = await resp.text();
        let data: Record<string, unknown> = {};
        try {
            data = JSON.parse(text);
        } catch {
            return { ok: false, error: `invalid_json: ${text.slice(0, 120)}` };
        }
        if (Number(data.code) !== 200) {
            return {
                ok: false,
                error: String(data.msg || data.message || `code=${data.code}`),
            };
        }
        const result = String(data.result ?? '').trim();
        if (!result) return { ok: false, error: 'empty_result' };
        return { ok: true, result };
    } catch (e: unknown) {
        const name = e && typeof e === 'object' ? String((e as { name?: string }).name || '') : '';
        const msg = e instanceof Error ? e.message : String(e || 'error');
        if (name === 'AbortError' || /aborted/i.test(msg)) {
            return { ok: false, timedOut: true, error: 'timeout' };
        }
        return { ok: false, error: msg };
    } finally {
        clearTimeout(timer);
    }
}

function queueDepth(kind: QueueKind): number {
    const q = queues[kind];
    return q.pending.length + q.running;
}

function resolveSettings(raw?: SmartChatImageRecognizeSettings | null): SmartChatImageRecognizeSettings {
    return raw && typeof raw === 'object' ? { ...defaultImageRecognizeSettings(), ...raw } : defaultImageRecognizeSettings();
}

/**
 * 决定本条消息是否记录/识别图片。
 * - 开关关：不记录
 * - 单条超限：不记录不识别
 * - 对应队列装不下：不记录不识别
 */
export function planImageHandling(opts: {
    enabled: boolean;
    urls: string[];
    isAtBot: boolean;
    messageId?: string;
    settings?: SmartChatImageRecognizeSettings | null;
}): ImagePlan {
    const empty: ImagePlan = { recordImages: false, urls: [], placeholderLine: '' };
    if (!opts.enabled) return empty;
    const urls = Array.isArray(opts.urls) ? opts.urls.filter(Boolean) : [];
    if (!urls.length) return empty;

    const settings = resolveSettings(opts.settings);
    const perMax = opts.isAtBot ? settings.per_msg_at : settings.per_msg_normal;
    if (urls.length > perMax) {
        return {
            ...empty,
            skipReason: opts.isAtBot
                ? `艾特消息图片>${perMax}张，跳过识图`
                : `单条图片>${perMax}张，跳过识图`,
        };
    }

    const kind: QueueKind = opts.isAtBot ? 'at' : 'normal';
    const queueLimit = opts.isAtBot ? settings.queue_at : settings.queue_normal;
    if (queueDepth(kind) + urls.length > queueLimit) {
        return {
            ...empty,
            skipReason: `${kind === 'at' ? '艾特' : '普通'}识图队列已满(${queueLimit})，跳过`,
        };
    }

    return {
        recordImages: true,
        urls,
        placeholderLine: buildImagePlaceholderLine(opts.messageId || '', urls.length),
    };
}

function pump(kind: QueueKind): void {
    const q = queues[kind];
    while (q.running < 1 && q.pending.length) {
        const job = q.pending.shift();
        if (!job) break;
        q.running += 1;
        void runJob(kind, job).finally(() => {
            q.running = Math.max(0, q.running - 1);
            pump(kind);
        });
    }
}

async function runJob(kind: QueueKind, job: ImageJobMeta): Promise<void> {
    imageLogger?.info?.(
        `[智能对话·识图] ${job.chatId} msgid=${job.messageId} #${job.index}/${job.total} queue=${kind}`,
    );
    const vision = Boolean(imageVisionConfig?.()?.model_vision_enabled);
    let body: string;
    if (vision) {
        // 模型自带视觉：不再调用 PearAPI，由本聊天模型看图
        const cfg = imageVisionConfig?.();
        if (!cfg) {
            body = '加载不出来';
        } else {
            const r = await recognizeImageViaModel(cfg, job);
            if (r.ok && r.result) {
                body = r.result;
            } else {
                body = r.timedOut ? '加载超时' : '加载不出来';
                imageLogger?.warn?.(
                    `[智能对话·识图] 视觉识别失败 msgid=${job.messageId} #${job.index}: ${r.error || 'unknown'}`,
                );
            }
        }
    } else {
        // 旧链路：图片 URL → PearAPI → 文字备注
        const r = await recognizeImageUrl(job.url, job.timeoutMs);
        if (r.ok && r.result) {
            body = r.result;
        } else {
            body = r.timedOut ? '加载超时' : '加载不出来';
            imageLogger?.warn?.(
                `[智能对话·识图] 失败 msgid=${job.messageId} #${job.index}: ${r.error || 'unknown'}`,
            );
        }
    }

    const entry: SmartChatBufferEntry = {
        userId: job.userId,
        nickname: job.nickname || job.userId,
        text: buildImageSupplementLine(job.messageId, job.index, body),
        time: job.time,
        messageId: job.messageId,
        eventSnapshot: job.eventSnapshot,
        // 仅艾特+图：补充完成后强制再访问；普通图补充只入缓存
        forceFlush: Boolean(job.forceFlushAfter),
    };
    try {
        supplementHandler?.(entry);
    } catch (e: unknown) {
        imageLogger?.warn?.('[智能对话·识图] 补充入队失败:', e instanceof Error ? e.message : e);
    }
}

/**
 * 用本聊天模型自行「看」图：把图片作为多模态内容发给模型，取回一两句要点。
 * 优先用本地缓存副本（防撤回）；无本地副本则退回原始 URL（PearAPI 旧链路或模型远端拉取）。
 * 支持 OpenAI 兼容与 Anthropic 两种协议（按配置 api_protocol 选择请求体形态）。
 */
async function recognizeImageViaModel(
    config: SmartChatConfig,
    job: ImageJobMeta,
): Promise<ImageRecognizeResult> {
    const apiKey = String(config.api_key || '').trim();
    if (!apiKey) return { ok: false, error: 'api_key_not_configured' };

    const preset = resolveChatPreset(config);
    const protocol = resolveApiProtocol(config);
    const pathStr = preset.custom
        ? (String(preset.chat_path || '').trim() || resolveEffectiveChatPath('/v1/chat/completions', protocol))
        : resolveEffectiveChatPath(preset.chat_path || '/v1/chat/completions', protocol);
    const url = buildChatUrl(config.base_url, pathStr);

    // 图片来源：优先本地缓存（防撤回），否则退回原始 URL
    let imageBase64: string | null = null;
    let imageMime = 'image/jpeg';
    let imageUrl: string | null = null;
    if (job.localPath) {
        try {
            const buf = await fs.promises.readFile(job.localPath);
            const ext = (/\.([a-z0-9]+)$/i.exec(job.localPath)?.[1] || 'jpg').toLowerCase();
            imageMime = mimeFromExt(ext);
            imageBase64 = buf.toString('base64');
        } catch {
            imageUrl = job.url;
        }
    } else {
        imageUrl = job.url;
    }

    const visionPrompt =
        '用一两句像正常人一样说出这张图里、跟聊天可能相关的点。'
        + '不要列清单、不要念色块/分区/按钮、不要编造厂商或 OCR 接口。'
        + '如果图里没有可聊的内容，只回「没啥可聊的」。';

    const timeoutMs = resolveChatCompletionTimeoutMs(String(config.vendor || ''));
    try {
        let bodyText = '';
        if (protocol === 'anthropic') {
            const content: unknown[] = [];
            if (imageBase64) {
                content.push({ type: 'image', source: { type: 'base64', media_type: imageMime, data: imageBase64 } });
            } else if (imageUrl) {
                content.push({ type: 'image', source: { type: 'url', url: imageUrl } });
            }
            content.push({ type: 'text', text: visionPrompt });
            const payload = {
                model: config.model,
                system: '你是聊天机器人，需要简要理解用户发来的图片以便接话。',
                messages: [{ role: 'user', content }],
                max_tokens: 300,
            };
            const resp = await fetchTextWithDeadline(
                url,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                    body: JSON.stringify(payload),
                },
                timeoutMs,
            );
            if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
            const data = safeJson(resp.text);
            const blocks = Array.isArray(data?.content) ? (data.content as Array<{ type?: string; text?: string }>) : [];
            bodyText = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text || '')).join('').trim();
        } else {
            const content: unknown[] = [];
            if (imageBase64) {
                content.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } });
            } else if (imageUrl) {
                content.push({ type: 'image_url', image_url: { url: imageUrl } });
            }
            content.push({ type: 'text', text: visionPrompt });
            const payload = {
                model: config.model,
                messages: [
                    { role: 'system', content: '你是聊天机器人，需要简要理解用户发来的图片以便接话。' },
                    { role: 'user', content },
                ],
                temperature: 0.3,
                max_tokens: 300,
                stream: false,
            };
            const resp = await fetchTextWithDeadline(
                url,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                    body: JSON.stringify(payload),
                },
                timeoutMs,
            );
            if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
            const data = safeJson(resp.text);
            const choices = Array.isArray(data?.choices) ? (data.choices as Array<{ message?: { content?: string | null } }>) : [];
            bodyText = String(choices[0]?.message?.content ?? '').trim();
        }
        if (!bodyText) return { ok: false, error: 'empty_result' };
        return { ok: true, result: bodyText };
    } catch (e: unknown) {
        const name = e && typeof e === 'object' ? String((e as { name?: string }).name || '') : '';
        const msg = e instanceof Error ? e.message : String(e || 'error');
        if (name === 'AbortError' || /aborted/i.test(msg)) return { ok: false, timedOut: true, error: 'timeout' };
        return { ok: false, error: msg };
    }
}
/** 将本条可识别图片加入对应队列（调用前须 plan.recordImages===true）。异步：视觉后端开启时先落盘防撤回 */
export async function enqueueImageJobs(
    jobs: ImageJobMeta[],
    settings?: SmartChatImageRecognizeSettings | null,
): Promise<number> {
    if (!jobs.length) return 0;
    const cfg = resolveSettings(settings);
    const vision = Boolean(imageVisionConfig?.()?.model_vision_enabled);
    let n = 0;
    for (const job of jobs) {
        const kind: QueueKind = job.isAt ? 'at' : 'normal';
        const limit = job.isAt ? cfg.queue_at : cfg.queue_normal;
        if (queueDepth(kind) >= limit) {
            imageLogger?.warn?.(
                `[智能对话·识图] 队列满，丢弃 msgid=${job.messageId} #${job.index}`,
            );
            continue;
        }
        // 视觉后端：收到即落盘，用户撤回后 URL 失效也能识别
        if (vision && !job.localPath) {
            const lp = await cacheImageLocally(job.url, job.chatId, job.messageId, job.index);
            if (lp) job.localPath = lp;
        }
        queues[kind].pending.push(job);
        n += 1;
        pump(kind);
    }
    return n;
}

export function getImageQueueSnapshot(): { normal: number; at: number } {
    return {
        normal: queueDepth('normal'),
        at: queueDepth('at'),
    };
}
