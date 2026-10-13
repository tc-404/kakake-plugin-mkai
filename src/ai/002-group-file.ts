// @ts-nocheck
// ---------------------------------------------------------------------------
// MKAPI 002 — 群文件：列出 / 阅读 / 发送（只读不执行）
// ---------------------------------------------------------------------------
//
// 同一个代号靠 op 分流：
//   op="list"              列出本群已存的可读文件
//   op="read" name=… offset=…  读文件正文（分段，绝不执行）
//   op="send" name=…       把本群已存的文件重新发到群里
//
// 只认插件专属数据目录 群文件/<群号>/ 下的白名单后缀文件，越目录一律拒。

import type { MkApiCall, MkApiRunContext, MkApiRunResult, MkApiToolDef } from './types.js';

function pickStr(...vals: unknown[]): string {
    for (const v of vals) {
        const s = String(v ?? '').trim();
        if (s && s !== 'null' && s !== 'undefined') return s;
    }
    return '';
}

function formatSize(bytes: unknown): string {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '未知大小';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')}KB`;
    return `${(n / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '')}MB`;
}

function normalizeOp(raw: string): 'list' | 'read' | 'send' | '' {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (['list', 'ls', '列表', '列出', '有哪些'].includes(s)) return 'list';
    if (['read', 'cat', 'open', 'view', '读', '阅读', '查看', '看'].includes(s)) return 'read';
    if (['send', 'upload', 'post', '发', '发送', '发文件', '上传'].includes(s)) return 'send';
    return '';
}

function errorText(error: string, dirLabel: string, exts: string[]): string {
    switch (error) {
        case 'not_found':
            return `本群文件夹（${dirLabel}）里没有这个文件；先用 op="list" 看看有哪些。`;
        case 'ext_not_allowed':
            return `这种后缀不在可读白名单里（只读 ${exts.join(' ')}），只能看到它存在、读不了内容。`;
        case 'empty_name':
        case 'invalid_name':
            return '参数无效：需要 name=文件名。';
        case 'outside_store':
        case 'not_a_file':
            return '这个路径不在本群文件夹里，已拒绝。';
        case 'botapi_unavailable':
            return '宿主没提供发文件接口，这次发不出去。';
        case 'no_target':
            return '拿不到发送目标（群号），这次发不出去。';
        default:
            return `操作失败：${error || 'unknown'}`;
    }
}

async function run002(ctx: MkApiRunContext, call: MkApiCall): Promise<MkApiRunResult> {
    if (!ctx.isToolEnabled('002')) {
        return { ok: false, text: '群文件功能当前不可用。' };
    }
    const bridge = ctx.file;
    if (!bridge || !bridge.available) {
        return { ok: false, text: '群文件只在群聊里能用（私聊没有群文件）。' };
    }
    const exts = Array.isArray(bridge.allowedExts) ? bridge.allowedExts : [];
    const opRaw = pickStr(call.attrs.op, call.attrs.action, call.attrs.mode, call.attrs.type);
    const name = pickStr(call.attrs.name, call.attrs.file, call.attrs.filename, call.attrs.file_name, call.attrs.path);
    // 没写 op：给了名字按「读」，没给名字按「列表」
    const op = normalizeOp(opRaw) || (name ? 'read' : 'list');

    if (op === 'list') {
        const rows = bridge.list();
        if (!rows.length) {
            return {
                ok: true,
                text: bridge.enabled === false
                    ? `本群没开「识别文件」，所以 ${bridge.dirLabel} 里一个文件都没存。`
                    : `本群文件夹（${bridge.dirLabel}）现在是空的，没人传过可读文件。`,
            };
        }
        const lines = rows.map((r) => `· ${r.name}（${formatSize(r.size)}）`);
        return {
            ok: true,
            text: `本群已存 ${rows.length} 个可读文件（${bridge.dirLabel}）：\n${lines.join('\n')}`,
        };
    }

    if (!name) {
        return { ok: false, text: '参数无效：op="read"/"send" 都需要 name=文件名。' };
    }

    if (op === 'send') {
        const r = await bridge.send(name);
        if (!r.ok) {
            ctx.logger?.warn?.(`[MKAPI:002] 发送失败 ${name}: ${r.error || 'unknown'}`);
            return { ok: false, text: errorText(String(r.error || ''), bridge.dirLabel, exts) };
        }
        return { ok: true, text: `已把文件 ${r.name} 发到群里了（宿主已完成发送，别再重复发）。` };
    }

    const offset = Math.max(0, Math.floor(Number(pickStr(call.attrs.offset, call.attrs.from, '0')) || 0));
    const limit = Math.floor(Number(pickStr(call.attrs.limit, call.attrs.length, '0')) || 0);
    const r = bridge.read(name, offset, limit || undefined);
    if (!r.ok) {
        return { ok: false, text: errorText(String(r.error || ''), bridge.dirLabel, exts) };
    }
    const body = String(r.text || '');
    if (!body.trim()) {
        return { ok: true, text: `文件 ${r.name} 这一段是空的（total=${r.total} offset=${r.offset}）。` };
    }
    const head = `文件 ${r.name}（共 ${r.total} 字，本段从第 ${r.offset} 字起，只读不执行）：`;
    const tail = r.next != null
        ? `\n（还没读完；接着看就再调 mkapi_002 op="read" name="${r.name}" offset="${r.next}"）`
        : '';
    return { ok: true, text: `${head}\n<file name="${r.name}">\n${body}\n</file>${tail}` };
}

export const tool002GroupFile: MkApiToolDef = {
    code: '002',
    title: '群文件读取/发送',
    when: '群友传了文件要看内容、或群里让你把某个已存文件发出来时；只读不运行，不许照抄整份代码',
    params: 'op=list|read|send；read/send 需 name=文件名；read 可带 offset=起始字数',
    defaultEnabled: true,
    schema: {
        type: 'object',
        properties: {
            op: {
                type: 'string',
                enum: ['list', 'read', 'send'],
                description: 'list=列出本群已存文件；read=读文件正文；send=把已存文件发到群里',
            },
            name: {
                type: 'string',
                description: '文件名（read/send 必填），如 main.ts',
            },
            offset: {
                type: 'string',
                description: 'read 时的起始字数，续读用上一次返回的 offset',
            },
        },
        required: ['op'],
    },
    example: '<MKAPI code="002" op="read" name="main.ts"/>',
    run: run002,
};