// @ts-nocheck
import type { SmartChatDeps } from '../auth/smart-chat-types.js';
import { registerSmartChatWebGetRoutes, registerSmartChatWebPostRoutes } from '../auth/smart-chat-web.js';
import { BOTAPI } from './bot.js';

const ROUTE_PREFIX = '/mkai';

function wrapPath(p: string): string {
  if (!p) return ROUTE_PREFIX;
  return p.startsWith('/') ? `${ROUTE_PREFIX}${p}` : `${ROUTE_PREFIX}/${p}`;
}

function extractListPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.data)) return o.data;
  if (o.data && typeof o.data === 'object') {
    const d = o.data as Record<string, unknown>;
    if (Array.isArray(d.group_list)) return d.group_list;
    if (Array.isArray(d.friend_list)) return d.friend_list;
    if (Array.isArray(d.list)) return d.list;
  }
  if (Array.isArray(o.group_list)) return o.group_list;
  if (Array.isArray(o.friend_list)) return o.friend_list;
  return [];
}

export function registerMkaiWebui(ctx: any, deps: SmartChatDeps): void {
  const base = ctx?.router;
  if (!base?.get || !base?.post) {
    ctx?.logger?.warn?.('[智能对话] 当前主机未提供 router，跳过后台注册');
    return;
  }

  if (base.static) {
    base.static(wrapPath('/static'), 'webui');
  }

  if (base.page) {
    base.page({
      path: 'admin',
      title: '智能对话',
      module: 'webui/remote.js'.replace(/\\/g, '/'),
      kind: 'module',
      description: '配置聊天 · 聊天开关（Kakake React 模块）',
    });
  }

  base.get(wrapPath('/groups'), async (_req, res) => {
    try {
      const raw = await BOTAPI(ctx, 'get_group_list', {});
      const list = extractListPayload(raw).map((g: any) => ({
        group_id: String(g?.group_id ?? g?.id ?? ''),
        group_name: String(g?.group_name ?? g?.name ?? g?.group_id ?? ''),
      })).filter((g) => g.group_id);
      res.json({ code: 0, data: { groups: list } });
    } catch (e) {
      ctx?.logger?.error?.('[智能对话] get_group_list 失败:', e);
      res.status(500).json({ code: -1, message: '获取群列表失败' });
    }
  });

  base.get(wrapPath('/friends'), async (_req, res) => {
    try {
      const raw = await BOTAPI(ctx, 'get_friend_list', {});
      const list = extractListPayload(raw).map((f: any) => ({
        user_id: String(f?.user_id ?? f?.uin ?? f?.id ?? ''),
        nickname: String(f?.nickname ?? f?.remark ?? f?.user_id ?? ''),
      })).filter((f) => f.user_id);
      res.json({ code: 0, data: { friends: list } });
    } catch (e) {
      ctx?.logger?.error?.('[智能对话] get_friend_list 失败:', e);
      res.status(500).json({ code: -1, message: '获取好友列表失败' });
    }
  });

  registerSmartChatWebGetRoutes(base, wrapPath, deps, ctx?.logger);
  registerSmartChatWebPostRoutes(base, wrapPath, deps, ctx?.logger);
}
