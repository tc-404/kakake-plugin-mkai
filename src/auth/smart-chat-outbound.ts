// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 出站动作辅助（解析 / 落盘 / 发送）
// ---------------------------------------------------------------------------

import type { SmartChatBufferEntry, SmartChatDeps } from './smart-chat-types';
import { resolveStickerAbsolutePath } from './smart-chat-sticker';
import { nextReplyGapMs, parseAssistantActions, sleep } from './smart-chat-reply';

export function extractApiPayload(raw: unknown): Record<string, unknown> | null {
    if (raw == null || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.data != null && typeof o.data === 'object' && (o.retcode != null || o.status != null)) {
        return o.data as Record<string, unknown>;
    }
    return o;
}

/** 从本批事件解析会话顶层群号/群名；群名缺失时可调 get_group_info 补一次 */
export async function resolveSessionChatMeta(
    deps: SmartChatDeps,
    batch: SmartChatBufferEntry[],
    existing?: { group_id?: string; group_name?: string; chat_type?: string },
): Promise<{ chat_type: 'group' | 'private'; group_id?: string; group_name?: string }> {
    const snap = batch[batch.length - 1]?.eventSnapshot || {};
    const isGroup = String(snap.message_type || '') === 'group' || Boolean(snap.group_id);
    if (!isGroup) {
        return { chat_type: 'private' };
    }
    const group_id = String(snap.group_id || existing?.group_id || '').trim();
    let group_name = String(snap.group_name || '').trim();
    if (!group_name) group_name = String(existing?.group_name || '').trim();
    if (!group_name && group_id && typeof deps.botApi === 'function') {
        try {
            const raw = await deps.botApi('get_group_info', {
                group_id: /^\d+$/.test(group_id) ? Number(group_id) : group_id,
            });
            const data = extractApiPayload(raw);
            group_name = String(data?.group_name || data?.groupName || '').trim();
        } catch (e) {
            deps.logger?.warn?.('[智能对话] 获取群名失败:', (e as Error)?.message || e);
        }
    }
    return {
        chat_type: 'group',
        ...(group_id ? { group_id } : {}),
        ...(group_name ? { group_name } : {}),
    };
}

export function rebuildEventFromSnapshot(snap: Record<string, unknown>): Record<string, unknown> {
    return { ...snap };
}

export async function executeAssistantActions(
    deps: SmartChatDeps,
    ev: Record<string, unknown>,
    actions: Array<{
        type: string;
        text?: string;
        at?: string | string[];
        replyId?: string;
        emojiId?: string;
        messageId?: string;
        sticker?: string;
        voiceFile?: string;
    }>,
    replyGapMs: number,
    opts?: { stickerOutput?: boolean },
): Promise<void> {
    const isGroup = ev.message_type === 'group';
    const stickerOn = Boolean(opts?.stickerOutput);
    const runnable = (actions || []).filter((a) => a.type === 'react' || a.type === 'msg');
    for (let i = 0; i < runnable.length; i++) {
        const a = runnable[i];
        if (a.type === 'react') {
            if (isGroup && a.emojiId && a.messageId && typeof deps.设消息表情 === 'function') {
                try {
                    await deps.设消息表情(a.messageId, a.emojiId);
                } catch (e) {
                    deps.logger?.warn?.('[智能对话] 贴表情失败:', e?.message || e);
                }
            }
        } else if (a.type === 'msg') {
            // 语音气泡：单节点发送，不带艾特/引用/文字混排；发送失败则回退文本
            if (a.voiceFile && typeof deps.段_语音 === 'function') {
                try {
                    await deps.发消息(ev, [deps.段_语音(a.voiceFile)]);
                } catch (e) {
                    deps.logger?.warn?.('[智能对话] 语音发送失败，回退文本:', e?.message || e);
                    const t = String(a.text || '').trim();
                    if (t) {
                        try { await deps.发消息(ev, [deps.段_文本(t)]); } catch { /* ignore */ }
                    }
                }
                if (i < runnable.length - 1) {
                    await sleep(nextReplyGapMs(replyGapMs));
                }
                continue;
            }
            const segs = [];
            if (a.replyId && typeof deps.段_引用 === 'function') {
                const r = deps.段_引用(a.replyId);
                if (r) segs.push(r);
            }
            if (typeof deps.段_艾特 === 'function') {
                const ats = Array.isArray(a.at) ? a.at : (a.at ? [a.at] : []);
                for (const qq of ats) {
                    const at = deps.段_艾特(String(qq));
                    if (at) segs.push(at);
                }
            }
            let sentImage = false;
            if (stickerOn && a.sticker && typeof deps.段_图片 === 'function') {
                const resolved = resolveStickerAbsolutePath(deps, a.sticker);
                if (resolved.ok) {
                    segs.push(deps.段_图片(resolved.abs));
                    sentImage = true;
                } else {
                    deps.logger?.warn?.(
                        `[智能对话] 表情包路径无效: ${a.sticker} (${resolved.error})`,
                    );
                }
            }
            const text = String(a.text || '').trim();
            if (text && !sentImage) {
                segs.push(deps.段_文本(text));
            } else if (text && sentImage) {
                // 表情气泡不附带路径原文
            } else if (!sentImage && !text) {
                continue;
            }
            if (!segs.length) continue;
            await deps.发消息(ev, segs);
        }
        if (i < runnable.length - 1) {
            await sleep(nextReplyGapMs(replyGapMs));
        }
    }
}

/** 本批是否艾特了机器人 */
export function batchAtsBot(batch: SmartChatBufferEntry[], selfId: unknown): boolean {
    const sid = String(selfId ?? '').trim();
    if (!sid) return false;
    return batch.some((b) => (b.atQqs || []).some((q) => String(q).trim() === sid));
}

/** 是否有可对用户说的内容（文字或表情包；排除占位省略号） */
export function hasRealTextMsg(
    actions: Array<{ type: string; text?: string; sticker?: string }>,
): boolean {
    return actions.some((a) => {
        if (a.type !== 'msg') return false;
        if (String(a.sticker || '').trim()) return true;
        const t = String(a.text || '').trim();
        return t && t !== '……' && t !== '...';
    });
}

/** 把最终动作列表写成会话里的 assistant 内容（与真实出站一致） */
export function actionsToAssistantStoreContent(
    actions: Array<{ type: string; text?: string; sticker?: string; emojiId?: string; messageId?: string; voiceWanted?: boolean }>,
    shutUp: boolean,
): string {
    if (shutUp && !hasRealTextMsg(actions)) {
        const reacts = actions.filter((a) => a.type === 'react');
        if (!reacts.length) return '<shut_up/>';
        return `<replies>\n${reacts.map((a) => {
            const to = a.messageId ? ` to="${a.messageId}"` : ' to="last"';
            return `<react emoji="${a.emojiId || '76'}"${to}/>`;
        }).join('\n')}\n</replies>`;
    }
    const parts = actions
        .filter((a) => a.type === 'msg' || a.type === 'react')
        .map((a) => {
            if (a.type === 'react') {
                const to = a.messageId ? ` to="${a.messageId}"` : ' to="last"';
                return `<react emoji="${a.emojiId || '76'}"${to}/>`;
            }
            if (a.sticker) return `<sticker>${a.sticker}</sticker>`;
            // 语音气泡在历史里保留 <voice> 记号：让模型看到自己「刚用语音说了这句」
            if (a.voiceWanted) return `<voice>${a.text || ''}</voice>`;
            return `<msg>${a.text || ''}</msg>`;
        });
    if (!parts.length) return '<shut_up/>';
    return `<replies>\n${parts.join('\n')}\n</replies>`;
}

/** 工具通道排队的表情包写入会话（插在 replies 末尾，字在前图在后） */
export function mergeToolStickersIntoStore(storeContent: string, rels: string[]): string {
    const uniq = [...new Set((rels || []).map((r) => String(r || '').trim()).filter(Boolean))];
    if (!uniq.length) return storeContent;
    const tags = uniq.map((r) => `<sticker>${r}</sticker>`).join('\n');
    const raw = String(storeContent || '').trim();
    if (!raw || raw === '<shut_up/>') {
        return `<replies>\n${tags}\n</replies>`;
    }
    if (/<\/replies>/i.test(raw)) {
        return raw.replace(/<\/replies>/i, `${tags}\n</replies>`);
    }
    if (/<replies\b/i.test(raw)) {
        return `${raw}\n${tags}\n</replies>`;
    }
    return `<replies>\n${raw}\n${tags}\n</replies>`;
}

/** 最终出站：文字/react 在前，排队表情包在后 */
export function appendQueuedStickers(
    actions: Array<{ type: string; text?: string; sticker?: string; at?: string | string[]; replyId?: string; emojiId?: string; messageId?: string }>,
    rels: string[],
): typeof actions {
    const list = Array.isArray(actions) ? [...actions] : [];
    const have = new Set(
        list
            .filter((a) => a.type === 'msg' && String(a.sticker || '').trim())
            .map((a) => String(a.sticker).trim()),
    );
    for (const rel of rels || []) {
        const r = String(rel || '').trim();
        if (!r || have.has(r)) continue;
        have.add(r);
        list.push({ type: 'msg', text: '', sticker: r });
    }
    return list;
}

export function parseOutboundActions(
    content: string,
    batch: SmartChatBufferEntry[],
    isGroup: boolean,
    logger?: { warn?: (...args: unknown[]) => void },
) {
    let parsed = parseAssistantActions(content, batch, {
        onAtDropped: (raw) => {
            logger?.warn?.(`[智能对话] at= 无效已丢弃: ${raw}`);
        },
    });
    if (!isGroup) {
        parsed = parsed.filter((a) => a.type !== 'react');
    } else {
        parsed = parsed.filter((a) => a.type !== 'react' || a.messageId);
    }
    return parsed;
}
