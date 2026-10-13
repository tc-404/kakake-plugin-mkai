import { useCallback, useEffect, useState } from 'react';
import type { MkaiApiClient } from '../api';
import {
  getSmartChatVendorPreset,
  inferVendorFromConfig,
  type SmartChatConfig,
} from '../smartChatLogic';
import { readBalance, invalidateBalance } from '../hooks/useBalance';

export type ConnState = 'idle' | 'checking' | 'ok' | 'fail';

export interface AdminStatus {
  loading: boolean;
  vendorName: string;
  modelLabel: string;
  balanceLabel: string;
  balanceTone: 'ok' | 'warn' | 'muted';
  conn: ConnState;
  connLatency: number | null;
  refresh: () => Promise<void>;
  probe: () => Promise<void>;
}

function lastSeg(id: string): string {
  const s = String(id || '').trim();
  if (!s) return '—';
  return s.split('/').pop() || s;
}

/**
 * 顶部状态条数据：当前厂商 / 模型、余额或限速、连通状态。轻量、静默（不弹 toast）。
 *
 * 两条性能约定：
 *  1. 余额走共享的 readBalance（模块缓存 + 单飞），与总览页复用同一次结果 ——
 *     不再出现「同一帧内两处各打一次外部余额接口」的浪费。
 *  2. config 一到就放掉 loading，余额慢不该让顶部三个芯片一直显示「···」。
 */
export function useAdminStatus(api: MkaiApiClient): AdminStatus {
  const [loading, setLoading] = useState(true);
  const [vendorName, setVendorName] = useState('—');
  const [modelLabel, setModelLabel] = useState('—');
  const [balanceLabel, setBalanceLabel] = useState('…');
  const [balanceTone, setBalanceTone] = useState<'ok' | 'warn' | 'muted'>('muted');
  const [conn, setConn] = useState<ConnState>('idle');
  const [connLatency, setConnLatency] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    let cfg: SmartChatConfig = {};
    try {
      const cr = await api.get<SmartChatConfig>('/smart-chat/config');
      cfg = cr?.data || {};
    } catch {
      // 配置拿不到也要继续：至少别让余额芯片永远停在「…」
      cfg = {};
    }
    const vendor = inferVendorFromConfig(cfg);
    const preset = getSmartChatVendorPreset(vendor, cfg.custom_vendors || []);
    setVendorName(String(preset?.name || cfg.vendor || '—'));
    setModelLabel(lastSeg(String(cfg.model || '')));
    // config 已就位 → 顶部立刻可读，剩下的只等余额
    setLoading(false);

    try {
      // 不强刷：优先吃总览页可能已经拉好的缓存；缓存过期才真发请求
      const snap = await readBalance(api, cfg, { force: false });
      setBalanceLabel(snap.label);
      setBalanceTone(snap.tone);
    } catch {
      setBalanceLabel('—');
      setBalanceTone('muted');
    }
  }, [api]);

  const probe = useCallback(async () => {
    setConn('checking');
    try {
      const r = await api.post<{ ok?: boolean; latency_ms?: number }>('/smart-chat/test', {});
      const ok = r.code === 0 && !!r.data?.ok;
      setConn(ok ? 'ok' : 'fail');
      setConnLatency(typeof r.data?.latency_ms === 'number' ? r.data.latency_ms : null);
    } catch {
      setConn('fail');
      setConnLatency(null);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    loading,
    vendorName,
    modelLabel,
    balanceLabel,
    balanceTone,
    conn,
    connLatency,
    refresh,
    probe,
  };
}

/** 配置保存后调用：让顶部状态条与总览页都拿到最新余额 */
export function invalidateAdminBalance(): void {
  invalidateBalance();
}
