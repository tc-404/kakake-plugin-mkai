import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { MkaiApiClient } from '../api';
import type { ToastFn } from '../notify';
import {
  DEFAULT_SWITCH_STATE,
  normalizeScRoundsInput,
  type SwitchState,
} from '../smartChatLogic';

export type SwitchTab = 'group' | 'friend';

export type EntityItem = {
  id: string;
  name: string;
};

export type SwitchDraft = {
  type: SwitchTab;
  id: string;
  name: string;
  rounds: number;
  image_recognize: boolean;
  /** 识别文件：仅群聊有效 */
  file_recognize: boolean;
  sticker_output: boolean;
  web_search: boolean;
  at_only: boolean;
  at_only_record: boolean;
  fake_think: boolean;
  allow_voice: boolean;
  system_prompt: string;
};

type GroupRow = { group_id?: string; group_name?: string };
type FriendRow = { user_id?: string; nickname?: string };

export interface SwitchController {
  tab: SwitchTab;
  setTab: (t: SwitchTab) => void;
  loading: boolean;
  list: EntityItem[];
  switchMap: Record<string, SwitchState>;
  search: string;
  setSearch: (v: string) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  stickerGalleryReady: boolean;
  globalSystemPrompt: string;
  modalOpen: boolean;
  setModalOpen: (v: boolean) => void;
  draft: SwitchDraft;
  setDraft: Dispatch<SetStateAction<SwitchDraft>>;
  filtered: EntityItem[];
  loadPage: () => Promise<void>;
  refreshStickerReady: () => Promise<void>;
  toggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  openModal: (id: string, name: string) => Promise<void>;
  saveModal: () => Promise<void>;
}

/** 聊天开关数据层：群/好友清单、开关映射、单项设置弹层草稿与全部保存请求 */
export function useSwitchController({
  api,
  toast,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
}): SwitchController {
  const [tab, setTab] = useState<SwitchTab>('group');
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<EntityItem[]>([]);
  const [switchMap, setSwitchMap] = useState<Record<string, SwitchState>>({});
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [stickerGalleryReady, setStickerGalleryReady] = useState(false);
  const [globalSystemPrompt, setGlobalSystemPrompt] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<SwitchDraft>({
    type: 'group',
    id: '',
    name: '',
    rounds: 0,
    image_recognize: false,
    file_recognize: false,
    sticker_output: false,
    web_search: false,
    at_only: false,
    at_only_record: true,
    fake_think: false,
    allow_voice: false,
    system_prompt: '',
  });

  const toastRef = useRef(toast);
  toastRef.current = toast;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((it) => it.name.toLowerCase().includes(q) || it.id.includes(q));
  }, [list, search]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    try {
      let entities: EntityItem[] = [];
      if (tab === 'group') {
        const gr = await api.get<{ groups?: GroupRow[] }>('/groups');
        entities = (gr.data?.groups || [])
          .map((g) => ({
            id: String(g.group_id || ''),
            name: String(g.group_name || '未知群聊'),
          }))
          .filter((x) => x.id);
      } else {
        const fr = await api.get<{ friends?: FriendRow[] }>('/friends');
        entities = (fr.data?.friends || [])
          .map((f) => ({
            id: String(f.user_id || ''),
            name: String(f.nickname || '未知好友'),
          }))
          .filter((x) => x.id);
      }
      setList(entities);
      const ids = entities.map((x) => x.id).join(',');
      const sw = await api.get<{
        map?: Record<string, SwitchState>;
        sticker_gallery_ready?: boolean;
        global_system_prompt?: string;
      }>(
        '/smart-chat/switches',
        { type: tab, ids: ids || undefined },
      );
      setSwitchMap(sw.data?.map || {});
      if (sw.data?.global_system_prompt != null) {
        setGlobalSystemPrompt(String(sw.data.global_system_prompt || ''));
      }
      if (sw.data?.sticker_gallery_ready != null) {
        setStickerGalleryReady(!!sw.data.sticker_gallery_ready);
      }
    } catch (e) {
      toastRef.current(e instanceof Error ? e.message : String(e));
      setList([]);
    } finally {
      setLoading(false);
    }
  }, [api, tab]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const refreshStickerReady = useCallback(async () => {
    try {
      const r = await api.get<{ ready?: boolean }>('/smart-chat/sticker/galleries');
      setStickerGalleryReady(!!r.data?.ready);
    } catch {
      /* ignore */
    }
  }, [api]);

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const prev = switchMap[id] || DEFAULT_SWITCH_STATE;
      setSwitchMap((m) => ({ ...m, [id]: { ...prev, enabled, ai_only: false } }));
      try {
        const r = await api.post('/smart-chat/switches/set', {
          type: tab,
          id,
          enabled,
          ai_only: false,
          rounds: prev.rounds,
          image_recognize: prev.image_recognize,
          file_recognize: prev.file_recognize,
          sticker_output: prev.sticker_output,
          web_search: prev.web_search,
        });
        if (r.code !== 0) throw new Error(r.message || '保存失败');
        toast(enabled ? '已开启' : '已关闭', 'ok');
      } catch (e) {
        setSwitchMap((m) => ({ ...m, [id]: prev }));
        toast(e instanceof Error ? e.message : String(e), 'err');
        throw e;
      }
    },
    [api, switchMap, tab, toast],
  );

  const openModal = useCallback(
    async (id: string, name: string) => {
      void refreshStickerReady();
      const st = switchMap[id] || DEFAULT_SWITCH_STATE;
      const override = String(st.system_prompt || '').trim();
      setDraft({
        type: tab,
        id,
        name,
        rounds: normalizeScRoundsInput(st.rounds),
        image_recognize: !!st.image_recognize,
        file_recognize: !!st.file_recognize,
        sticker_output: !!st.sticker_output,
        web_search: !!st.web_search,
        at_only: !!st.at_only,
        at_only_record: st.at_only_record !== false,
        fake_think: !!st.fake_think,
        allow_voice: !!st.allow_voice,
        system_prompt: override || globalSystemPrompt,
      });
      setModalOpen(true);
    },
    [globalSystemPrompt, refreshStickerReady, switchMap, tab],
  );

  const saveModal = useCallback(async () => {
    try {
      const r = await api.post<{
        system_prompt?: string;
        persona_fingerprint_changed?: boolean;
        global_system_prompt?: string;
      }>('/smart-chat/switches/set', {
        type: draft.type,
        id: draft.id,
        enabled: !!(switchMap[draft.id] || DEFAULT_SWITCH_STATE).enabled,
        ai_only: false,
        rounds: normalizeScRoundsInput(draft.rounds),
        image_recognize: draft.image_recognize,
        file_recognize: draft.file_recognize,
        sticker_output: draft.sticker_output,
        web_search: draft.web_search,
        at_only: draft.at_only,
        at_only_record: draft.at_only_record,
        fake_think: draft.fake_think,
        allow_voice: draft.allow_voice,
        system_prompt: draft.system_prompt,
      });
      if (r.code !== 0) throw new Error(r.message || '保存失败');
      if (r.data?.global_system_prompt != null) {
        setGlobalSystemPrompt(String(r.data.global_system_prompt || ''));
      }
      setSwitchMap((m) => ({
        ...m,
        [draft.id]: {
          ...(m[draft.id] || DEFAULT_SWITCH_STATE),
          ai_only: false,
          rounds: normalizeScRoundsInput(draft.rounds),
          image_recognize: draft.image_recognize,
          file_recognize: draft.file_recognize,
          sticker_output: draft.sticker_output,
          web_search: draft.web_search,
          at_only: draft.at_only,
          at_only_record: draft.at_only_record,
          fake_think: draft.fake_think,
          allow_voice: draft.allow_voice,
          system_prompt: String(r.data?.system_prompt ?? '').trim(),
        },
      }));
      setModalOpen(false);
      if (r.data?.persona_fingerprint_changed) {
        toast('已保存（人设变更，会话命名空间已切换）', 'ok');
      } else {
        toast('已保存', 'ok');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }, [api, draft, switchMap, toast]);

  return {
    tab,
    setTab,
    loading,
    list,
    switchMap,
    search,
    setSearch,
    searchOpen,
    setSearchOpen,
    stickerGalleryReady,
    globalSystemPrompt,
    modalOpen,
    setModalOpen,
    draft,
    setDraft,
    filtered,
    loadPage,
    refreshStickerReady,
    toggleEnabled,
    openModal,
    saveModal,
  };
}