import { useCallback, useEffect, useRef, useState } from 'react';
import type { MkaiApiClient } from '../api';
import type { ConfirmFn, ToastFn } from '../notify';

export type BlTab = 'group' | 'user';

export interface BlacklistController {
  tab: BlTab;
  setTab: (t: BlTab) => void;
  ids: string[];
  input: string;
  setInput: (v: string) => void;
  loading: boolean;
  reload: () => Promise<void>;
  addIds: () => Promise<void>;
  removeId: (id: string) => Promise<void>;
}

/** 黑户管理数据层：承载 tab / 名单 / 输入 状态与全部 api 调用，视图仅负责呈现 */
export function useBlacklistController({
  api,
  toast,
  confirm,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}): BlacklistController {
  const [tab, setTab] = useState<BlTab>('group');
  const [ids, setIds] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const reload = useCallback(async () => {
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
    void reload();
  }, [reload]);

  const addIds = useCallback(async () => {
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
  }, [api, input, tab, toast]);

  const removeId = useCallback(
    async (id: string) => {
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
    },
    [api, confirm, tab, toast],
  );

  return { tab, setTab, ids, input, setInput, loading, reload, addIds, removeId };
}