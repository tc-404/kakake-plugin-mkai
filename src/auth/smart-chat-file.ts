// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 群文件（识别文件 / 发文件；NapCat + SnowLuma 协议端兼容）
// ---------------------------------------------------------------------------
//
// 只读不跑：命中白名单后缀的群文件才下载到插件专属数据目录，再以「宿主读取」
// 形态补充进对话缓冲。任何路径下都不执行文件内容（不 import、不 spawn）。
//
// 大小口径：
//   ≤ FILE_CONTENT_MAX_BYTES  → 存盘 + 内容进会话（内联上限 FILE_INLINE_MAX_CHARS）
//   ＞ FILE_CONTENT_MAX_BYTES → 存盘，会话里只登记位置，要看内容让模型调 mkapi_002
//   ＞ FILE_DOWNLOAD_MAX_BYTES / 非白名单后缀 → 不下载，只登记「谁发了什么、多大」

import fs from 'fs';
import path from 'path';
import type { SmartChatBufferEntry, SmartChatDeps } from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';

/** 群文件落盘目录名（插件数据目录 → 智能对话 → 群文件 → 群号/） */
export const SMART_CHAT_FILE_DIR = '群文件';

/** 允许读进上下文的后缀（纯文本读取，绝不执行；后缀大小写不敏感） */
export const FILE_ALLOWED_EXTS = ['.txt', '.mjs', '.js', '.go', '.sh', '.bat', '.ts', '.log'];

/** 超过这个大小只登记位置，不把内容写进会话数据 */
export const FILE_CONTENT_MAX_BYTES = 500 * 1024;

/** 单个文件进会话的内联字符上限；其余让模型用 mkapi_002 分段读 */
export const FILE_INLINE_MAX_CHARS = 8000;

/** mkapi_002 单次 read 返回的字符上限 */
export const FILE_READ_MAX_CHARS = 4000;

/** 下载兜底上限：再大连盘都不落（防磁盘被刷） */
export const FILE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** 单条消息最多处理几个文件 */
export const FILE_PER_MSG_MAX = 3;

/** 下载队列深度（含正在跑的） */
export const FILE_QUEUE_LIMIT = 3;

/** 单次下载墙钟超时 */
export const FILE_DOWNLOAD_TIMEOUT_MS = 120_000;

/** WebUI 列表 / mkapi_002 list 的条数上限 */
export const FILE_LIST_LIMIT = 30;

export interface InboundFileMeta {
    name: string;
    size: number;
    fileId: string;
    busid?: string;
    url?: string;
    /** 协议端直接给了本机路径时可以免下载 */
    localPath?: string;
}

export interface FileJobMeta {
    chatId: string;
    /** 落盘子目录：群号 */
    scopeId: string;
    groupId: string;
    messageId: string;
    file: InboundFileMeta;
    /** 是否把内容内联进会话（≤500KB 才为 true） */
    inline: boolean;
    userId: string;
    nickname: string;
    time: string;
    timeoutMs: number;
    forceFlushAfter: boolean;
    /** true=只把补充写进缓冲，不排程访问（仅@模式下记录但不触发） */
    quiet?: boolean;
    eventSnapshot: Record<string, unknown>;
}

export interface FilePlan {
    /** 是否要在对话文本里登记本条消息的文件 */
    record: boolean;
    /** 登记行（挂在发送者那句后面） */
    placeholderLine: string;
    /** 需要下载 / 读取的任务 */
    jobs: Array<{ file: InboundFileMeta; inline: boolean }>;
    skipReason?: string;
}

export function fileExtOf(name: unknown): string {
    const s = String(name ?? '').trim();
    const m = /\.[A-Za-z0-9_]+$/.exec(s);
    return m ? m[0].toLowerCase() : '';
}

export function isAllowedFileExt(name: unknown): boolean {
    return FILE_ALLOWED_EXTS.includes(fileExtOf(name));
}

export function formatFileSize(bytes: unknown): string {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '未知大小';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')}KB`;
    return `${(n / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '')}MB`;
}

/** 落盘文件名：去目录分隔符/控制符，保留后缀，限长 */
export function sanitizeSavedFileName(name: unknown): string {
    let s = String(name ?? '').trim().replace(/[\\/]+/g, '_');
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
    if (!s) return '';
    if (s.length <= 120) return s;
    const ext = fileExtOf(s);
    return `${s.slice(0, 120 - ext.length)}${ext}`;
}

function pickFileName(d: Record<string, unknown>): string {
    for (const k of ['name', 'file_name', 'fileName', 'file']) {
        const v = String(d?.[k] ?? '').trim();
        // data.file 有时是 file_id，不带后缀就不当名字用
        if (v && (k !== 'file' || /\.[A-Za-z0-9_]+$/.test(v))) return v;
    }
    return '';
}

function pickFileSize(d: Record<string, unknown>): number {
    for (const k of ['size', 'file_size', 'fileSize']) {
        const n = Number(d?.[k]);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return 0;
}

function pickFileId(d: Record<string, unknown>): string {
    for (const k of ['file_id', 'fileId', 'id', 'file']) {
        const v = String(d?.[k] ?? '').trim();
        if (v) return v;
    }
    return '';
}

function pickHttpUrl(d: Record<string, unknown>): string {
    for (const k of ['url', 'file_url', 'fileUrl']) {
        const v = String(d?.[k] ?? '').trim();
        if (/^https?:\/\//i.test(v)) return v;
    }
    return '';
}

function pickLocalPath(d: Record<string, unknown>): string {
    for (const k of ['path', 'file_path', 'local_path']) {
        const v = String(d?.[k] ?? '').trim();
        if (v && !/^https?:\/\//i.test(v)) return v;
    }
    return '';
}

/**
 * 从事件里取群文件：兼容
 *  - notice: group_upload（NapCat 群文件上传通知，event.file）
 *  - message: file 段（部分协议端把群文件当消息段下发）
 */
export function extractInboundFiles(event: Record<string, unknown>): InboundFileMeta[] {
    const out: InboundFileMeta[] = [];
    const seen = new Set<string>();
    const push = (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const d = raw as Record<string, unknown>;
        const name = pickFileName(d);
        const fileId = pickFileId(d);
        if (!name && !fileId) return;
        const key = `${fileId}|${name}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            name: name || fileId,
            size: pickFileSize(d),
            fileId,
            busid: String(d.busid ?? d.bus_id ?? '').trim() || undefined,
            url: pickHttpUrl(d) || undefined,
            localPath: pickLocalPath(d) || undefined,
        });
    };
    push((event as { file?: unknown })?.file);
    const message = (event as { message?: unknown })?.message;
    if (Array.isArray(message)) {
        for (const seg of message) {
            if (!seg || typeof seg !== 'object') continue;
            const type = String((seg as { type?: string }).type || '').toLowerCase();
            if (type !== 'file') continue;
            push((seg as { data?: unknown }).data);
        }
    }
    return out;
}

/** 单文件登记片段：`a.ts(12.3KB)` / `b.zip(3.2MB，未加载)` */
function describeFileForLine(file: InboundFileMeta, loaded: boolean, why: string): string {
    const size = formatFileSize(file.size);
    if (loaded) return `${file.name}(${size})`;
    return `${file.name}(${size}，${why})`;
}

export function buildFilePlaceholderLine(messageId: string, parts: string[]): string {
    const mid = String(messageId || '').trim() || 'unknown';
    if (!parts.length) return '';
    return `${mid} 发了[文件] ${parts.join('、')}`;
}

/**
 * 决定本条消息的文件怎么处理。
 * enabled=false（未开「识别文件」）时一个字都不记。
 */
export function planFileHandling(opts: {
    enabled: boolean;
    files: InboundFileMeta[];
    messageId?: string;
}): FilePlan {
    const empty: FilePlan = { record: false, placeholderLine: '', jobs: [] };
    if (!opts.enabled) return empty;
    const files = (Array.isArray(opts.files) ? opts.files : []).filter((f) => f && f.name);
    if (!files.length) return empty;
    if (files.length > FILE_PER_MSG_MAX) {
        return { ...empty, skipReason: `单条文件数>${FILE_PER_MSG_MAX}，跳过识别` };
    }
    const parts: string[] = [];
    const jobs: Array<{ file: InboundFileMeta; inline: boolean }> = [];
    for (const file of files) {
        if (!isAllowedFileExt(file.name)) {
            parts.push(describeFileForLine(file, false, '类型不支持，未读内容'));
            continue;
        }
        if (file.size > FILE_DOWNLOAD_MAX_BYTES) {
            parts.push(describeFileForLine(file, false, '太大，未保存'));
            continue;
        }
        // 大小未知（协议端没给 size）也先当候选，落盘后按真实字节再判一次
        const inline = !file.size || file.size <= FILE_CONTENT_MAX_BYTES;
        parts.push(describeFileForLine(file, true, ''));
        jobs.push({ file, inline });
    }
    return {
        record: true,
        placeholderLine: buildFilePlaceholderLine(opts.messageId || '', parts),
        jobs,
    };
}

/** 已存盘 + 已读到内容 */
export function buildFileContentSupplement(
    messageId: string,
    name: string,
    rel: string,
    size: number,
    body: string,
    truncatedAt: number,
): string {
    const mid = String(messageId || '').trim() || 'unknown';
    const tail = truncatedAt > 0
        ? `\n（内容较长，只贴了前 ${truncatedAt} 字；要看后面的调 mkapi_002 op="read" name="${name}" offset="${truncatedAt}"）`
        : '';
    return (
        `补充：${mid} 文件 ${name}（${formatFileSize(size)}）已存到 ${rel}\n`
        + `<file name="${name}">\n${body}\n</file>${tail}`
    );
}

/** 已存盘但不进上下文（>500KB） */
export function buildFileLocationSupplement(
    messageId: string,
    name: string,
    rel: string,
    size: number,
): string {
    const mid = String(messageId || '').trim() || 'unknown';
    return (
        `补充：${mid} 文件 ${name}（${formatFileSize(size)}）已存到 ${rel}；`
        + `超过 ${Math.round(FILE_CONTENT_MAX_BYTES / 1024)}KB 没往会话里塞内容，`
        + `要看就调 mkapi_002 op="read" name="${name}"`
    );
}

export function buildFileFailedSupplement(messageId: string, name: string, error: string): string {
    const mid = String(messageId || '').trim() || 'unknown';
    return `补充：${mid} 文件 ${name} 没取到（${String(error || '未知原因').slice(0, 60)}），这轮读不到内容`;
}

/** 是否宿主写的文件补充行 */
export function isFileNoteText(text: string): boolean {
    const t = String(text || '').trim();
    return /^补充：\S*\s*文件\s/.test(t) || /^\[文件\s/.test(t);
}

/**
 * 历史折叠用：把 <file>…</file> 正文压成一句存根，避免旧轮文件正文一直占上下文。
 * 模型要再看就重新调 mkapi_002。
 */
export function compressFileNotesInText(text: string, maxChars = 160): string {
    const raw = String(text || '');
    if (!raw.includes('<file')) return raw;
    const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
    return raw.replace(
        /<file\s+name="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g,
        (_all, name: string, body: string) => {
            const b = String(body || '');
            if (b.length <= cap) return `<file name="${name}">\n${b}\n</file>`;
            const head = cap > 0 ? `${b.slice(0, cap)}…\n` : '';
            return (
                `<file name="${name}" folded="1">\n${head}`
                + `（正文 ${b.length} 字已折叠，要看重新调 mkapi_002 op="read" name="${name}"）\n</file>`
            );
        },
    );
}

/**
 * 模型可见形态：把「补充：<mid> 文件 …」上的「昵称(QQ):」归因去掉，
 * 改成宿主备注，避免模型把文件正文当成群友打的字。
 * foldBodyChars > 0 时同时折叠正文（历史/折叠场景用）。
 */
export function presentFileNotesForModel(text: string, foldBodyChars = 0): string {
    let raw = String(text || '');
    if (foldBodyChars > 0) raw = compressFileNotesInText(raw, foldBodyChars);
    if (!raw.includes('补充：') || !raw.includes('文件')) return raw;
    raw = raw.replace(
        /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[^(\n]+\(\d+\)(?:\s+\[[^\]]+\])*\s*:\s*补充：(\S+)\s*文件\s*/gm,
        (_all, mid: string) => `[文件 msgid:${mid} 宿主读取]: `,
    );
    raw = raw.replace(/^补充：(\S+)\s*文件\s*/gm, (_all, mid: string) => `[文件 msgid:${mid} 宿主读取]: `);
    return raw;
}

// ---------------------------------------------------------------------------
// 本地文件库（插件专属读写目录）
// ---------------------------------------------------------------------------

/** …/智能对话/群文件 */
export function getSmartChatFileRoot(deps: SmartChatDeps): string {
    return path.join(
        deps.getDataPath() || '.',
        ...SMART_CHAT_ROOT.split('/').filter(Boolean),
        SMART_CHAT_FILE_DIR,
    );
}

/** …/智能对话/群文件/<群号> */
export function getSmartChatFileScopeDir(deps: SmartChatDeps, scopeId: string): string {
    const scope = String(scopeId || '').replace(/[^0-9A-Za-z_-]/g, '') || 'unknown';
    return path.join(getSmartChatFileRoot(deps), scope);
}

/** 会话/提示里出现的相对位置，如 群文件/1082631686/a.ts */
export function relFileLabel(scopeId: string, name: string): string {
    return `${SMART_CHAT_FILE_DIR}/${String(scopeId || 'unknown')}/${name}`;
}

/** A③ 单次 spill 落盘上限：再大就截断（防上游巨响应把磁盘写爆） */
export const SPILL_MAX_BYTES = 2 * 1024 * 1024;

export interface SpillResult {
    ok: boolean;
    name?: string;
    rel?: string;
    abs?: string;
    bytes?: number;
    /** 命中上限、内容被截断 */
    truncated?: boolean;
    error?: string;
}

/**
 * A③ 有界输出 + spill：把超长内容（网页正文、搜索结果、工具输出）落盘到**本群文件目录**，
 * 并交给调用方一句取回指引。
 *
 * 为什么复用群文件目录：模型已经有 `mkapi_002 op="list"/"read"` 这条读取路径
 * （`resolveSavedFile` 只认本 scope 下的白名单后缀）。这里不新增工具、不加新协议，
 * 只是把「截断丢弃」换成「落盘 + 告诉它怎么读回来」。
 *
 * 私聊没有群文件 scope 时调用方不该调它（scopeId 必须是非空群号）。
 */
export function spillTextToScope(
    deps: SmartChatDeps,
    scopeId: string,
    suggestedName: string,
    text: string,
): SpillResult {
    const raw = String(text ?? '');
    if (!raw) return { ok: false, error: 'empty' };
    const scope = String(scopeId || '').trim();
    if (!scope) return { ok: false, error: 'no_scope' };

    const base = sanitizeSavedFileName(suggestedName || 'spill.txt') || 'spill.txt';
    // 强制 .txt：既在 FILE_ALLOWED_EXTS 里，又保证 mkapi_002 按文本读
    const stem = base.replace(/\.[^.\/\\]*$/, '') || 'spill';
    const name = `${stem}.txt`;

    let body = raw;
    let truncated = false;
    if (Buffer.byteLength(body, 'utf8') > SPILL_MAX_BYTES) {
        // 按字节裁到上限内（不切断多字节字符：先按字节切再修正尾部）
        let cut = body.slice(0, SPILL_MAX_BYTES);
        while (Buffer.byteLength(cut, 'utf8') > SPILL_MAX_BYTES) cut = cut.slice(0, -1);
        body = `${cut}\n…[spill truncated at ${SPILL_MAX_BYTES} bytes]…\n`;
        truncated = true;
    }

    const dir = getSmartChatFileScopeDir(deps, scope);
    ensureDirSync(dir);
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, body, 'utf8');
    return {
        ok: true,
        name,
        rel: relFileLabel(scope, name),
        abs,
        bytes: Buffer.byteLength(body, 'utf8'),
        truncated,
    };
}

/**
 * 给模型看的取回指引（单行、短、可直接照做）。
 * 措辞必须和 mkapi_002 的真实参数对齐，否则落盘等于白存。
 */
export function buildSpillHint(
    spill: SpillResult,
    opts?: { kind?: string; omittedChars?: number },
): string {
    if (!spill?.ok || !spill.rel) return '';
    const kind = String(opts?.kind || '内容');
    const omitted = Number(opts?.omittedChars) || 0;
    return `[宿主] 这段${kind}太长（省略了约 ${omitted} 字），`
        + `完整原文已存到本群文件夹 ${spill.rel}`
        + `（${Math.round((spill.bytes || 0) / 1024)}KB${spill.truncated ? '，已按上限截断' : ''}）。`
        + `要接着看就调 mkapi_002 op="read" name="${spill.name}"（读不完用返回的 offset 续读）；`
        + `不确定文件名就先 op="list"。`;
}

/** A③ 超过这个长度才值得落盘（短内容直接给，避免为几百字写文件） */
export const SPILL_THRESHOLD_CHARS = 3000;
/** 落盘后仍直接给模型看的头部长度 */
export const SPILL_INLINE_HEAD_CHARS = 1500;

function ensureDirSync(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function listSavedFiles(
    deps: SmartChatDeps,
    scopeId: string,
    limit = FILE_LIST_LIMIT,
): Array<{ name: string; rel: string; size: number; mtime: number }> {
    const dir = getSmartChatFileScopeDir(deps, scopeId);
    if (!fs.existsSync(dir)) return [];
    const rows: Array<{ name: string; rel: string; size: number; mtime: number }> = [];
    try {
        for (const name of fs.readdirSync(dir)) {
            try {
                const st = fs.statSync(path.join(dir, name));
                if (!st.isFile()) continue;
                rows.push({
                    name,
                    rel: relFileLabel(scopeId, name),
                    size: st.size,
                    mtime: st.mtimeMs,
                });
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows.slice(0, Math.max(1, Number(limit) || FILE_LIST_LIMIT));
}

/**
 * 名字 → 绝对路径。只认本 scope 目录下的普通文件：
 * 越目录（..）、绝对路径、软链一律拒（模型给什么都不许跑出这个文件夹）。
 */
export function resolveSavedFile(
    deps: SmartChatDeps,
    scopeId: string,
    nameOrRel: string,
): { ok: boolean; abs?: string; rel?: string; name?: string; size?: number; error?: string } {
    const raw = String(nameOrRel || '').trim().replace(/\\/g, '/');
    if (!raw) return { ok: false, error: 'empty_name' };
    // 容忍模型把 群文件/群号/a.ts 整条贴过来
    const base = sanitizeSavedFileName(raw.split('/').filter(Boolean).pop() || '');
    if (!base) return { ok: false, error: 'invalid_name' };
    if (!isAllowedFileExt(base)) return { ok: false, error: 'ext_not_allowed' };
    const dir = getSmartChatFileScopeDir(deps, scopeId);
    let abs = path.join(dir, base);
    if (!fs.existsSync(abs)) {
        // 大小写/同名兜底：目录内不区分大小写找一次
        const hit = listSavedFiles(deps, scopeId, 200)
            .find((r) => r.name.toLowerCase() === base.toLowerCase());
        if (!hit) return { ok: false, error: 'not_found' };
        abs = path.join(dir, hit.name);
    }
    let real = abs;
    try {
        real = fs.realpathSync(abs);
    } catch {
        return { ok: false, error: 'not_found' };
    }
    const realDir = (() => {
        try {
            return fs.realpathSync(dir);
        } catch {
            return dir;
        }
    })();
    if (!real.startsWith(realDir + path.sep)) return { ok: false, error: 'outside_store' };
    let st: fs.Stats;
    try {
        st = fs.statSync(real);
    } catch {
        return { ok: false, error: 'not_found' };
    }
    if (!st.isFile()) return { ok: false, error: 'not_a_file' };
    const name = path.basename(real);
    return { ok: true, abs: real, rel: relFileLabel(scopeId, name), name, size: st.size };
}

/** 只读文本：绝不 import / exec，纯 fs 读字节按 UTF-8 解 */
export function readSavedFileText(
    deps: SmartChatDeps,
    scopeId: string,
    nameOrRel: string,
    offset = 0,
    limit = FILE_READ_MAX_CHARS,
): {
    ok: boolean;
    name?: string;
    rel?: string;
    text?: string;
    total?: number;
    offset?: number;
    next?: number | null;
    error?: string;
} {
    const found = resolveSavedFile(deps, scopeId, nameOrRel);
    if (!found.ok) return { ok: false, error: found.error };
    let full = '';
    try {
        full = fs.readFileSync(found.abs, 'utf8');
    } catch (e) {
        return { ok: false, error: `read_failed: ${(e as Error)?.message || e}` };
    }
    const total = full.length;
    const from = Math.max(0, Math.min(total, Math.floor(Number(offset) || 0)));
    // 硬上限按内联口径（8000）：内联补充要 8KB，工具单次读默认仍是 FILE_READ_MAX_CHARS
    const cap = Math.max(200, Math.min(FILE_INLINE_MAX_CHARS, Math.floor(Number(limit) || FILE_READ_MAX_CHARS)));
    const text = full.slice(from, from + cap);
    const end = from + text.length;
    return {
        ok: true,
        name: found.name,
        rel: found.rel,
        text,
        total,
        offset: from,
        next: end < total ? end : null,
    };
}

// ---------------------------------------------------------------------------
// 下载（拿下载直链 → 落盘）
// ---------------------------------------------------------------------------

function apiPayload(raw: unknown): Record<string, unknown> | null {
    if (raw == null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.status === 'failed') return null;
    if (o.retcode != null && Number(o.retcode) !== 0) return null;
    if (o.data != null && typeof o.data === 'object') return o.data as Record<string, unknown>;
    return o;
}

/** 依次试：事件自带直链 → 协议端本机路径 → get_group_file_url → get_file */
export async function resolveFileSource(
    deps: SmartChatDeps,
    file: InboundFileMeta,
    groupId: string,
): Promise<{ url?: string; localPath?: string; error?: string }> {
    if (file.localPath && fs.existsSync(file.localPath)) return { localPath: file.localPath };
    if (file.url) return { url: file.url };
    if (typeof deps.botApi !== 'function' || !file.fileId) return { error: 'no_download_url' };
    const gid = /^\d+$/.test(String(groupId)) ? Number(groupId) : groupId;
    const attempts: Array<{ action: string; params: Record<string, unknown> }> = [
        { action: 'get_group_file_url', params: { group_id: gid, file_id: file.fileId, ...(file.busid ? { busid: Number(file.busid) || file.busid } : {}) } },
        { action: 'get_file', params: { file_id: file.fileId } },
    ];
    for (const a of attempts) {
        try {
            const data = apiPayload(await deps.botApi(a.action, a.params));
            if (!data) continue;
            const url = pickHttpUrl(data);
            if (url) return { url };
            const local = pickLocalPath(data) || String(data.file ?? '').trim();
            if (local && !/^https?:\/\//i.test(local) && fs.existsSync(local)) {
                return { localPath: local };
            }
        } catch (e) {
            deps.logger?.warn?.(`[智能对话·文件] ${a.action} 失败: ${(e as Error)?.message || e}`);
        }
    }
    return { error: 'no_download_url' };
}

async function fetchToFile(
    url: string,
    dest: string,
    timeoutMs: number,
    maxBytes: number,
): Promise<{ ok: boolean; size?: number; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || FILE_DOWNLOAD_TIMEOUT_MS));
    try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
        const declared = Number(resp.headers?.get?.('content-length') || 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
            return { ok: false, error: 'too_large' };
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.byteLength > maxBytes) return { ok: false, error: 'too_large' };
        ensureDirSync(path.dirname(dest));
        fs.writeFileSync(dest, buf);
        return { ok: true, size: buf.byteLength };
    } catch (e) {
        const name = e && typeof e === 'object' ? String((e as { name?: string }).name || '') : '';
        if (name === 'AbortError') return { ok: false, error: 'timeout' };
        return { ok: false, error: (e as Error)?.message || 'download_failed' };
    } finally {
        clearTimeout(timer);
    }
}

/** 落盘：同名已存在且大小一致就直接复用 */
export async function saveInboundFile(
    deps: SmartChatDeps,
    job: FileJobMeta,
): Promise<{ ok: boolean; abs?: string; rel?: string; name?: string; size?: number; error?: string }> {
    const name = sanitizeSavedFileName(job.file.name);
    if (!name) return { ok: false, error: 'invalid_name' };
    if (!isAllowedFileExt(name)) return { ok: false, error: 'ext_not_allowed' };
    const dir = getSmartChatFileScopeDir(deps, job.scopeId);
    ensureDirSync(dir);
    const dest = path.join(dir, name);
    try {
        if (fs.existsSync(dest)) {
            const st = fs.statSync(dest);
            if (st.isFile() && (!job.file.size || st.size === job.file.size)) {
                return { ok: true, abs: dest, rel: relFileLabel(job.scopeId, name), name, size: st.size };
            }
        }
    } catch { /* ignore */ }
    const src = await resolveFileSource(deps, job.file, job.groupId);
    if (src.localPath) {
        try {
            const st = fs.statSync(src.localPath);
            if (st.size > FILE_DOWNLOAD_MAX_BYTES) return { ok: false, error: 'too_large' };
            fs.copyFileSync(src.localPath, dest);
            return { ok: true, abs: dest, rel: relFileLabel(job.scopeId, name), name, size: st.size };
        } catch (e) {
            return { ok: false, error: `copy_failed: ${(e as Error)?.message || e}` };
        }
    }
    if (!src.url) return { ok: false, error: src.error || 'no_download_url' };
    const dl = await fetchToFile(src.url, dest, job.timeoutMs, FILE_DOWNLOAD_MAX_BYTES);
    if (!dl.ok) return { ok: false, error: dl.error };
    return { ok: true, abs: dest, rel: relFileLabel(job.scopeId, name), name, size: dl.size || 0 };
}

// ---------------------------------------------------------------------------
// 异步队列：先登记占位，落盘/读完后以「补充：」再入缓冲
// ---------------------------------------------------------------------------

let fileSupplementHandler: ((entry: SmartChatBufferEntry) => void) | null = null;
let fileLogger: SmartChatDeps['logger'] | null = null;
let fileDeps: SmartChatDeps | null = null;

const fileQueue: FileJobMeta[] = [];
let fileRunning = 0;

export function bindSmartChatFileRuntime(
    deps: SmartChatDeps,
    onSupplement: (entry: SmartChatBufferEntry) => void,
    logger?: SmartChatDeps['logger'],
): void {
    fileDeps = deps;
    fileSupplementHandler = onSupplement;
    fileLogger = logger || deps?.logger || null;
}

export function getFileQueueDepth(): number {
    return fileQueue.length + fileRunning;
}

function pumpFileQueue(): void {
    while (fileRunning < 1 && fileQueue.length) {
        const job = fileQueue.shift();
        if (!job) break;
        fileRunning += 1;
        void runFileJob(job).finally(() => {
            fileRunning = Math.max(0, fileRunning - 1);
            pumpFileQueue();
        });
    }
}

async function runFileJob(job: FileJobMeta): Promise<void> {
    const deps = fileDeps;
    if (!deps) return;
    fileLogger?.info?.(
        `[智能对话·文件] ${job.chatId} msgid=${job.messageId} ${job.file.name} `
        + `${formatFileSize(job.file.size)} inline=${job.inline ? 1 : 0}`,
    );
    const saved = await saveInboundFile(deps, job);
    let text: string;
    if (!saved.ok) {
        text = buildFileFailedSupplement(job.messageId, job.file.name, saved.error || 'unknown');
        fileLogger?.warn?.(
            `[智能对话·文件] 保存失败 ${job.file.name}: ${saved.error || 'unknown'}`,
        );
    } else {
        const size = saved.size || job.file.size || 0;
        const inline = job.inline && size <= FILE_CONTENT_MAX_BYTES;
        if (!inline) {
            text = buildFileLocationSupplement(job.messageId, saved.name, saved.rel, size);
        } else {
            const read = readSavedFileText(deps, job.scopeId, saved.name, 0, FILE_INLINE_MAX_CHARS);
            if (!read.ok) {
                text = buildFileFailedSupplement(job.messageId, saved.name, read.error || 'read_failed');
            } else {
                const truncatedAt = read.next ? Number(read.next) : 0;
                text = buildFileContentSupplement(
                    job.messageId,
                    saved.name,
                    saved.rel,
                    size,
                    read.text || '',
                    truncatedAt,
                );
            }
        }
    }
    const entry: SmartChatBufferEntry = {
        userId: job.userId,
        nickname: job.nickname || job.userId,
        text,
        time: job.time,
        messageId: job.messageId,
        eventSnapshot: job.eventSnapshot,
        forceFlush: Boolean(job.forceFlushAfter),
        quiet: Boolean(job.quiet) || undefined,
    };
    try {
        fileSupplementHandler?.(entry);
    } catch (e) {
        fileLogger?.warn?.('[智能对话·文件] 补充入队失败:', (e as Error)?.message || e);
    }
}

export function enqueueFileJobs(jobs: FileJobMeta[]): number {
    if (!Array.isArray(jobs) || !jobs.length) return 0;
    let n = 0;
    for (const job of jobs) {
        if (getFileQueueDepth() >= FILE_QUEUE_LIMIT) {
            fileLogger?.warn?.(`[智能对话·文件] 队列已满(${FILE_QUEUE_LIMIT})，丢弃 ${job.file?.name || '?'}`);
            continue;
        }
        fileQueue.push(job);
        n += 1;
        pumpFileQueue();
    }
    return n;
}

// ---------------------------------------------------------------------------
// 发文件（NapCat / SnowLuma 兼容：先走 upload_*_file，失败再退 file 消息段）
// ---------------------------------------------------------------------------

export interface FileChatTarget {
    chatType: 'group' | 'private';
    groupId?: string;
    userId?: string;
}

function numOrRaw(v: unknown): unknown {
    const s = String(v ?? '').trim();
    return /^\d+$/.test(s) ? Number(s) : s;
}

function callFailed(raw: unknown): boolean {
    if (raw == null) return false; // 有协议端成功后什么都不回
    if (typeof raw !== 'object') return false;
    const o = raw as Record<string, unknown>;
    if (o.status === 'failed') return true;
    if (o.retcode != null && Number(o.retcode) !== 0) return true;
    return false;
}

/** 把已存盘的文件发到当前会话；返回实际生效的接口名 */
export async function sendSavedFile(
    deps: SmartChatDeps,
    target: FileChatTarget,
    nameOrRel: string,
    scopeId: string,
): Promise<{ ok: boolean; via?: string; name?: string; error?: string }> {
    if (typeof deps.botApi !== 'function') return { ok: false, error: 'botapi_unavailable' };
    const found = resolveSavedFile(deps, scopeId, nameOrRel);
    if (!found.ok) return { ok: false, error: found.error };
    const abs = found.abs as string;
    const name = found.name as string;
    // 这里走的是 upload_*_file / send_*_msg 的**专用文件接口**，它们的 file 参数
    // 语义与消息段（record/image）不同：NapCat 会直接读盘，因此传裸绝对路径是对的。
    // 注意不要把它和 record 段混为一谈 —— record 段不收本地路径（必须 base64://），
    // 详见 src/lib/bot.ts 的 媒体路径()。正斜杠统一是为了避开 JSON 反转义咬反斜杠。
    const filePath = abs.replace(/\\/g, '/');
    const seg = (file: string) => [{ type: 'file', data: { file, name } }];
    const attempts: Array<{ action: string; params: Record<string, unknown> }> = [];
    if (target.chatType === 'group' && target.groupId) {
        const gid = numOrRaw(target.groupId);
        attempts.push({ action: 'upload_group_file', params: { group_id: gid, file: filePath, name } });
        attempts.push({ action: 'send_group_msg', params: { group_id: gid, message: seg(filePath) } });
        attempts.push({ action: 'send_msg', params: { message_type: 'group', group_id: gid, message: seg(filePath) } });
    } else if (target.userId) {
        const uid = numOrRaw(target.userId);
        attempts.push({ action: 'upload_private_file', params: { user_id: uid, file: filePath, name } });
        attempts.push({ action: 'send_private_msg', params: { user_id: uid, message: seg(filePath) } });
        attempts.push({ action: 'send_msg', params: { message_type: 'private', user_id: uid, message: seg(filePath) } });
    } else {
        return { ok: false, error: 'no_target' };
    }
    let lastError = '';
    for (const a of attempts) {
        try {
            const raw = await deps.botApi(a.action, a.params);
            if (callFailed(raw)) {
                const o = (raw || {}) as Record<string, unknown>;
                lastError = String(o.wording || o.message || o.msg || `retcode=${o.retcode}`);
                deps.logger?.warn?.(`[智能对话·文件] ${a.action} 发送失败: ${lastError}`);
                continue;
            }
            deps.logger?.info?.(`[智能对话·文件] 已发送 ${name} via ${a.action}`);
            return { ok: true, via: a.action, name };
        } catch (e) {
            lastError = (e as Error)?.message || String(e);
            deps.logger?.warn?.(`[智能对话·文件] ${a.action} 异常: ${lastError}`);
        }
    }
    return { ok: false, error: lastError || 'send_failed' };
}

/** 给 MKAPI 002 用的桥：只暴露「列/读/发」，且锁死在本会话的文件夹里 */
export function buildMkApiFileBridge(
    deps: SmartChatDeps,
    opts: { scopeId: string; target: FileChatTarget; enabled?: boolean },
) {
    const scopeId = String(opts.scopeId || '').trim();
    return {
        scopeId,
        available: Boolean(scopeId),
        enabled: opts.enabled !== false,
        dirLabel: `${SMART_CHAT_FILE_DIR}/${scopeId || 'unknown'}`,
        allowedExts: [...FILE_ALLOWED_EXTS],
        list: (limit?: number) => listSavedFiles(deps, scopeId, limit || FILE_LIST_LIMIT),
        read: (name: string, offset?: number, limit?: number) =>
            readSavedFileText(deps, scopeId, name, offset || 0, limit || FILE_READ_MAX_CHARS),
        send: (name: string) => sendSavedFile(deps, opts.target, name, scopeId),
    };
}