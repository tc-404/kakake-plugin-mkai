import { useCallback, useEffect, useRef, useState } from 'react';
import type { MkaiApiClient } from '../../api';
import { useLiquidIndicator } from '../../hooks/useLiquidIndicator';
import type { ConfirmFn, ToastFn } from '../../notify';

export type BlTab = 'group' | 'user';

/** 黑户管理逻辑层：状态 + 请求，供桌面 / 手机视图共用 */
export function useBlacklistController({
  api,
  toast,
  confirm,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}) {
  const [tab, setTab] = useState<BlTab>('group');
  const [ids, setIds] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const tabIndex = tab === 'group' ? 0 : 1;
  const tabLiquid = useLiquidIndicator(tabIndex, 2, tab);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ type?: string; ids?: string[] }>('/smart-chat/blacklist', { type: tab });
      if (r.code !== 0) throw new Error(r.message || '加载失败');
      setIds(r.data?.ids || []);
    } catch (e) {
      toastRef.current(e instanceof Error ? e.message : String(e));
      setIds([]);
    } finally {
      setLoading(false);
    }
  }, [api, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const addIds = async () => {
    const parts = input
      .split(/[,，\s\n]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{5,15}$/.test(s));
    if (!parts.length) {
      toast('请输入有效 QQ 号/群号（5～15 位数字）', 'warn');
      return;
    }
    try {
      const r = await api.post<{ ids?: string[] }>('/smart-chat/blacklist', {
        type: tab,
        action: 'add',
        ids: parts,
      });
      if (r.code !== 0) throw new Error(r.message || '添加失败');
      setIds(r.data?.ids || []);
      setInput('');
      toast(`已加入 ${parts.length} 个黑户`, 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  const removeId = async (id: string) => {
    const ok = await confirm({
      title: '移除黑户',
      message: `确定将 ${id} 移出黑户？`,
      danger: true,
      okText: '移除',
    });
    if (!ok) return;
    try {
      const r = await api.post<{ ids?: string[] }>('/smart-chat/blacklist', {
        type: tab,
        action: 'remove',
        ids: [id],
      });
      if (r.code !== 0) throw new Error(r.message || '移除失败');
      setIds(r.data?.ids || []);
      toast('已移除', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  return { tab, setTab, ids, input, setInput, loading, tabLiquid, addIds, removeId };
}

export type BlacklistController = ReturnType<typeof useBlacklistController>;