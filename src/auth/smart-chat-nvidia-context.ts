// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 英伟达 NIM 上下文预算（客户端触顶防护；无服务端会话继承）
// ---------------------------------------------------------------------------

/**
 * 估算口径已统一到 `smart-chat-token-meter`（按字符分类 + 真实 usage 标定）。
 * 旧实现是「总长 / 2.5」，对纯中文会低估（实测 17538 vs 上游真实 26505），
 * 会让触顶保护启动得太晚；这里改成复用同一实现，避免两套口径打架。
 */
export { estimateTextTokens, estimateMessagesTokens } from './smart-chat-token-meter';
import { estimateTextTokens, estimateMessagesTokens } from './smart-chat-token-meter';

/**
 * 英伟达托管 API 保守 input 预算（已给输出留余量）。
 * 卡面 1M ≠ NIM 实装。
 */
export function nvidiaContextBudget(modelId: string): number {
    const m = String(modelId || '').toLowerCase();
    if (
        m.includes('deepseek-v4')
        || m.includes('nemotron-3-ultra')
        || m.includes('nemotron-3-super')
    ) {
        return 800_000;
    }
    if (
        m.includes('gpt-oss')
        || m.includes('kimi-k2')
        || m.includes('llama-3.3')
        || m.includes('llama-3.1-70b')
        || m.includes('gemma-4')
        || m.includes('diffusiongemma')
    ) {
        return 110_000;
    }
    if (m.includes('nemotron-3.5-lightning') || m.includes('nemotron-3-nano')) {
        return 110_000;
    }
    return 100_000;
}

/** 预检阈值：超过预算的该比例则先 compact */
export const NVIDIA_CONTEXT_PRECHECK_RATIO = 0.85;
