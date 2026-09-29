import { useCallback, useEffect, useRef, useState } from 'react';
import type { MkaiApiClient } from '../api';
import {
  computeBalanceBarPct,
  computeBalanceDisplay,
  inferVendorFromConfig,
  type BalanceData,
  type SmartChatConfig,
  type VendorId,
} from '../smartChatLogic';

/**
 * 余额数据的**共享**读取层。
 *
 * 为什么需要它：后台顶部状态条（useAdminStatus）和总览页（useOverviewController）
 * 原本各自独立请求 `/smart-chat/balance`。两者在同一帧挂载、缓存都没命中，
 * 于是外部余额 API 被访问**两遍**，页面得等两次外部往返 —— 这正是「总览页加载很久」
 * 的直接原因之一。收敛到这一层后：
 *
 *   1. 模块级缓存：TTL 内任何消费者都直接复用，不产生网络请求；
 *   2. 模块级在飞表（in-flight）：同一时刻只有一个真实请求，后到的搭车等同一个 Promise；
 *   3. 组件卸载不影响缓存，切页回来秒开。
 *
 * 注意：这只是**前端**去重，用于消除同一页面内的重复调用；跨请求的去重
 * （服务端缓存 + 单飞）在宿主 `fetchBalance` 里，两层配合才能保证外部 API 只打一次。
 */

/** 结果缓存有效期：与宿主 BALANCE_CACHE_MS 对齐，避免前端比后端先过期 */
const CACHE_TTL_MS = 60_000;
/** 前端侧超时兜底：宿主已有 6s 超时，这里略长一点，只防「连宿主都没响应」的极端情况 */
const REQUEST_TIMEOUT_MS = 10_000;

interface BalanceSnapshot {
  data: BalanceData;
  vendor: VendorId;
  /** 供 UI 直接使用的派生字段，避免每个消费者各算一遍 */
  label: string;
  pct: number | null;
  available: boolean;
  tone: 'ok' | 'warn' | 'muted';
  isRate: boolean;
}

let cache: { at: number; snap: BalanceSnapshot } | null = null;
let inFlight: Promise<BalanceSnapshot> | null = null;

/** 单次快照读取：带超时、带静默容错，失败也会返回一个可渲染的「降级快照」 */
async function loadBalance(
  api: MkaiApiClient,
  cfg: SmartChatConfig | undefined,
  force: boolean,
  signal: AbortSignal,
): Promise<BalanceSnapshot> {
  const vendor = inferVendorFromConfig(cfg || {});

  // 组合「调用方取消」与「自身超时」两个信号
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);

  let data: BalanceData = {};
  try {
    const r = await api.get<BalanceData>(
      '/smart-chat/balance',
      force ? { _t: Date.now(), force: 1 } : { _t: Date.now() },
      { signal: ctl.signal },
    );
    data = r?.data || {};
  } catch {
    // 超时 / 网络失败 / 宿主未就绪：都渲染成占位，不弹 toast、不阻塞其它卡片
    data = {};
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }

  const info = data.infos?.[0] || null;
  const label = computeBalanceDisplay(vendor, info, data) || '—';
  const ok = !data.error && (!!info || !!data.available);

  return {
    data,
    vendor,
    label,
    pct: computeBalanceBarPct(vendor, info, data),
    available: !!data.available,
    tone: ok ? 'ok' : 'warn',
    isRate: vendor === 'nvidia',
  };
}

/** 读取余额快照：命中缓存即刻返回，否则发起（或搭车）单飞请求 */
export function readBalance(
  api: MkaiApiClient,
  cfg: SmartChatConfig | undefined,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<BalanceSnapshot> {
  const force = !!opts.force;
  const signal = opts.signal ?? new AbortController().signal;

  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(cache.snap);
  }
  // 强制刷新说明用户想要最新值：作废缓存与在飞请求，自己发起一次
  if (force) {
    cache = null;
  } else if (inFlight) {
    return inFlight;
  }

  const task = loadBalance(api, cfg, force, signal);
  inFlight = task;
  return task
    .then((snap) => {
      cache = { at: Date.now(), snap };
      return snap;
    })
    .finally(() => {
      if (inFlight === task) inFlight = null;
    });
}

/** 外部主动失效（如保存配置后想立刻看到新余额） */
export function invalidateBalance(): void {
  cache = null;
  inFlight = null;
}

/**
 * 纯同步读缓存：命中返回快照，否则 null。
 *
 * 用途是「首屏一次性成型」——总览页在一次 setState 里就要把余额字段填好，
 * 此时若顶部状态条已经拉过余额就能白捡；没有则先用占位，后续再补。
 * 它**永不发请求**，所以放在渲染关键路径上是安全的。
 */
export function readBalanceSyncSnapshot(): BalanceSnapshot | null {
  if (!cache) return null;
  if (Date.now() - cache.at >= CACHE_TTL_MS) return null;
  return cache.snap;
}

/**
 * 组件侧封装：订阅余额快照。
 *
 * 先吃模块缓存（命中则零延迟点亮，避免「明明有数据还先闪占位」），
 * 再按需发起/搭车一次请求。组件卸载不会清缓存，切页回来依旧秒开。
 */
export function useBalance(
  api: MkaiApiClient,
  cfg: SmartChatConfig | undefined,
  opts: { enabled?: boolean; auto?: boolean } = {},
): { snap: BalanceSnapshot | null; refresh: (force?: boolean) => Promise<void> } {
  const enabled = opts.enabled !== false;
  const auto = opts.auto !== false;
  const [snap, setSnap] = useState<BalanceSnapshot | null>(() => cache?.snap ?? null);

  // cfg 每次 refresh 都是新对象引用，用 ref 兜住避免把 effect 变成死循环
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (force = false) => {
      if (!enabled) return;
      try {
        const next = await readBalance(api, cfgRef.current, { force });
        if (aliveRef.current) setSnap(next);
      } catch {
        /* 静默：余额是锦上添花，拿不到不影响主流程 */
      }
    },
    [api, enabled],
  );

  useEffect(() => {
    if (cache?.snap) setSnap(cache.snap);
    if (auto && enabled) void refresh(false);
  }, [auto, enabled, api, refresh]);

  return { snap, refresh };
}
