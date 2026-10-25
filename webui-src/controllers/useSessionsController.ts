import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MkaiApiClient } from '../api';
import type { ConfirmFn, ToastFn } from '../notify';
import { sessionToBubbles, type ChatBubble, type SessionDetail } from '../sessionTranscript';

export type SessionRow = {
  chatId: string;
  messageCount?: number;
  config_fingerprint?: string;
  group_name?: string;
  group_id?: string;
  chat_type?: string;
  bot_standing?: string;
  bot_role_label?: string;
  /** 当前配置指纹下的会话 */
  active?: boolean;
};

function shortId(id: string): string {
  const s = String(id || '');
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

export function sessionTitle(s: SessionRow): string {
  if (s.group_name) return s.group_name;
  if (s.chat_type === 'private') return shortId(s.chatId.replace(/^p_/, ''));
  return shortId(s.chatId);
}

export function peerIdFromChat(s: SessionRow): { kind: 'group' | 'private'; id: string } {
  if (s.chat_type === 'private' || String(s.chatId).startsWith('p_')) {
    const id = String(s.group_id || s.chatId.replace(/^p_/, '')).replace(/\D/g, '');
    return { kind: 'private', id };
  }
  const id = String(s.group_id || s.chatId.replace(/^g_/, '')).replace(/\D/g, '');
  return { kind: 'group', id };
}

export function isPrivateRow(s: SessionRow): boolean {
  return s.chat_type === 'private' || String(s.chatId).startsWith('p_');
}

export function rowKey(s: SessionRow): string {
  return `${s.config_fingerprint || 'na'}:${s.chatId}`;
}

function sortSessions(list: SessionRow[]): SessionRow[] {
  return [...list].sort((a, b) => {
    const ap = isPrivateRow(a) ? 0 : 1;
    const bp = isPrivateRow(b) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const aa = a.active ? 0 : 1;
    const ba = b.active ? 0 : 1;
    if (aa !== ba) return aa - ba;
    const ta = sessionTitle(a);
    const tb = sessionTitle(b);
    const byName = ta.localeCompare(tb, 'zh');
    if (byName) return byName;
    return String(a.chatId).localeCompare(String(b.chatId));
  });
}

export interface SessionsController {
  sessions: SessionRow[];
  loading: boolean;
  q: string;
  setQ: (v: string) => void;
  showEmpty: boolean;
  setShowEmpty: (v: boolean) => void;
  pruning: boolean;
  active: SessionRow | null;
  detail: SessionDetail | null;
  loadingChat: boolean;
  botUserId: string;
  filtered: SessionRow[];
  bubbles: ChatBubble[];
  loadSessions: () => Promise<void>;
  pruneEmpty: () => Promise<void>;
  openChat: (row: SessionRow) => Promise<void>;
  backToList: () => void;
  deleteSession: (row: SessionRow) => Promise<void>;
}

/** 会话管理数据层：列表 / 过滤 / 会话详情气泡 / 清理与删除，全部 api 调用集中于此 */
export function useSessionsController({
  api,
  toast,
  confirm,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}): SessionsController {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [active, setActive] = useState<SessionRow | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [botUserId, setBotUserId] = useState('');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const query = showEmpty ? { includeEmpty: '1' } : undefined;
      const r = await api.get<{ list?: SessionRow[] }>('/smart-chat/sessions', query);
      setSessions(r.data?.list || []);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setLoading(false);
    }
  }, [api, showEmpty, toast]);

  const pruneEmpty = useCallback(async () => {
    const ok = await confirm({
      title: '清理空会话',
      message: '将删除无消息、无摘要的幽灵会话文件。有历史内容的会话不受影响。',
      danger: true,
      okText: '清理',
    });
    if (!ok) return;
    setPruning(true);
    try {
      const r = await api.post<{ removedFiles?: number; removedNamespaces?: number }>(
        '/smart-chat/sessions/prune',
        { removeEmptyNamespaces: true },
      );
      const n = Number(r.data?.removedFiles || 0);
      toast(n ? `已清理 ${n} 个空会话` : '没有可清理的空会话', 'ok');
      await loadSessions();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setPruning(false);
    }
  }, [api, confirm, loadSessions, toast]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.get<{ bot_user_id?: string }>('/smart-chat/config');
        setBotUserId(String(r.data?.bot_user_id || '').trim());
      } catch {
        /* ignore */
      }
    })();
  }, [api]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let base = sessions;
    if (!showEmpty) {
      base = base.filter((s) => Number(s.messageCount || 0) > 0);
    }
    if (needle) {
      base = base.filter((s) => {
        const blob = [
          s.group_name,
          s.chatId,
          s.group_id,
          s.chat_type,
          s.active ? '正常' : '非当前',
          isPrivateRow(s) ? '好友' : '群聊',
        ]
          .join(' ')
          .toLowerCase();
        return blob.includes(needle);
      });
    }
    return sortSessions(base);
  }, [sessions, q, showEmpty]);

  const bubbles: ChatBubble[] = useMemo(() => sessionToBubbles(detail), [detail]);

  const openChat = useCallback(
    async (row: SessionRow) => {
      setActive(row);
      setDetail(null);
      setLoadingChat(true);
      try {
        const query: Record<string, string> = { chatId: row.chatId };
        if (row.config_fingerprint) query.fingerprint = row.config_fingerprint;
        const r = await api.get<{ session?: SessionDetail }>('/smart-chat/session', query);
        setDetail(r.data?.session || null);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'err');
        setActive(null);
      } finally {
        setLoadingChat(false);
      }
    },
    [api, toast],
  );

  const backToList = useCallback(() => {
    setActive(null);
    setDetail(null);
  }, []);

  const deleteSession = useCallback(
    async (row: SessionRow) => {
      const ok = await confirm({
        title: '删除会话',
        message: `确定删除该会话？`,
        danger: true,
        okText: '删除',
      });
      if (!ok) return;
      try {
        await api.post('/smart-chat/session/clear', {
          chatId: row.chatId,
          fingerprint: row.config_fingerprint || undefined,
        });
        toast('会话已删除', 'ok');
        if (active && rowKey(active) === rowKey(row)) {
          setActive(null);
          setDetail(null);
        }
        // 追加询问：是否删除该会话在其他配置指纹下的历史数据
        const alsoOthers = await confirm({
          title: '删除其他会话数据',
          message: '是否同时删除该会话在其他配置下的历史数据？此操作不可恢复。',
          danger: true,
          okText: '一并删除',
          cancelText: '仅删本条',
        });
        if (alsoOthers) {
          const r = await api.post<{ removed?: number }>(
            '/smart-chat/session/clear-others',
            {
              chatId: row.chatId,
              keepFingerprint: row.config_fingerprint || undefined,
            },
          );
          const n = Number(r.data?.removed || 0);
          toast(n ? `已额外删除 ${n} 条其他会话数据` : '没有其他会话数据', 'ok');
        }
        await loadSessions();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'err');
      }
    },
    [active, api, confirm, loadSessions, toast],
  );

  return {
    sessions,
    loading,
    q,
    setQ,
    showEmpty,
    setShowEmpty,
    pruning,
    active,
    detail,
    loadingChat,
    botUserId,
    filtered,
    bubbles,
    loadSessions,
    pruneEmpty,
    openChat,
    backToList,
    deleteSession,
  };
}