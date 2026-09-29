// @ts-nocheck
// ---------------------------------------------------------------------------
// 智能对话 — 自定义人设融合预热（空访问，写入会话但不发群）
// ---------------------------------------------------------------------------

import type { SmartChatConfig, SmartChatDeps, SmartChatSessionFile } from './smart-chat-types';
import {
    buildSessionSystemPrompt,
    recordSentApiPrefix,
    resolveFrozenSystemCaps,
} from './smart-chat-compose';
import { getPrependOnlyMessages, appendSessionTurn } from './smart-chat-session';
import { chatCompletion, stripToolMarkup } from './smart-chat-provider';
import { recordUsage } from './smart-chat-billing';
import { buildStickerSystemSuffix, stickerGalleryInstallKey } from './smart-chat-sticker';
import { toolsShouldAttach } from './smart-chat-tools';

export const PERSONA_FUSION_PROBE_USER = '。';

export interface PersonaFusionWarmupOpts {
    imageRecognize?: boolean;
    stickerOutput?: boolean;
    toolsEnabled?: boolean;
    botNickname?: string;
}

export interface PersonaFusionWarmupResult {
    ok: boolean;
    latency_ms: number;
    error?: string;
    status?: number;
    raw?: string;
    assistantContent?: string;
}

function fusionAssistantStoreContent(raw: string): string {
    const text = stripToolMarkup(String(raw || '').trim());
    // 预热是空访问、不发群；模型没给正文就如实记「沉默」，不替它编一个「。」气泡。
    if (!text) return '<shut_up/>';
    if (text.includes('<replies>') || text.includes('<shut_up')) return text;
    return `<replies><msg>${text}</msg></replies>`;
}

export async function runPersonaFusionWarmup(
    deps: SmartChatDeps,
    chatId: string,
    config: SmartChatConfig,
    session: SmartChatSessionFile,
    opts?: PersonaFusionWarmupOpts,
): Promise<PersonaFusionWarmupResult> {
    const started = Date.now();
    const liveCaps = {
        tools: toolsShouldAttach(config, Boolean(opts?.toolsEnabled)),
        image: Boolean(opts?.imageRecognize),
        sticker: Boolean(opts?.stickerOutput),
    };
    const { caps: systemCaps } = resolveFrozenSystemCaps(session, liveCaps);
    const stickerSystemSuffix = systemCaps.sticker ? buildStickerSystemSuffix(deps) : '';
    // 预热与正式访问必须同一份 system：技能树/本群事实已由 flush 在本函数之前冻结
    const systemPrompt = buildSessionSystemPrompt(config, session, systemCaps, {
        botNickname: opts?.botNickname,
        stickerSystemSuffix,
        stickerInstallKey: stickerGalleryInstallKey(deps),
    });
    const history = getPrependOnlyMessages(session).map((m) => ({
        role: m.role,
        content: String(m.content || ''),
    }));
    const apiMessages = [
        ...history,
        { role: 'user', content: PERSONA_FUSION_PROBE_USER },
    ];

    const result = await chatCompletion(config, systemPrompt, apiMessages);
    const latency_ms = Date.now() - started;

    if (!result.ok) {
        const error = result.error || 'fusion_warmup_failed';
        deps.logger?.warn?.(
            `[智能对话] ${chatId} 人设融合预热 API 失败 latency=${latency_ms}ms`
            + (result.status ? ` status=${result.status}` : '')
            + ` error=${error}`,
        );
        if (result.raw) {
            deps.logger?.warn?.(
                `[智能对话] ${chatId} 人设融合预热失败响应:\n${result.raw}`,
            );
        }
        return {
            ok: false,
            latency_ms,
            error,
            status: result.status,
            raw: result.raw,
        };
    }

    const assistantContent = fusionAssistantStoreContent(String(result.content || ''));
    // 口径与 flush 一致：只记「真正发出的那份」，不含模型回复的 assistant。
    // 旧实现把 assistant 也算进去，导致预热后下一轮永远 prefixStable=false。
    recordSentApiPrefix(session, systemPrompt, apiMessages);
    appendSessionTurn(
        deps,
        chatId,
        PERSONA_FUSION_PROBE_USER,
        assistantContent,
        config,
        { baseSession: session, shutUp: false },
    );

    if (result.usage) {
        recordUsage(deps, config, chatId, result.usage);
    }

    return { ok: true, latency_ms, assistantContent };
}
