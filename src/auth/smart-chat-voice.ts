// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 语音输出
//   引擎二选一（config.voice.engine）：
//     · 'pearapi'（默认）：第三方 AI 配音（内置体验额度密钥，可填自有优先）
//     · 'qqai'          ：QQ 自带 AI 语音（NapCat get_ai_record / get_ai_characters，仅群聊）
//   共同约束：只接受纯文本，净化掉艾特/引用/特殊标点/表情/链接；单条硬顶 150 字。
//   共同策略：先把音频下载到本地临时文件，再以本地文件形式交给发送层——
//             这样超时 / 下载失败都能在合成阶段发现并回退文本，且不占用主流程。
//   生成失败 / 超长 / 私聊用 QQAI → 交回调用方按文本发送。
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { SmartChatConfig, SmartChatDeps } from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';
import { DEFAULT_VOICE_DUB } from './smart-chat-config';

export const VOICE_API_URL = 'https://api.pearapi.ai/api/dub/';
/** 内置体验额度密钥：仅在代码内使用，绝不下发前端 / 不写进配置文件 */
const BUILT_IN_VOICE_KEY = 'a87beaa4146b6fca';
/** 单条语音硬上限（净化后字符数）；配置里的 max_chars 也会被夹到这个天花板内 */
export const VOICE_HARD_CHAR_CAP = 150;
/** 一次回复最多发几条语音（其余气泡退回文本）——「分段内容俩次访问即可」 */
export const VOICE_MAX_SEGMENTS = 2;
/** 语音缓存目录保留的最近文件数 */
const VOICE_CACHE_KEEP = 40;
/** 支持的引擎 */
export type VoiceEngine = 'pearapi' | 'qqai';

/** 第三方合成 / 下载统一带上的请求头（有些 CDN 不给裸 UA 放行） */
const VOICE_HTTP_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://api.pearapi.ai/',
};

export function resolveVoiceEngine(cfg: SmartChatConfig): VoiceEngine {
    return cfg?.voice?.engine === 'qqai' ? 'qqai' : 'pearapi';
}

export function resolveVoiceKey(cfg: SmartChatConfig): string {
    const own = String(cfg?.voice?.api_key || '').trim();
    return own || BUILT_IN_VOICE_KEY;
}

export function isUsingOwnVoiceKey(cfg: SmartChatConfig): boolean {
    return Boolean(String(cfg?.voice?.api_key || '').trim());
}

export function voiceMaxChars(cfg: SmartChatConfig): number {
    const n = Number(cfg?.voice?.max_chars);
    if (!Number.isFinite(n) || n <= 0) return VOICE_HARD_CHAR_CAP;
    return Math.min(VOICE_HARD_CHAR_CAP, Math.max(1, Math.round(n)));
}

/**
 * 语音文本净化：语音是单节点，去掉一切非「可念读」的内容。
 * - 去 CQ 码 / <标签> / @昵称 / 引用残留 / URL / markdown
 * - 去 emoji、颜文字里的特殊符号、装饰性标点，只留中英数字与基本可念标点
 * - 折叠空白
 * 返回净化后的纯文本（可能为空串）。
 */
export function sanitizeVoiceText(raw: unknown): string {
    let s = String(raw ?? '');
    if (!s) return '';
    // CQ 码 / 富文本标签
    s = s.replace(/\[CQ:[^\]]*\]/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    // URL
    s = s.replace(/https?:\/\/\S+/gi, ' ');
    s = s.replace(/\b[\w.-]+\.(?:com|cn|net|org|io|xyz|top)\b\S*/gi, ' ');
    // @某人 / at 残留（@数字、@昵称）
    s = s.replace(/@\S+/g, ' ');
    // markdown 记号
    s = s.replace(/[*_`~#>|]+/g, ' ');
    // emoji / 杂项符号 / 方块图形（含 QQ 表情文字残留）
    s = s.replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\uFE00-\uFE0F\u200D]/gu,
        '',
    );
    // 只保留：中日韩、拉丁、数字、空白，以及一组「可念读」的基础标点
    //   句读：。，、？！：； 省略/破折 …—  括号引号一律删（念不出）
    s = s.replace(/[^\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9\s。，、？！：；…—.,?!]/g, ' ');
    // 折叠空白与重复标点
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/([。，、？！：；.,?!])\1{2,}/g, '$1');
    return s;
}

/**
 * 判断一条正文能否走语音：净化后非空且 ≤ 上限。
 * 返回净化文本或 null（null=不合格，应按文本发送）。
 */
export function voiceReadyText(raw: unknown, maxChars: number): string | null {
    const clean = sanitizeVoiceText(raw);
    if (!clean) return null;
    // 语音里没意义的纯标点串也退回文本
    if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(clean)) return null;
    if ([...clean].length > (maxChars || VOICE_HARD_CHAR_CAP)) return null;
    return clean;
}

function voiceCacheDir(deps: SmartChatDeps): string {
    const root = deps.getDataPath?.() || '.';
    const dir = path.join(root, ...SMART_CHAT_ROOT.split('/').filter(Boolean), 'voice-cache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function pruneVoiceCache(dir: string): void {
    try {
        const files = fs.readdirSync(dir)
            .map((f) => ({ f, p: path.join(dir, f) }))
            .map((x) => ({ ...x, m: fs.statSync(x.p).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        for (const x of files.slice(VOICE_CACHE_KEEP)) {
            try { fs.unlinkSync(x.p); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function buildDubUrl(params: Record<string, string>): string {
    const q = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return `${VOICE_API_URL}?${q}`;
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function guessAudioExt(u: string, fallback: string): string {
    if (/\.mp3(\?|$)/i.test(u)) return 'mp3';
    if (/\.wav(\?|$)/i.test(u)) return 'wav';
    if (/\.(?:amr|silk)(\?|$)/i.test(u)) return 'silk';
    if (/\.ogg(\?|$)/i.test(u)) return 'ogg';
    return fallback;
}

/**
 * 把远端音频地址下载到本地缓存，返回**裸绝对路径**（正斜杠）。
 *
 * 返回裸路径而不是 file:// URL：调用方（段_语音）会把它读成 base64:// 再发给协议端。
 * 协议端 record 段**只认 http(s) / base64**，本地裸路径和 file:// 都会被它的
 * URL 识别拦下（前者报「识别URL失败」，后者报「语音转换失败」）——2026-09-29 实测两轮确认。
 * 保留本地缓存这一步的价值：NapCat 侧取远端 URL 失败时还有本地副本兜底，
 * 且 QQAI 引擎本身就返回本地文件。
 * 带请求头、限时、重试；失败返回 null（由调用方决定回退策略）。
 */
async function downloadAudioToCache(
    deps: SmartChatDeps,
    url: string,
    salt: string,
    ext: string,
    timeoutMs: number,
): Promise<string | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const r = await fetch(url, { signal: ctl.signal, headers: VOICE_HTTP_HEADERS });
            if (!r.ok) { clearTimeout(t); continue; }
            const buf = Buffer.from(await r.arrayBuffer());
            clearTimeout(t);
            if (!buf || buf.length < 32) continue;
            const dir = voiceCacheDir(deps);
            const name = `${crypto.createHash('md5').update(url + ':' + salt).digest('hex')}.${ext}`;
            const dest = path.join(dir, name);
            fs.writeFileSync(dest, buf);
            pruneVoiceCache(dir);
            return dest.replace(/\\/g, '/');
        } catch {
            clearTimeout(t);
        }
    }
    return null;
}

/** 从各种可能的返回形状里尽量抠出角色名字符串数组（接口未给 list 示例，做防御式解析） */
export function extractRoleNames(payload: unknown): string[] {
    const out: string[] = [];
    const push = (v: unknown) => {
        const s = String(v ?? '').trim();
        if (s && !out.includes(s)) out.push(s);
    };
    const walk = (node: unknown, depth: number) => {
        if (node == null || depth > 4) return;
        if (typeof node === 'string') { push(node); return; }
        if (Array.isArray(node)) {
            for (const it of node) {
                if (typeof it === 'string') push(it);
                else if (it && typeof it === 'object') {
                    const o = it as Record<string, unknown>;
                    push(o.name ?? o.speaker ?? o.dub ?? o.title ?? o.role ?? o.value);
                } else walk(it, depth + 1);
            }
            return;
        }
        if (typeof node === 'object') {
            const o = node as Record<string, unknown>;
            for (const key of ['data', 'list', 'dubs', 'roles', 'speakers', 'result']) {
                if (o[key] != null) walk(o[key], depth + 1);
            }
        }
    };
    walk(payload, 0);
    return out.slice(0, 1000);
}

/** 拉取第三方角色列表（type=list）。失败抛错，交上层回退到「手填角色名」。 */
export async function fetchVoiceRoles(
    cfg: SmartChatConfig,
    timeoutMs = 20000,
): Promise<{ ok: boolean; roles: string[]; error?: string; using_own_key: boolean }> {
    const key = resolveVoiceKey(cfg);
    const url = buildDubUrl({ type: 'list', key, text: '', dub: '' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { method: 'GET', signal: controller.signal, headers: VOICE_HTTP_HEADERS });
        const text = await resp.text();
        const data = parseJsonLoose(text);
        const code = data ? Number(data.code) : NaN;
        // 该站点成功码约定不统一：200/0 视为成功；否则带回 msg
        if (data && code !== 200 && code !== 0 && code != null && !Number.isNaN(code)) {
            const roles = extractRoleNames(data);
            if (!roles.length) {
                return { ok: false, roles: [], error: String(data.msg || `code ${code}`), using_own_key: isUsingOwnVoiceKey(cfg) };
            }
        }
        const roles = extractRoleNames(data ?? text);
        return { ok: roles.length > 0, roles, error: roles.length ? undefined : '未解析到角色', using_own_key: isUsingOwnVoiceKey(cfg) };
    } catch (e) {
        return { ok: false, roles: [], error: (e as Error)?.message || String(e), using_own_key: isUsingOwnVoiceKey(cfg) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 拉取 QQ 自带 AI 语音角色列表（NapCat get_ai_characters；需要一个参考群号）。
 * 返回按分组整理后的扁平列表 [{ id, name, group }]。
 */
export async function fetchQQVoiceCharacters(
    deps: SmartChatDeps,
    groupId: string | number,
): Promise<{ ok: boolean; characters: Array<{ id: string; name: string; group: string }>; error?: string }> {
    if (!deps?.botApi) return { ok: false, characters: [], error: 'botApi 不可用（宿主未提供 OneBot 动作代理）' };
    const gid = String(groupId || '').trim();
    if (!gid) return { ok: false, characters: [], error: '需要一个参考群号来拉取 QQ AI 角色' };
    try {
        const res: any = await deps.botApi('get_ai_characters', { group_id: Number(gid) || gid, chat_type: 1 });
        // 兼容 { data:[...] } 或直接 [...]
        const groups = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : []);
        const out: Array<{ id: string; name: string; group: string }> = [];
        for (const g of groups) {
            const gname = String(g?.type ?? g?.name ?? '').trim();
            const chars = Array.isArray(g?.characters) ? g.characters : (Array.isArray(g?.list) ? g.list : []);
            for (const c of chars) {
                const id = String(c?.character_id ?? c?.id ?? c?.voice_id ?? c?.value ?? '').trim();
                const nm = String(c?.character_name ?? c?.name ?? c?.title ?? id).trim();
                if (id) out.push({ id, name: nm || id, group: gname });
            }
        }
        return { ok: out.length > 0, characters: out, error: out.length ? undefined : '未解析到 QQ AI 角色' };
    } catch (e) {
        return { ok: false, characters: [], error: (e as Error)?.message || String(e) };
    }
}

// —— 第三方（pearapi）合成 ————————————————————————————————————————————————
async function synthesizeViaPearapi(
    deps: SmartChatDeps,
    cfg: SmartChatConfig,
    clean: string,
    timeoutMs: number,
): Promise<{ ok: boolean; file?: string; error?: string; remote?: boolean }> {
    // 配置归一化已保证 dub 非空（留空时补 DEFAULT_VOICE_DUB）；这里再兜一层，
    // 防止有人绕过 normalizeSmartChatConfig 直接构造 config（如测试代码）导致静默失败。
    const dub = String(cfg?.voice?.dub || '').trim() || DEFAULT_VOICE_DUB;
    const key = resolveVoiceKey(cfg);
    const format = cfg?.voice?.format === 'mp3' ? 'mp3' : 'ogg';
    const url = buildDubUrl({ text: clean, dub, key, type: format });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let audiopath = '';
    try {
        const resp = await fetch(url, { method: 'GET', signal: controller.signal, headers: VOICE_HTTP_HEADERS });
        const body = await resp.text();
        const data = parseJsonLoose(body);
        if (data) {
            const code = Number(data.code);
            audiopath = String(data.audiopath || '').trim();
            if ((code === 200 || code === 0) && audiopath) {
                // ok
            } else if (!audiopath) {
                clearTimeout(timer);
                return { ok: false, error: String(data.msg || `code ${code}`) };
            }
        } else {
            const m = body.match(/https?:\/\/\S+?\.(?:ogg|mp3|wav|amr|silk)/i);
            audiopath = m ? m[0] : '';
            if (!audiopath) { clearTimeout(timer); return { ok: false, error: 'bad_response' }; }
        }
    } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: (e as Error)?.message || String(e) };
    }
    clearTimeout(timer);
    if (!/^https?:\/\//i.test(audiopath)) return { ok: false, error: 'no_audiopath' };

    const ext = guessAudioExt(audiopath, format === 'mp3' ? 'mp3' : 'ogg');
    const local = await downloadAudioToCache(deps, audiopath, clean, ext, timeoutMs);
    if (local) return { ok: true, file: local };
    // 本地下载失败：直接把远端地址给发送层（record 段支持 http URL）
    return { ok: true, file: audiopath, remote: true };
}

// —— QQ 自带 AI 语音（NapCat）————————————————————————————————————————————
async function synthesizeViaQQ(
    deps: SmartChatDeps,
    cfg: SmartChatConfig,
    clean: string,
    timeoutMs: number,
    groupId: string | number | undefined,
): Promise<{ ok: boolean; file?: string; error?: string; remote?: boolean }> {
    if (!deps?.botApi) return { ok: false, error: 'botApi_unavailable' };
    const character = String(cfg?.voice?.qq_character || '').trim();
    if (!character) return { ok: false, error: 'no_qq_character' };
    const gid = String(groupId || '').trim();
    // QQ AI 语音是群功能：私聊无 group_id → 交回文本
    if (!gid) return { ok: false, error: 'qqai_group_only' };
    try {
        const res: any = await deps.botApi('get_ai_record', {
            group_id: Number(gid) || gid,
            character,
            text: clean,
        });
        // 返回可能是字符串（文件路径/URL）或 { data: '...' } / { file: '...' }
        const raw = typeof res === 'string'
            ? res
            : String(res?.data ?? res?.file ?? res?.url ?? res?.audiopath ?? '').trim();
        if (!raw) return { ok: false, error: 'qqai_empty' };
        if (/^https?:\/\//i.test(raw)) {
            const local = await downloadAudioToCache(deps, raw, clean, guessAudioExt(raw, 'silk'), timeoutMs);
            if (local) return { ok: true, file: local };
            return { ok: true, file: raw, remote: true };
        }
        // NapCat 本地生成的文件路径 / file:// → 直接交发送层（段_语音 会解析本地绝对路径）
        return { ok: true, file: raw };
    } catch (e) {
        return { ok: false, error: (e as Error)?.message || String(e) };
    }
}

/**
 * 生成一条语音并（尽量）落到本地文件，返回可直接进 record 段的 file。
 * 按 config.voice.engine 选择引擎；任何环节失败都返回 { ok:false }，调用方回退文本发送。
 * opts.groupId 仅 QQAI 引擎需要（群号）。opts.timeoutMs 控制单次网络限时。
 */
export async function synthesizeVoice(
    deps: SmartChatDeps,
    cfg: SmartChatConfig,
    text: string,
    opts?: { timeoutMs?: number; groupId?: string | number },
): Promise<{ ok: boolean; file?: string; error?: string; remote?: boolean }> {
    const clean = voiceReadyText(text, voiceMaxChars(cfg));
    if (!clean) return { ok: false, error: 'text_not_eligible' };
    const timeoutMs = opts?.timeoutMs || 20000;
    if (resolveVoiceEngine(cfg) === 'qqai') {
        return synthesizeViaQQ(deps, cfg, clean, timeoutMs, opts?.groupId);
    }
    return synthesizeViaPearapi(deps, cfg, clean, timeoutMs);
}
