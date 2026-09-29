// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let 当前上下文 = null;

export function bindBotCtx(ctx) {
  当前上下文 = ctx;
}

/** 本地媒体文件转 base64:// 的体积上限：超了宁可回退文本，也不撑爆 WS 帧 */
const 本地媒体转base64上限 = 8 * 1024 * 1024;

/**
 * 把本地媒体文件读成 `base64://` 串。
 *
 * **为什么必须转 base64（2026-09-29 二次实测）**：本地绝对路径 NapCat 一律不收。
 * 它的 record/image 段 file 字段会先做 URL 识别，凡是含冒号的串都当 URL 解析：
 *   - `file:///C:/...`  → 「语音转换失败, 请检查语音文件是否正常」
 *   - `C:/Users/...`    → 「文件处理失败: 识别URL失败, uri= C:/Users/...」
 *     （`C:` 被当成 scheme，找不到对应协议就报识别失败）
 * 所以「裸绝对路径」这条路上轮就已经是死的，只是报错换了张脸。
 * 日志对照（2026-09-29 02:26，同一轮）：https URL ✓ / file:// ✗ / 裸 C:/ ✗ —— 本地路径无一成功。
 *
 * base64 是 NapCat 自己发本地附件时用的通道（读内存 → hash → base64://），
 * 不依赖 NapCat 能访问我们的文件系统，跨容器/跨盘符都成立。
 * 语音文件实测平均仅 ~30 KB，base64 后 ~40 KB，对 WS 帧完全无压力。
 *
 * 失败（文件不存在 / 超限 / 读失败）返回 ''，由调用方决定回退策略。
 */
function 本地媒体转base64(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size <= 0) return '';
    if (st.size > 本地媒体转base64上限) return '';
    const buf = fs.readFileSync(absPath);
    if (!buf.length) return '';
    return `base64://${buf.toString('base64')}`;
  } catch (_e) {
    return '';
  }
}

/**
 * 把媒体输入规范化成 NapCat 能吃的 `file` 值。
 *
 * 三种输入各有归宿：
 *   1. http(s) / base64:// / data: —— 原样透传（远端 URL 是实测最稳的一条路）
 *   2. file:// URL —— 先剥成裸路径，再走第 3 条（幂等，不二次编码）
 *   3. 本地文件路径 —— **读成 base64://**（NapCat 不收本地路径，见上面的实测对照）
 *
 * 都落空时返回 ''，调用方沿用原串（保持旧行为，至少报错信息里能看到原始值）。
 */
function 媒体路径(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^base64:\/\//i.test(s) || /^data:/i.test(s)) return s;

  // file:// → 裸路径（历史遗留输入，幂等剥离）
  let local = '';
  if (/^file:\/\//i.test(s)) {
    try {
      local = fileURLToPath(s);
    } catch (_e) {
      local = '';
    }
  } else {
    try {
      local = path.isAbsolute(s) ? s : path.resolve(s);
    } catch (_e) {
      local = '';
    }
  }
  if (!local) return s;

  // 本地文件：必须转 base64，NapCat 不收裸路径（尤其 Windows 的 C: 会被当成 URL scheme）
  const b64 = 本地媒体转base64(local);
  return b64 || s;
}

function normalizeOutboundText(text) {
  return String(text ?? '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

export function 段_文本(text) {
  return { type: 'text', data: { text: normalizeOutboundText(text) } };
}

export function 段_图片(file) {
  const f = String(file ?? '').trim();
  if (!f) return 段_文本('');
  const resolved = 媒体路径(f);
  return { type: 'image', data: { file: resolved || f } };
}

export function 段_语音(file) {
  const f = String(file ?? '').trim();
  if (!f) return 段_文本('');
  const resolved = 媒体路径(f);
  // 转换失败（文件丢失/超限）时留痕：否则只会看到协议端一句「识别URL失败」，无从定位
  if (resolved === f && !/^(?:https?:\/\/|base64:\/\/|data:)/i.test(f)) {
    当前上下文?.logger?.warn?.(`[媒体] 语音本地文件转 base64 失败，将原样下发（可能被协议端拒绝）: ${f}`);
  }
  return { type: 'record', data: { file: resolved || f } };
}

export function 段_引用(messageId) {
  const id = String(messageId ?? '').trim();
  if (!id) return null;
  return { type: 'reply', data: { id } };
}

export function 段_艾特(qq) {
  const q = String(qq ?? '').trim();
  if (!q) return null;
  return { type: 'at', data: { qq: q } };
}

function 规范化消息段(message) {
  if (!Array.isArray(message) || message.length === 0) return [];
  const out = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    const type = String(seg.type ?? '').toLowerCase();
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
    if (type === 'text') {
      out.push({ type: 'text', data: { text: normalizeOutboundText(data.text) } });
      continue;
    }
    if (type === 'image') {
      const file = String(data.file ?? data.url ?? '').trim();
      if (file) out.push(段_图片(file));
      continue;
    }
    if (type === 'record') {
      const file = String(data.file ?? data.url ?? '').trim();
      if (file) out.push(段_语音(file));
      continue;
    }
    if (type === 'reply') {
      const rep = 段_引用(data.id ?? data.message_id);
      if (rep) out.push(rep);
      continue;
    }
    if (type === 'at') {
      const at = 段_艾特(data.qq);
      if (at) out.push(at);
      continue;
    }
    if (type) out.push(seg);
  }
  return out.length ? out : [段_文本('')];
}

function 构建发送参数(event, message) {
  const params = {
    message_type: event.message_type,
    message,
  };
  if (event.message_type === 'group') {
    const gid = Number(event.group_id);
    params.group_id = Number.isFinite(gid) ? gid : event.group_id;
  } else {
    const uid = Number(event.user_id);
    params.user_id = Number.isFinite(uid) ? uid : event.user_id;
  }
  return params;
}

async function 调用发送(params) {
  const ctx = 当前上下文;
  if (!ctx?.actions) return null;
  try {
    const r = await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager?.config);
    // 有些宿主把协议端错误包装成返回值而不是 reject（retcode != 0 / status:'failed'），
    // 调用方只看异常会以为发成功了 → 这里直接抛出去，让语音回退文本那条分支真的能生效。
    if (r && typeof r === 'object') {
      const o = r;
      const bad = (o.status === 'failed')
        || (o.retcode != null && Number(o.retcode) !== 0)
        || Boolean(o.error);
      if (bad) {
        throw new Error(String(o.wording || o.message || o.msg || o.error || `send_msg retcode=${o.retcode}`));
      }
    }
    return r;
  } catch (error) {
    ctx.logger?.error?.('发送消息失败:', error);
    throw error;
  }
}

export async function 发消息(event, message, extra = {}) {
  const segments = 规范化消息段(message);
  if (!segments.length) return null;
  const params = 构建发送参数(event, segments);
  if (event.message_type === 'private') {
    const gid = extra.group_id ?? event.group_id;
    if (gid != null && String(gid).trim() !== '') {
      const n = Number(gid);
      params.group_id = Number.isFinite(n) ? n : gid;
    }
  }
  return 调用发送(params);
}

export async function 设消息表情(messageId, emojiId) {
  const ctx = 当前上下文;
  if (!ctx?.actions) return null;
  const mid = messageId == null ? '' : String(messageId).trim();
  const eid = emojiId == null ? '' : String(emojiId).trim();
  if (!mid || !eid) return null;
  try {
    return await ctx.actions.call(
      'set_msg_emoji_like',
      { message_id: mid, emoji_id: eid, set: true },
      ctx.adapterName,
      ctx.pluginManager?.config,
    );
  } catch (error) {
    ctx.logger?.warn?.('贴表情失败:', error?.message || error);
    return null;
  }
}

export async function BOTAPI(ctx, action, params = {}) {
  const c = ctx || 当前上下文;
  if (!c?.actions) throw new Error('actions.call 不可用');
  try {
    const result = await c.actions.call(action, params || {}, c.adapterName, c.pluginManager?.config);
    if (result && typeof result === 'object' && result.retcode != null && Number(result.retcode) !== 0) {
      c.logger?.warn?.(`[BOTAPI] ${action} 失败: ${result.wording || result.message || result.retcode}`);
    }
    return result;
  } catch (error) {
    if (typeof error === 'object' && error?.message?.includes?.('No data returned')) {
      return { status: 'ok', retcode: 0, data: null };
    }
    throw error;
  }
}

/**
 * 入站语音段的占位文案。
 *
 * 语音段本身没有可读正文，但不能像以前那样整段丢掉——否则用户在群里发的语音
 * 在后台「会话」里完全不可见，模型也无从知道对方发了语音。
 * 统一记成 `[语音]`：有 NapCat 附带的转写文本（data.text）时接在后面成 `[语音]正文`。
 * 注意不要写成 `<voice>`：那个标记在出站历史里代表「机器人自己用语音说了这句」，
 * 重复使用会让模型把自己的语音和用户的语音搞混。
 */
export function 段_入站语音占位(data) {
  const t = String(data?.text ?? '').trim();
  return t ? `[语音]${t}` : '[语音]';
}

export function eventUserTextFromSegments(event) {
  const e = event || {};
  if (Array.isArray(e.message)) {
    const parts = [];
    for (const seg of e.message) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'text' && seg.data?.text != null) parts.push(String(seg.data.text));
      // 语音（record）段：记占位，别整段丢
      else if (seg.type === 'record') parts.push(段_入站语音占位(seg.data));
    }
    return parts.join('');
  }
  if (typeof e.message === 'string') {
    const s = e.message;
    if (s && !/\[CQ:/i.test(s)) return s;
  }
  if (typeof e.raw_message === 'string' && !/\[CQ:/i.test(e.raw_message)) return e.raw_message;
  return '';
}
