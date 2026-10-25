// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { initSmartChatRuntime, shutdownSmartChatRuntime, smartChatIngest, smartChatIngestNotice } from './auth/smart-chat.js';
import { bindLogger, getDataPath, readA, readB, setDataPath, writeA, writeB } from './lib/data-fs.js';
import {
  BOTAPI,
  bindBotCtx,
  eventUserTextFromSegments,
  发消息,
  设消息表情,
  段_图片,
  段_语音,
  段_文本,
  段_艾特,
  段_引用,
} from './lib/bot.js';
import { registerMkaiWebui } from './lib/webui.js';

let gCtx: any = null;
let gLogger: any = console;
let smartChatDeps: any = null;
let plugin_config_ui: unknown[] = [];

function isKakakeLikeFramework(ctx: any): boolean {
  const id = String(ctx?.frameworkEnv?.frameworkId || '');
  return id === 'kakake' || id === 'mk-jsbot';
}

function resolveApiTimeoutMs(ctx: any): number {
  try {
    const n = Number(readB('config.json', 'apiTimeoutMs', 0));
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* ignore */
  }
  const fromFw = Number(ctx?.frameworkEnv?.apiTimeoutMs || 0);
  return Number.isFinite(fromFw) && fromFw > 0 ? fromFw : 60000;
}

function buildDeps(ctx: any) {
  return {
    readA,
    writeA,
    readB,
    writeB,
    getDataPath,
    logger: gLogger,
    发消息,
    设消息表情,
    eventUserTextFromSegments,
    段_文本,
    段_图片,
    段_语音,
    段_艾特,
    段_引用,
    botApi: (action: string, params?: Record<string, unknown>) => BOTAPI(ctx, action, params || {}),
    isKakakeLikeFramework: () => isKakakeLikeFramework(ctx),
    resolveApiTimeoutMs: () => resolveApiTimeoutMs(ctx),
  };
}

export async function plugin_init(ctx: any): Promise<void> {
  gCtx = ctx;
  gLogger = ctx?.logger ?? console;
  bindLogger(gLogger);
  bindBotCtx(ctx);

  const dp = ctx?.dataPath
    || (ctx?.configPath ? path.dirname(ctx.configPath) : path.join(process.cwd(), 'mk_ai_data'));
  if (!fs.existsSync(dp)) fs.mkdirSync(dp, { recursive: true });
  setDataPath(dp);

  smartChatDeps = buildDeps(ctx);
  initSmartChatRuntime(smartChatDeps);
  registerMkaiWebui(ctx, smartChatDeps);
  plugin_config_ui = [];

  gLogger.info?.(`[智能对话] 初始化完成 · 数据目录 ${dp}`);
}

export async function plugin_cleanup(): Promise<void> {
  const cleared = shutdownSmartChatRuntime();
  gCtx = null;
  smartChatDeps = null;
  gLogger?.info?.(`[智能对话] 已卸载（清除 ${cleared} 个等待计时）`);
  gLogger = console;
}

export async function plugin_onmessage(ctx: any, event: any): Promise<void> {
  if (ctx) {
    gCtx = ctx;
    bindBotCtx(ctx);
    if (smartChatDeps) {
      smartChatDeps.botApi = (action: string, params?: Record<string, unknown>) =>
        BOTAPI(ctx, action, params || {});
    }
  }
  if (!smartChatDeps || !event) return;

  try {
    // 有些宿主把 notice 也推到消息通道：群文件通知走识别文件那条路
    if (String(event?.post_type || '') === 'notice' || event?.notice_type) {
      await smartChatIngestNotice(smartChatDeps, event);
      return;
    }
    await smartChatIngest(smartChatDeps, event);
  } catch (e: any) {
    gLogger?.error?.('[智能对话] 处理消息失败:', e?.message || e);
  }
}

export async function plugin_onevent(ctx: any, event: any): Promise<void> {
  if (ctx) {
    gCtx = ctx;
    bindBotCtx(ctx);
    if (smartChatDeps) {
      smartChatDeps.botApi = (action: string, params?: Record<string, unknown>) =>
        BOTAPI(ctx, action, params || {});
    }
  }
  if (!smartChatDeps || !event) return;
  // 群文件上传通知（notice: group_upload）→ 识别文件
  try {
    await smartChatIngestNotice(smartChatDeps, event);
  } catch (e: any) {
    gLogger?.error?.('[智能对话] 处理群文件通知失败:', e?.message || e);
  }
}

export { plugin_config_ui };
