// @ts-nocheck
// ---------------------------------------------------------------------------
// MKAPI 001 — 查 QQ 群聊详细信息（get_group_detail_info）
// ---------------------------------------------------------------------------

import type { MkApiCall, MkApiRunContext, MkApiRunResult, MkApiToolDef } from './types.js';

function extractPayload(raw: unknown): Record<string, unknown> | null {
    if (raw == null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.data != null && typeof o.data === 'object') {
        // failed with data:null
        if (o.status === 'failed' || (o.retcode != null && Number(o.retcode) !== 0 && o.data === null)) {
            return null;
        }
        return o.data as Record<string, unknown>;
    }
    if (o.status === 'failed') return null;
    return o;
}

function pickStr(...vals: unknown[]): string {
    for (const v of vals) {
        const s = String(v ?? '').trim();
        if (s && s !== '0' && s !== 'null' && s !== 'undefined') return s;
    }
    return '';
}

function decodeHtmlEntities(s: string): string {
    return String(s || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function formatCreateTime(ts: unknown): string {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n > 1e12 ? n : n * 1000;
    try {
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return '';
        const p = (x: number) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch {
        return '';
    }
}

function collectTags(data: Record<string, unknown>): string {
    const tags: string[] = [];
    const classText = pickStr(data.groupClassText, data.group_class_text);
    if (classText) tags.push(classText);
    const rec = data.tagRecord ?? data.tag_record;
    if (Array.isArray(rec)) {
        for (const row of rec) {
            if (!row || typeof row !== 'object') continue;
            const v = pickStr((row as Record<string, unknown>).tagValue, (row as Record<string, unknown>).tag_value);
            if (v && !tags.includes(v)) tags.push(v);
        }
    }
    return tags.join('、');
}

function notFoundResult(groupId: string): MkApiRunResult {
    return {
        ok: false,
        text: `查无此群（群号 ${groupId || '未知'}）或无权查看。`,
    };
}

async function run001(ctx: MkApiRunContext, call: MkApiCall): Promise<MkApiRunResult> {
    const groupId = pickStr(call.attrs.group_id, call.attrs.groupId, call.attrs.id);
    if (!groupId || !/^\d{5,12}$/.test(groupId)) {
        return { ok: false, text: '参数无效：需要合法群号数字（group_id）。' };
    }
    if (!ctx.isToolEnabled('001')) {
        return notFoundResult(groupId);
    }
    if (typeof ctx.botApi !== 'function') {
        return { ok: false, text: '宿主未提供 botApi，无法查询群信息。' };
    }
    let raw: unknown;
    try {
        raw = await ctx.botApi('get_group_detail_info', {
            group_id: /^\d+$/.test(groupId) ? Number(groupId) : groupId,
        });
    } catch (e) {
        ctx.logger?.warn?.('[MKAPI:001] get_group_detail_info 异常:', (e as Error)?.message || e);
        return notFoundResult(groupId);
    }
    const data = extractPayload(raw);
    if (!data) return notFoundResult(groupId);

    const lines: string[] = [];
    const gid = pickStr(data.group_id, data.groupCode, data.groupUin, groupId);
    const gname = pickStr(data.group_name, data.groupName);
    const owner = pickStr(data.ownerUin, data.owner_uin, data.owner);
    const member = pickStr(data.member_count, data.memberNum, data.member_num);
    const maxMember = pickStr(data.max_member_count, data.maxMemberNum, data.max_member_num);
    const created = formatCreateTime(data.groupCreateTime ?? data.group_create_time ?? data.create_time);
    const intro = decodeHtmlEntities(
        pickStr(data.richFingerMemo, data.fingerMemo, data.group_memo, data.introduction),
    ).slice(0, 800);
    const tags = collectTags(data);

    if (gid) lines.push(`群号：${gid}`);
    if (gname) lines.push(`群名：${gname}`);
    if (owner) lines.push(`群主：${owner}`);
    if (created) lines.push(`创群时间：${created}`);
    if (member || maxMember) {
        lines.push(`群人数：${member || '?'} / ${maxMember || '?'}`);
    }
    if (intro) lines.push(`群介绍：${intro}`);
    if (tags) lines.push(`群标签：${tags}`);

    if (!lines.length) return notFoundResult(groupId);
    return { ok: true, text: lines.join('\n') };
}

export const tool001GroupDetail: MkApiToolDef = {
    code: '001',
    title: '查QQ群聊信息',
    when: '需要查询某个 QQ 群的群名、群主、人数、介绍、是否存在等（有群号时）；不要用网页搜索代替',
    params: 'group_id=群号数字',
    defaultEnabled: true,
    run: run001,
};
