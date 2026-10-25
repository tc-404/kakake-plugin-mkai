import { useCallback, useEffect, useState } from 'react';
import type { ApiResult, MkaiApiClient } from '../api';
import { readBalance, readBalanceSyncSnapshot } from '../hooks/useBalance';
import {
  getSmartChatVendorPreset,
  inferVendorFromConfig,
  type SmartChatConfig,
  type SwitchState,
  type VendorId,
} from '../smartChatLogic';
import { isPrivateRow, sessionTitle, type SessionRow } from './useSessionsController';
import type { ToolSkill } from './useConfigController';

interface UsageSummary {
  total_requests?: number;
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_tokens?: number;
  total_cache_hit_tokens?: number;
  total_estimated_cost?: number;
  cache_hit_rate_percent?: number | null;
  today?: {
    requests?: number;
    total_tokens?: number;
    estimated_cost?: number;
  };
}

export interface OverviewStats {
  vendor: VendorId;
  vendorName: string;
  modelLabel: string;
  botNickname: string;
  customVendorCount: number;
  totalRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitRate: number | null;
  todayRequests: number;
  todayTokens: number;
  estimatedCost: number;
  balanceLabel: string;
  balancePct: number | null;
  balanceAvailable: boolean;
  /**
   * 余额语气。与共享快照的 tone 保持同域：'muted' 表示「暂无数据 / 未配置」，
   * 此前类型只允许 ok|warn，而 .ov-bignum--muted 样式早已存在（属于写好了没用上）。
   */
  balanceTone: 'ok' | 'warn' | 'muted';
  balanceIsRate: boolean;
  sessionsTotal: number;
  sessionsActive: number;
  sessionsGroup: number;
  sessionsPrivate: number;
  totalMessages: number;
  topSessions: { label: string; value: number }[];
  msgSeries: number[];
  groupTotal: number;
  groupEnabled: number;
  friendTotal: number;
  friendEnabled: number;
  capImage: number;
  capWeb: number;
  capSticker: number;
  toolTotal: number;
  toolEnabled: number;
  stickerReady: boolean;
}

const EMPTY: OverviewStats = {
  vendor: 'deepseek',
  vendorName: '—',
  modelLabel: '—',
  botNickname: '',
  customVendorCount: 0,
  totalRequests: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitRate: null,
  todayRequests: 0,
  todayTokens: 0,
  estimatedCost: 0,
  balanceLabel: '…',
  balancePct: null,
  balanceAvailable: false,
  balanceTone: 'warn',
  balanceIsRate: false,
  sessionsTotal: 0,
  sessionsActive: 0,
  sessionsGroup: 0,
  sessionsPrivate: 0,
  totalMessages: 0,
  topSessions: [],
  msgSeries: [],
  groupTotal: 0,
  groupEnabled: 0,
  friendTotal: 0,
  friendEnabled: 0,
  capImage: 0,
  capWeb: 0,
  capSticker: 0,
  toolTotal: 0,
  toolEnabled: 0,
  stickerReady: false,
};

function lastSeg(id: string): string {
  const s = String(id || '').trim();
  if (!s) return '—';
  return s.split('/').pop() || s;
}

type GroupRow = { group_id?: string; group_name?: string };
type FriendRow = { user_id?: string; nickname?: string };
type SwitchMapResp = { map?: Record<string, SwitchState>; sticker_gallery_ready?: boolean };

/** 概览数据层：聚合配置 / 用量 / 会话 / 开关覆盖 / 能力，全部静默容错（不弹 toast）。 */
export function useOverviewController(api: MkaiApiClient): {
  loading: boolean;
  stats: OverviewStats;
  refresh: () => Promise<void>;
} {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<OverviewStats>(EMPTY);

  /**
   * 首屏刷新。
   *
   * 性能铁律（踩过的坑都写在这）：
   *  1. **一次 setState 提交**。以前是「骨架屏 → 第一批 setStats(非余额) → setLoading(false)
   *     → 余额回来再 setStats」，等于整页重排两次；而卡片用了 backdrop-filter，
   *     每次重排都要重新采样合成层。现在首屏只提交一次，余额另行落盘、不碰布局骨架。
   *  2. **余额绝不在关键路径上**。它打外部 API（可能超时），页面必须先把本地数据画出来。
   *  3. **余额走共享缓存**。顶部状态条也在读同一个快照，两处复用一次外部往返。
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // 第一批：全部是本地宿主接口，彼此并行
      const [cfgR, usageR, sesR, grpR, frdR, toolR] = await Promise.all([
        api.get<SmartChatConfig>('/smart-chat/config').then(r => r, () => undefined),
        api.get<UsageSummary>('/smart-chat/usage').then(r => r, () => undefined),
        api.get<{ list?: SessionRow[] }>('/smart-chat/sessions').then(r => r, () => undefined),
        api.get<{ groups?: GroupRow[] }>('/groups').then(r => r, () => undefined),
        api.get<{ friends?: FriendRow[] }>('/friends').then(r => r, () => undefined),
        api.get<{ tools?: ToolSkill[] }>('/smart-chat/tool-skills').then(r => r, () => undefined),
      ]);

      const cfg = cfgR?.data || {};
      const vendor = inferVendorFromConfig(cfg);
      const preset = getSmartChatVendorPreset(vendor, cfg.custom_vendors || []);
      const usage = usageR?.data || {};
      const list = sesR?.data?.list || [];
      const groups = (grpR?.data?.groups || []).map((g) => String(g.group_id || '')).filter(Boolean);
      const friends = (frdR?.data?.friends || []).map((f) => String(f.user_id || '')).filter(Boolean);
      const tools = toolR?.data?.tools || [];

      // 第二批：开关覆盖必须等 groups/friends 的 id 列表，这层依赖绕不开（已是并行）
      const emptyMap: ApiResult<SwitchMapResp> = { code: 0, data: { map: {} } };
      const [gSwR, fSwR] = await Promise.all([
        groups.length
          ? api.get<SwitchMapResp>('/smart-chat/switches', { type: 'group', ids: groups.join(',') }).then(r => r, () => undefined)
          : Promise.resolve(emptyMap),
        friends.length
          ? api.get<SwitchMapResp>('/smart-chat/switches', { type: 'friend', ids: friends.join(',') }).then(r => r, () => undefined)
          : Promise.resolve(emptyMap),
      ]);
      const gSw = gSwR?.data || {};
      const fSw = fSwR?.data || {};
      const gMap = gSw.map || {};
      const fMap = fSw.map || {};

      let groupEnabled = 0;
      let friendEnabled = 0;
      let capImage = 0;
      let capWeb = 0;
      let capSticker = 0;
      const countCaps = (st?: SwitchState) => {
        if (!st?.enabled) return;
        if (st.image_recognize) capImage += 1;
        if (st.web_search) capWeb += 1;
        if (st.sticker_output) capSticker += 1;
      };
      for (const id of groups) {
        if (gMap[id]?.enabled) groupEnabled += 1;
        countCaps(gMap[id]);
      }
      for (const id of friends) {
        if (fMap[id]?.enabled) friendEnabled += 1;
        countCaps(fMap[id]);
      }

      const withMsg = list.filter((s) => Number(s.messageCount || 0) > 0);
      let sessionsGroup = 0;
      let sessionsPrivate = 0;
      let totalMessages = 0;
      for (const s of withMsg) {
        if (isPrivateRow(s)) sessionsPrivate += 1;
        else sessionsGroup += 1;
        totalMessages += Number(s.messageCount || 0);
      }
      const ranked = [...withMsg].sort(
        (a, b) => Number(b.messageCount || 0) - Number(a.messageCount || 0),
      );
      const topSessions = ranked
        .slice(0, 5)
        .map((s) => ({ label: sessionTitle(s), value: Number(s.messageCount || 0) }));
      const msgSeries = ranked
        .slice(0, 24)
        .map((s) => Number(s.messageCount || 0))
        .reverse();

      // 余额先取共享快照：若顶部状态条已经拉过就是同步命中，零成本带上
      const cachedBal = readBalanceSyncSnapshot();

      // 唯一的 setStats：首屏一次性成型，避免二次重排
      setStats({
        vendor,
        vendorName: String(preset?.name || cfg.vendor || '—'),
        modelLabel: lastSeg(String(cfg.model || '')),
        botNickname: String(cfg.bot_nickname || '').trim(),
        customVendorCount: (cfg.custom_vendors || []).length,
        totalRequests: Number(usage.total_requests || 0),
        totalTokens: Number(usage.total_tokens || 0),
        promptTokens: Number(usage.total_prompt_tokens || 0),
        completionTokens: Number(usage.total_completion_tokens || 0),
        cacheHitRate: usage.cache_hit_rate_percent ?? null,
        todayRequests: Number(usage.today?.requests || 0),
        todayTokens: Number(usage.today?.total_tokens || 0),
        estimatedCost: Number(usage.total_estimated_cost || 0),
        sessionsTotal: withMsg.length,
        sessionsActive: withMsg.filter((s) => s.active).length,
        sessionsGroup,
        sessionsPrivate,
        totalMessages,
        topSessions,
        msgSeries,
        groupTotal: groups.length,
        groupEnabled,
        friendTotal: friends.length,
        friendEnabled,
        capImage,
        capWeb,
        capSticker,
        toolTotal: tools.length,
        toolEnabled: tools.filter((t) => t.enabled).length,
        stickerReady: !!gSw.sticker_gallery_ready,
        balanceLabel: cachedBal?.label ?? EMPTY.balanceLabel,
        balancePct: cachedBal?.pct ?? EMPTY.balancePct,
        balanceAvailable: cachedBal?.available ?? EMPTY.balanceAvailable,
        balanceTone: cachedBal?.tone ?? EMPTY.balanceTone,
        balanceIsRate: cachedBal?.isRate ?? false,
      });
      setLoading(false);

      // 余额补齐：同样走共享缓存；命中就不产生任何网络请求
      try {
        const snap = await readBalance(api, cfg, { force: false });
        setStats((prev) => ({
          ...prev,
          balanceLabel: snap.label,
          balancePct: snap.pct,
          balanceAvailable: snap.available,
          balanceTone: snap.tone,
          balanceIsRate: snap.isRate,
        }));
      } catch {
        /* 余额拿不到就保持占位，不影响其余卡片 */
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { loading, stats, refresh };
}