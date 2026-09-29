// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 工具技能开关（技能树 UI；不进 Top-M 文本）
// ---------------------------------------------------------------------------

import type { SmartChatDeps } from './smart-chat-types';
import { SMART_CHAT_ROOT } from './smart-chat-types';
import { listMkApiToolDefs } from '../ai/index.js';

const TOOL_SKILLS_FILE = `${SMART_CHAT_ROOT}tool-skills.json`;

type ToolSkillsState = Record<string, { enabled: boolean }>;

function loadState(deps: SmartChatDeps): ToolSkillsState {
    try {
        const raw = deps.readA(TOOL_SKILLS_FILE);
        if (!raw) return {};
        const obj = JSON.parse(String(raw));
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
        return {};
    }
}

function saveState(deps: SmartChatDeps, state: ToolSkillsState): void {
    deps.writeA(TOOL_SKILLS_FILE, JSON.stringify(state, null, 2));
}

export function isMkApiToolEnabled(deps: SmartChatDeps, code: string): boolean {
    const c = String(code || '').trim();
    if (!c) return false;
    const def = listMkApiToolDefs().find((t) => t.code === c);
    if (!def) return false;
    const state = loadState(deps);
    const row = state[c];
    if (row && typeof row.enabled === 'boolean') return row.enabled;
    return def.defaultEnabled !== false;
}

export function setMkApiToolEnabled(deps: SmartChatDeps, code: string, enabled: boolean): boolean {
    const c = String(code || '').trim();
    const def = listMkApiToolDefs().find((t) => t.code === c);
    if (!def) return false;
    const state = loadState(deps);
    state[c] = { enabled: Boolean(enabled) };
    saveState(deps, state);
    return true;
}

/** WebUI 列表 */
export function listMkApiToolSkillRows(deps: SmartChatDeps): Array<{
    code: string;
    title: string;
    when: string;
    params: string;
    enabled: boolean;
}> {
    return listMkApiToolDefs().map((t) => ({
        code: t.code,
        title: t.title,
        when: t.when,
        params: t.params,
        enabled: isMkApiToolEnabled(deps, t.code),
    }));
}
