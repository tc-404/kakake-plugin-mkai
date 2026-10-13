// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 群聊/好友开关 + 仅 AI 对话（独立于事件系统）
// ---------------------------------------------------------------------------

import type { SmartChatConfig, SmartChatDeps } from './smart-chat-types';
import { DEFAULT_PERSONA_LINE, SMART_CHAT_EVENT_KEY, SMART_CHAT_ROOT } from './smart-chat-types';
import { isStockPersonaLine, loadSmartChatConfig } from './smart-chat-config';
import { isAnyStickerGalleryReady } from './smart-chat-sticker';
import crypto from 'crypto';

export const SMART_CHAT_GROUP_SWITCH = `${SMART_CHAT_ROOT}群聊开关.json`;
export const SMART_CHAT_FRIEND_SWITCH = `${SMART_CHAT_ROOT}好友开关.json`;
export const SMART_CHAT_GROUP_AI_ONLY = `${SMART_CHAT_ROOT}仅AI对话群.json`;
export const SMART_CHAT_FRIEND_AI_ONLY = `${SMART_CHAT_ROOT}仅AI对话好友.json`;
export const SMART_CHAT_GROUP_ROUNDS = `${SMART_CHAT_ROOT}轮次群.json`;
export const SMART_CHAT_FRIEND_ROUNDS = `${SMART_CHAT_ROOT}轮次好友.json`;
export const SMART_CHAT_GROUP_IMAGE = `${SMART_CHAT_ROOT}识图群.json`;
export const SMART_CHAT_FRIEND_IMAGE = `${SMART_CHAT_ROOT}识图好友.json`;
/**
 * 识别文件：仅群聊。开启后群里传的白名单后缀文件才会被下载到插件专属目录、
 * 并把内容（≤500KB，内联上限 8000 字）补进会话；关闭时一个字都不记。
 */
export const SMART_CHAT_GROUP_FILE = `${SMART_CHAT_ROOT}识别文件群.json`;
export const SMART_CHAT_GROUP_STICKER = `${SMART_CHAT_ROOT}表情输出群.json`;
export const SMART_CHAT_FRIEND_STICKER = `${SMART_CHAT_ROOT}表情输出好友.json`;
export const SMART_CHAT_GROUP_TOOLS = `${SMART_CHAT_ROOT}联网群.json`;
export const SMART_CHAT_FRIEND_TOOLS = `${SMART_CHAT_ROOT}联网好友.json`;
/** 仅 @ 触发：开启后防抖/最大合并均不生效，仅被 @ 时回应（消息仍照常记录） */
export const SMART_CHAT_GROUP_AT_ONLY = `${SMART_CHAT_ROOT}仅艾特群.json`;
export const SMART_CHAT_FRIEND_AT_ONLY = `${SMART_CHAT_ROOT}仅艾特好友.json`;
/** 仅 @ 模式下是否记录其他（未 @）消息，默认开启；关闭则只记录被 @ 的那条 */
export const SMART_CHAT_GROUP_AT_ONLY_RECORD = `${SMART_CHAT_ROOT}仅艾特记录其他群.json`;
export const SMART_CHAT_FRIEND_AT_ONLY_RECORD = `${SMART_CHAT_ROOT}仅艾特记录其他好友.json`;
/**
 * 伪装思考：默认关闭。开启后（且模型本身无原生思考）在 system 里告诉模型可以
 * 先自行输出一段 <think>…</think> 再回话；该段会被宿主剥离、不发到群，只落盘供后台查看。
 */
export const SMART_CHAT_GROUP_FAKE_THINK = `${SMART_CHAT_ROOT}伪装思考群.json`;
export const SMART_CHAT_FRIEND_FAKE_THINK = `${SMART_CHAT_ROOT}伪装思考好友.json`;
/**
 * 允许语音输出：默认关闭。开启后，回复中合格的短句（净化后 ≤150 字、无艾特/引用/特殊符号）
 * 会走 AI 配音接口转成语音发送；单次回复最多两条语音，其余或失败均回退文本。
 */
export const SMART_CHAT_GROUP_ALLOW_VOICE = `${SMART_CHAT_ROOT}语音输出群.json`;
export const SMART_CHAT_FRIEND_ALLOW_VOICE = `${SMART_CHAT_ROOT}语音输出好友.json`;
/** 群独立人设（空/缺省 = 跟随全局 system_prompt） */
export const SMART_CHAT_GROUP_PERSONA = `${SMART_CHAT_ROOT}人设群.json`;
/** 好友独立人设（空/缺省 = 跟随全局 system_prompt） */
export const SMART_CHAT_FRIEND_PERSONA = `${SMART_CHAT_ROOT}人设好友.json`;

/** 0=上传全部上下文；1–999=仅取最近 N 次访问（不含本轮） */
export function normalizeSmartChatRounds(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(999, Math.max(1, Math.floor(n)));
}

function readB(deps: SmartChatDeps, file: string, key: string, def: unknown): unknown {
    return deps.readB(file, key, def);
}

function writeB(deps: SmartChatDeps, file: string, key: string, value: unknown): void {
    deps.writeB(file, key, value);
}

function normStatus(v: unknown): '开启' | '关闭' | null {
    const s = String(v ?? '').trim();
    if (s === '开启' || s === '关闭') return s;
    if (v === true || v === 1 || s === 'true' || s === '1') return '开启';
    if (v === false || v === 0 || s === 'false' || s === '0') return '关闭';
    return null;
}

/** 兼容：尚未写入独立开关文件时，回落到旧事件系统键 */
function legacyGroupEnabled(deps: SmartChatDeps, groupId: string): boolean {
    return readB(deps, `筱筱吖/事件系统/${groupId}.json`, SMART_CHAT_EVENT_KEY, '关闭') === '开启';
}

function legacyPrivateEnabled(deps: SmartChatDeps): boolean {
    return readB(deps, '筱筱吖/事件系统/私聊.json', SMART_CHAT_EVENT_KEY, '关闭') === '开启';
}

export function isSmartChatGroupEnabled(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    const cur = normStatus(readB(deps, SMART_CHAT_GROUP_SWITCH, gid, null));
    if (cur) return cur === '开启';
    if (legacyGroupEnabled(deps, gid)) {
        writeB(deps, SMART_CHAT_GROUP_SWITCH, gid, '开启');
        return true;
    }
    return false;
}

export function isSmartChatFriendEnabled(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    const cur = normStatus(readB(deps, SMART_CHAT_FRIEND_SWITCH, qq, null));
    if (cur) return cur === '开启';
    if (legacyPrivateEnabled(deps)) {
        // 旧版私聊为全局开关：首次查询某好友时落盘，避免后台全灭
        writeB(deps, SMART_CHAT_FRIEND_SWITCH, qq, '开启');
        return true;
    }
    return false;
}

export function isSmartChatAiOnlyGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_AI_ONLY, gid, '关闭')) === '开启';
}

export function isSmartChatAiOnlyFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_AI_ONLY, qq, '关闭')) === '开启';
}

export function setSmartChatGroupEnabled(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_SWITCH, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatFriendEnabled(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_SWITCH, qq, enabled ? '开启' : '关闭');
}

export function setSmartChatAiOnlyGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_AI_ONLY, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatAiOnlyFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_AI_ONLY, qq, enabled ? '开启' : '关闭');
}

export function getSmartChatGroupRounds(deps: SmartChatDeps, groupId: string): number {
    const gid = String(groupId || '').trim();
    if (!gid) return 0;
    return normalizeSmartChatRounds(readB(deps, SMART_CHAT_GROUP_ROUNDS, gid, 0));
}

export function getSmartChatFriendRounds(deps: SmartChatDeps, userId: string): number {
    const qq = String(userId || '').trim();
    if (!qq) return 0;
    return normalizeSmartChatRounds(readB(deps, SMART_CHAT_FRIEND_ROUNDS, qq, 0));
}

export function setSmartChatGroupRounds(deps: SmartChatDeps, groupId: string, rounds: number): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_ROUNDS, gid, normalizeSmartChatRounds(rounds));
}

export function setSmartChatFriendRounds(deps: SmartChatDeps, userId: string, rounds: number): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_ROUNDS, qq, normalizeSmartChatRounds(rounds));
}

export function isSmartChatImageGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_IMAGE, gid, '关闭')) === '开启';
}

export function isSmartChatImageFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_IMAGE, qq, '关闭')) === '开启';
}

export function setSmartChatImageGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_IMAGE, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatImageFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_IMAGE, qq, enabled ? '开启' : '关闭');
}

/** 识别文件：默认关闭，仅群聊有效 */
export function isSmartChatFileGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_FILE, gid, '关闭')) === '开启';
}

export function setSmartChatFileGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_FILE, gid, enabled ? '开启' : '关闭');
}

export function isSmartChatStickerGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    if (!isAnyStickerGalleryReady(deps)) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_STICKER, gid, '关闭')) === '开启';
}

export function isSmartChatStickerFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    if (!isAnyStickerGalleryReady(deps)) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_STICKER, qq, '关闭')) === '开启';
}

/**
 * 设置表情输出。开启时若本机无可用图库则拒绝（返回 false）；关闭始终允许。
 */
export function setSmartChatStickerGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    if (enabled && !isAnyStickerGalleryReady(deps)) return false;
    writeB(deps, SMART_CHAT_GROUP_STICKER, gid, enabled ? '开启' : '关闭');
    return true;
}

export function setSmartChatStickerFriend(deps: SmartChatDeps, userId: string, enabled: boolean): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    if (enabled && !isAnyStickerGalleryReady(deps)) return false;
    writeB(deps, SMART_CHAT_FRIEND_STICKER, qq, enabled ? '开启' : '关闭');
    return true;
}

/** 联网搜索：未落盘默认关闭（与识图/表情一致；不再回落旧全局 tools_enabled） */
export function isSmartChatToolsGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_TOOLS, gid, '关闭')) === '开启';
}

export function isSmartChatToolsFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_TOOLS, qq, '关闭')) === '开启';
}

export function setSmartChatToolsGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_TOOLS, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatToolsFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_TOOLS, qq, enabled ? '开启' : '关闭');
}

/** 仅 @ 触发：默认关闭。开启后防抖/最大合并失效，仅被 @ 时回应 */
export function isSmartChatAtOnlyGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_AT_ONLY, gid, '关闭')) === '开启';
}

export function isSmartChatAtOnlyFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_AT_ONLY, qq, '关闭')) === '开启';
}

export function setSmartChatAtOnlyGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_AT_ONLY, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatAtOnlyFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_AT_ONLY, qq, enabled ? '开启' : '关闭');
}

/** 仅 @ 模式下是否记录其他（未 @）消息：默认开启（未落盘=开启），仅显式关闭才为 false */
export function isSmartChatAtOnlyRecordGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return true;
    return normStatus(readB(deps, SMART_CHAT_GROUP_AT_ONLY_RECORD, gid, '开启')) !== '关闭';
}

export function isSmartChatAtOnlyRecordFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return true;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_AT_ONLY_RECORD, qq, '开启')) !== '关闭';
}

export function setSmartChatAtOnlyRecordGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_AT_ONLY_RECORD, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatAtOnlyRecordFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_AT_ONLY_RECORD, qq, enabled ? '开启' : '关闭');
}

/** 伪装思考：默认关闭，仅显式开启才为 true */
export function isSmartChatFakeThinkGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_FAKE_THINK, gid, '关闭')) === '开启';
}

export function isSmartChatFakeThinkFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_FAKE_THINK, qq, '关闭')) === '开启';
}

export function setSmartChatFakeThinkGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_FAKE_THINK, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatFakeThinkFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_FAKE_THINK, qq, enabled ? '开启' : '关闭');
}

export function isSmartChatAllowVoiceGroup(deps: SmartChatDeps, groupId: string): boolean {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return normStatus(readB(deps, SMART_CHAT_GROUP_ALLOW_VOICE, gid, '关闭')) === '开启';
}

export function isSmartChatAllowVoiceFriend(deps: SmartChatDeps, userId: string): boolean {
    const qq = String(userId || '').trim();
    if (!qq) return false;
    return normStatus(readB(deps, SMART_CHAT_FRIEND_ALLOW_VOICE, qq, '关闭')) === '开启';
}

export function setSmartChatAllowVoiceGroup(deps: SmartChatDeps, groupId: string, enabled: boolean): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    writeB(deps, SMART_CHAT_GROUP_ALLOW_VOICE, gid, enabled ? '开启' : '关闭');
}

export function setSmartChatAllowVoiceFriend(deps: SmartChatDeps, userId: string, enabled: boolean): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    writeB(deps, SMART_CHAT_FRIEND_ALLOW_VOICE, qq, enabled ? '开启' : '关闭');
}

/** 当前对象是否开启「仅 @ 触发」 */
export function isSmartChatAtOnlyForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatAtOnlyGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatAtOnlyFriend(deps, String(event.user_id || ''));
    }
    return false;
}

/** 仅 @ 模式下当前对象是否记录未 @ 的其他消息（默认 true） */
export function isSmartChatAtOnlyRecordForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatAtOnlyRecordGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatAtOnlyRecordFriend(deps, String(event.user_id || ''));
    }
    return true;
}

/** 当前对象是否开启「伪装思考」（默认关闭；是否真正注入还要看模型无原生思考） */
export function isSmartChatFakeThinkForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatFakeThinkGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatFakeThinkFriend(deps, String(event.user_id || ''));
    }
    return false;
}

/** 当前对象是否开启联网搜索（还需全局配置了搜索 Key） */
export function isSmartChatToolsForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatToolsGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatToolsFriend(deps, String(event.user_id || ''));
    }
    return false;
}

/** 当前对象是否允许语音输出（还需全局配好角色；否则合格文本也只能按文本发） */
export function isSmartChatAllowVoiceForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatAllowVoiceGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatAllowVoiceFriend(deps, String(event.user_id || ''));
    }
    return false;
}

/** 当前对象是否开启表情输出（且本机图库可用） */
export function isSmartChatStickerForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatStickerGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatStickerFriend(deps, String(event.user_id || ''));
    }
    return false;
}

/** 当前对象是否开启识图（与全局联网页参数配合） */
export function isSmartChatImageForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatImageGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatImageFriend(deps, String(event.user_id || ''));
    }
    return false;
}

/**
 * 当前对象是否开启「识别文件」。仅群聊：私聊/无群号一律 false
 * （notice 事件没有 message_type，靠 group_id 判定）。
 */
export function isSmartChatFileForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'private') return false;
    const gid = String(event.group_id || '').trim();
    if (!gid) return false;
    return isSmartChatFileGroup(deps, gid);
}

/** 当前对象历史上传轮次（0=全部） */
export function getSmartChatRoundsForEvent(deps: SmartChatDeps, event: Record<string, unknown>): number {
    if (event.message_type === 'group') {
        return getSmartChatGroupRounds(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return getSmartChatFriendRounds(deps, String(event.user_id || ''));
    }
    return 0;
}

/** 读取独立人设原文；空串 = 未设置（跟随全局） */
export function getSmartChatGroupPersona(deps: SmartChatDeps, groupId: string): string {
    const gid = String(groupId || '').trim();
    if (!gid) return '';
    return String(readB(deps, SMART_CHAT_GROUP_PERSONA, gid, '') || '').trim();
}

export function getSmartChatFriendPersona(deps: SmartChatDeps, userId: string): string {
    const qq = String(userId || '').trim();
    if (!qq) return '';
    return String(readB(deps, SMART_CHAT_FRIEND_PERSONA, qq, '') || '').trim();
}

/** 写入独立人设；空串则清除（跟随全局） */
export function setSmartChatGroupPersona(deps: SmartChatDeps, groupId: string, persona: string): void {
    const gid = String(groupId || '').trim();
    if (!gid) return;
    const v = String(persona || '').trim();
    writeB(deps, SMART_CHAT_GROUP_PERSONA, gid, v);
}

export function setSmartChatFriendPersona(deps: SmartChatDeps, userId: string, persona: string): void {
    const qq = String(userId || '').trim();
    if (!qq) return;
    const v = String(persona || '').trim();
    writeB(deps, SMART_CHAT_FRIEND_PERSONA, qq, v);
}

export function getSmartChatPersonaOverride(
    deps: SmartChatDeps,
    type: 'group' | 'friend',
    id: string,
): string {
    return type === 'group'
        ? getSmartChatGroupPersona(deps, id)
        : getSmartChatFriendPersona(deps, id);
}

export function setSmartChatPersonaOverride(
    deps: SmartChatDeps,
    type: 'group' | 'friend',
    id: string,
    persona: string,
): void {
    if (type === 'group') setSmartChatGroupPersona(deps, id, persona);
    else setSmartChatFriendPersona(deps, id, persona);
}

/** 独立非空 ＞ 全局 ＞ 内置默认 */
export function resolveEffectivePersonaLine(
    deps: SmartChatDeps,
    type: 'group' | 'friend',
    id: string,
    cfg?: SmartChatConfig,
): string {
    const override = getSmartChatPersonaOverride(deps, type, id);
    if (override) return override;
    const config = cfg || loadSmartChatConfig(deps);
    const global = String(config.system_prompt || '').trim();
    return global || DEFAULT_PERSONA_LINE;
}

/** 把有效人设写入 cfg 副本，供指纹 / compose / loadSession 使用 */
export function configWithEffectivePersona(cfg: SmartChatConfig, personaLine: string): SmartChatConfig {
    const line = String(personaLine || '').trim() || DEFAULT_PERSONA_LINE;
    return { ...cfg, system_prompt: line };
}

/** 从 chatId（g_xxx / p_xxx）解析 scope */
export function parseSmartChatScope(chatId: string): { type: 'group' | 'friend'; id: string } | null {
    const s = String(chatId || '').trim();
    if (/^g_/i.test(s)) {
        const id = s.slice(2).trim();
        return id ? { type: 'group', id } : null;
    }
    if (/^p_/i.test(s)) {
        const id = s.slice(2).trim();
        return id ? { type: 'friend', id } : null;
    }
    return null;
}

export function resolveEffectivePersonaForChatId(
    deps: SmartChatDeps,
    chatId: string,
    cfg?: SmartChatConfig,
): string {
    const config = cfg || loadSmartChatConfig(deps);
    const scope = parseSmartChatScope(chatId);
    if (!scope) {
        const global = String(config.system_prompt || '').trim();
        return global || DEFAULT_PERSONA_LINE;
    }
    return resolveEffectivePersonaLine(deps, scope.type, scope.id, config);
}

/** 人设融合预热键：对 effective persona 行做稳定 hash */
export function hashPersonaFusionKey(personaLine: string): string {
    const line = String(personaLine || '').trim();
    return crypto.createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 16);
}

/** 当前 chat 实际生效人设是否为内置默认（含群/好友覆盖后的最终结果） */
export function needsPersonaFusionForChat(
    deps: SmartChatDeps,
    chatId: string,
    cfg?: SmartChatConfig,
): boolean {
    const line = resolveEffectivePersonaForChatId(deps, chatId, cfg);
    return !isStockPersonaLine(line);
}

export function isPersonaFusionReady(
    session: { persona_fusion_hash?: string },
    personaHash: string,
): boolean {
    const want = String(personaHash || '').trim();
    if (!want) return true;
    return String(session?.persona_fusion_hash || '').trim() === want;
}

export function currentPersonaFusionHash(
    deps: SmartChatDeps,
    chatId: string,
    cfg?: SmartChatConfig,
): string {
    return hashPersonaFusionKey(resolveEffectivePersonaForChatId(deps, chatId, cfg));
}

/** 当前 chat 的配置快照（system_prompt 已换成有效人设） */
export function loadConfigForChat(
    deps: SmartChatDeps,
    chatId: string,
    cfg?: SmartChatConfig,
): SmartChatConfig {
    const config = cfg || loadSmartChatConfig(deps);
    return configWithEffectivePersona(config, resolveEffectivePersonaForChatId(deps, chatId, config));
}

export function resolveEffectivePersonaForEvent(
    deps: SmartChatDeps,
    event: Record<string, unknown>,
    cfg?: SmartChatConfig,
): string {
    const config = cfg || loadSmartChatConfig(deps);
    if (event.message_type === 'group') {
        return resolveEffectivePersonaLine(deps, 'group', String(event.group_id || ''), config);
    }
    if (event.message_type === 'private') {
        return resolveEffectivePersonaLine(deps, 'friend', String(event.user_id || ''), config);
    }
    const global = String(config.system_prompt || '').trim();
    return global || DEFAULT_PERSONA_LINE;
}

/** 当前消息是否启用智能对话 */
export function isSmartChatEnabledForEvent(
    deps: SmartChatDeps,
    event: Record<string, unknown>,
    cfg?: SmartChatConfig,
): boolean {
    const config = cfg || loadSmartChatConfig(deps);
    if (event.message_type === 'group') {
        return isSmartChatGroupEnabled(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        if (!config.private_chat_enabled) return false;
        return isSmartChatFriendEnabled(deps, String(event.user_id || ''));
    }
    return false;
}

/** 当前消息是否「仅 AI 对话」（命中后宿主应中断后续群管/娱乐等） */
export function isSmartChatAiOnlyForEvent(deps: SmartChatDeps, event: Record<string, unknown>): boolean {
    if (event.message_type === 'group') {
        return isSmartChatAiOnlyGroup(deps, String(event.group_id || ''));
    }
    if (event.message_type === 'private') {
        return isSmartChatAiOnlyFriend(deps, String(event.user_id || ''));
    }
    return false;
}

export function listSmartChatSwitchMap(
    deps: SmartChatDeps,
    type: 'group' | 'friend',
): Record<string, {
    enabled: boolean;
    ai_only: boolean;
    rounds: number;
    image_recognize: boolean;
    file_recognize: boolean;
    sticker_output: boolean;
    web_search: boolean;
    at_only: boolean;
    at_only_record: boolean;
    fake_think: boolean;
    system_prompt: string;
}> {
    const switchFile = type === 'group' ? SMART_CHAT_GROUP_SWITCH : SMART_CHAT_FRIEND_SWITCH;
    const aiFile = type === 'group' ? SMART_CHAT_GROUP_AI_ONLY : SMART_CHAT_FRIEND_AI_ONLY;
    const roundsFile = type === 'group' ? SMART_CHAT_GROUP_ROUNDS : SMART_CHAT_FRIEND_ROUNDS;
    const imageFile = type === 'group' ? SMART_CHAT_GROUP_IMAGE : SMART_CHAT_FRIEND_IMAGE;
    const stickerFile = type === 'group' ? SMART_CHAT_GROUP_STICKER : SMART_CHAT_FRIEND_STICKER;
    const toolsFile = type === 'group' ? SMART_CHAT_GROUP_TOOLS : SMART_CHAT_FRIEND_TOOLS;
    const atOnlyFile = type === 'group' ? SMART_CHAT_GROUP_AT_ONLY : SMART_CHAT_FRIEND_AT_ONLY;
    const atRecordFile = type === 'group' ? SMART_CHAT_GROUP_AT_ONLY_RECORD : SMART_CHAT_FRIEND_AT_ONLY_RECORD;
    const fakeThinkFile = type === 'group' ? SMART_CHAT_GROUP_FAKE_THINK : SMART_CHAT_FRIEND_FAKE_THINK;
    const personaFile = type === 'group' ? SMART_CHAT_GROUP_PERSONA : SMART_CHAT_FRIEND_PERSONA;
    const rawSwitch = deps.readA(switchFile);
    const rawAi = deps.readA(aiFile);
    const rawRounds = deps.readA(roundsFile);
    const rawImage = deps.readA(imageFile);
    const rawFile = type === 'group' ? deps.readA(SMART_CHAT_GROUP_FILE) : false;
    const rawSticker = deps.readA(stickerFile);
    const rawTools = deps.readA(toolsFile);
    const rawAtOnly = deps.readA(atOnlyFile);
    const rawAtRecord = deps.readA(atRecordFile);
    const rawFakeThink = deps.readA(fakeThinkFile);
    const rawPersona = deps.readA(personaFile);
    let switchObj: Record<string, unknown> = {};
    let aiObj: Record<string, unknown> = {};
    let roundsObj: Record<string, unknown> = {};
    let imageObj: Record<string, unknown> = {};
    let fileObj: Record<string, unknown> = {};
    let stickerObj: Record<string, unknown> = {};
    let toolsObj: Record<string, unknown> = {};
    let atOnlyObj: Record<string, unknown> = {};
    let atRecordObj: Record<string, unknown> = {};
    let fakeThinkObj: Record<string, unknown> = {};
    let personaObj: Record<string, unknown> = {};
    try {
        if (rawSwitch) switchObj = JSON.parse(String(rawSwitch)) || {};
    } catch { /* ignore */ }
    try {
        if (rawAi) aiObj = JSON.parse(String(rawAi)) || {};
    } catch { /* ignore */ }
    try {
        if (rawRounds) roundsObj = JSON.parse(String(rawRounds)) || {};
    } catch { /* ignore */ }
    try {
        if (rawImage) imageObj = JSON.parse(String(rawImage)) || {};
    } catch { /* ignore */ }
    try {
        if (rawFile) fileObj = JSON.parse(String(rawFile)) || {};
    } catch { /* ignore */ }
    try {
        if (rawSticker) stickerObj = JSON.parse(String(rawSticker)) || {};
    } catch { /* ignore */ }
    try {
        if (rawTools) toolsObj = JSON.parse(String(rawTools)) || {};
    } catch { /* ignore */ }
    try {
        if (rawAtOnly) atOnlyObj = JSON.parse(String(rawAtOnly)) || {};
    } catch { /* ignore */ }
    try {
        if (rawAtRecord) atRecordObj = JSON.parse(String(rawAtRecord)) || {};
    } catch { /* ignore */ }
    try {
        if (rawFakeThink) fakeThinkObj = JSON.parse(String(rawFakeThink)) || {};
    } catch { /* ignore */ }
    try {
        if (rawPersona) personaObj = JSON.parse(String(rawPersona)) || {};
    } catch { /* ignore */ }

    const galleryReady = isAnyStickerGalleryReady(deps);
    const ids = new Set([
        ...Object.keys(switchObj || {}),
        ...Object.keys(aiObj || {}),
        ...Object.keys(roundsObj || {}),
        ...Object.keys(imageObj || {}),
        ...Object.keys(fileObj || {}),
        ...Object.keys(stickerObj || {}),
        ...Object.keys(toolsObj || {}),
        ...Object.keys(atOnlyObj || {}),
        ...Object.keys(atRecordObj || {}),
        ...Object.keys(fakeThinkObj || {}),
        ...Object.keys(personaObj || {}),
    ]);
    const out: Record<string, {
        enabled: boolean;
        ai_only: boolean;
        rounds: number;
        image_recognize: boolean;
        file_recognize: boolean;
        sticker_output: boolean;
        web_search: boolean;
        at_only: boolean;
        at_only_record: boolean;
        fake_think: boolean;
        system_prompt: string;
    }> = {};
    for (const id of ids) {
        const en = normStatus(switchObj[id]);
        const ai = normStatus(aiObj[id]);
        const img = normStatus(imageObj[id]);
        const fileOn = normStatus(fileObj[id]);
        const st = normStatus(stickerObj[id]);
        const tools = normStatus(toolsObj[id]);
        const atOnly = normStatus(atOnlyObj[id]);
        const atRecord = normStatus(atRecordObj[id]);
        const fakeThink = normStatus(fakeThinkObj[id]);
        out[id] = {
            enabled: en === '开启',
            ai_only: ai === '开启',
            rounds: normalizeSmartChatRounds(roundsObj[id]),
            image_recognize: img === '开启',
            file_recognize: type === 'group' && fileOn === '开启',
            sticker_output: galleryReady && st === '开启',
            web_search: tools === '开启',
            at_only: atOnly === '开启',
            at_only_record: atRecord !== '关闭',
            fake_think: fakeThink === '开启',
            system_prompt: String(personaObj[id] || '').trim(),
        };
    }
    return out;
}

export function bulkSetSmartChatEnabled(
    deps: SmartChatDeps,
    type: 'group' | 'friend',
    ids: string[],
    enabled: boolean,
): number {
    let n = 0;
    for (const id of ids) {
        if (!id) continue;
        if (type === 'group') setSmartChatGroupEnabled(deps, id, enabled);
        else setSmartChatFriendEnabled(deps, id, enabled);
        n += 1;
    }
    return n;
}
