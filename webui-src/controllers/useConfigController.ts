import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MkaiApiClient, ViewId } from '../api';
import { invalidateBalance } from '../hooks/useBalance';
import type { ConfirmFn, ToastFn } from '../notify';
import {
  SC_VENDOR_PRESETS,
  SC_WEB_SEARCH_CLEAR_INIT,
  collectConfigPayload,
  collectOnlinePayload,
  collectRotationPayload,
  computeBalanceBadge,
  computeBalanceBarPct,
  computeBalanceDisplay,
  configToContextForm,
  configToModelForm,
  configToRotationForm,
  getBillingLabels,
  getSmartChatVendorPreset,
  imageRecognizeFromConfig,
  inferVendorFromConfig,
  isCustomVendorId,
  newCustomVendorId,
  rememberStickerInstallJob,
  type ApiProtocol,
  type BalanceData,
  type ContextFormState,
  type CustomVendor,
  type ModelFormState,
  type OnlineFormState,
  type RotationFormState,
  type ScVendorId,
  type SmartChatConfig,
  type VendorId,
  type WebSearchProvider,
} from '../smartChatLogic';

/**
 * 配置页可承载的区块。
 *
 * 必须显式排除掉已有独立页面的视图（voice 有 VoicePage、switch/blacklist/sessions/overview
 * 各有专属页），否则往 ViewId 里加一个新页面时，这里会**静默**把新页面也纳入配置页，
 * 导致配置页被要求处理自己根本没有的 section。
 */
export type ConfigSection = Exclude<
  ViewId,
  'switch' | 'blacklist' | 'sessions' | 'overview' | 'voice'
>;

export type ToolSkill = {
  code: string;
  title?: string;
  when?: string;
  params?: string;
  enabled?: boolean;
};

export type GalleryJob = {
  jobId?: string;
  /** 本次安装所用源 */
  source?: string;
  status?: string;
  percent?: number;
  downloaded?: number;
  total?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  etaSec?: number;
  error?: string;
};

export function isGalleryJobRunning(job?: GalleryJob | null): boolean {
  return !!job && ['running', 'pending', 'downloading', 'extracting'].includes(String(job.status || ''));
}

/** 安装源：kakake 服务器 / GitHub 仓库 */
export type StickerSourceId = 'kakake' | 'github';

export type StickerSourceOption = {
  id: StickerSourceId;
  label: string;
  desc: string;
};

/**
 * 安装源选项（单一事实来源在前端，目的是让悬浮窗立刻能画出来，
 * 不用等 /sticker/galleries 返回）。
 *
 * 后端 `listStickerSources()` 返回同一份列表，两者文案保持一致；
 * 真正决定下载地址的是后端按 id 查 `STICKER_GALLERIES[].sources`，
 * 前端即使把 label 改错也不会下错包。
 */
export const STICKER_SOURCES: StickerSourceOption[] = [
  { id: 'kakake', label: 'kakake 服务器', desc: '从插件内置域名下载，国内直连一般更快' },
  { id: 'github', label: 'GitHub 仓库', desc: '从 GitHub Releases 下载，源站更新更及时（可能需代理）' },
];

export const DEFAULT_STICKER_SOURCE: StickerSourceId = 'kakake';

export type GalleryRow = {
  id: string;
  name?: string;
  folder?: string;
  installed?: boolean;
  imageCount?: number;
  activeJob?: GalleryJob | null;
  /** 该图库支持的安装源（后端返回；老版本后端可能没有） */
  sources?: { id: string; label?: string; url?: string; hint?: string }[];
};

/** 由页面注入的「选安装源」弹层；返回 null 表示用户取消 */
export type PickStickerSourceFn = (gallery: GalleryRow) => Promise<StickerSourceId | null>;

/** 源 id → 展示名（认不出来时回落默认源名，绝不显示原始 id 给用户） */
export function stickerSourceLabel(id?: string): string {
  const hit = STICKER_SOURCES.find((s) => s.id === id);
  return hit ? hit.label : STICKER_SOURCES[0].label;
}

export function useConfigController({
  api,
  toast,
  confirm,
  section,
  pickStickerSource,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
  section: ConfigSection;
  /** 可选：页面侧的源选择弹层。不传则一律用默认源。 */
  pickStickerSource?: PickStickerSourceFn;
}) {
  const [cfg, setCfg] = useState<SmartChatConfig>({});
  const [model, setModel] = useState<ModelFormState>(() => configToModelForm({}));
  const [context, setContext] = useState<ContextFormState>(() => configToContextForm({}));
  const [online, setOnline] = useState<OnlineFormState>(() => ({
    toolsMaxRounds: 3,
    imageRecognize: imageRecognizeFromConfig({}),
    keys: { tavily: '', serper: '', bocha: '', mcp: '' },
    mcpEnabled: true,
    mcpEndpoint: '',
  }));
  const [clearFlags, setClearFlags] = useState({ ...SC_WEB_SEARCH_CLEAR_INIT });
  const [rotation, setRotation] = useState<RotationFormState>(() => configToRotationForm({}));
  const [rotationSaving, setRotationSaving] = useState(false);
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [usage, setUsage] = useState<Record<string, unknown>>({});
  const [balance, setBalance] = useState<BalanceData>({});
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [toolSkills, setToolSkills] = useState<ToolSkill[]>([]);
  const [galleries, setGalleries] = useState<GalleryRow[]>([]);
  const [galleryReady, setGalleryReady] = useState(false);
  const [providerStatus, setProviderStatus] = useState<Record<WebSearchProvider, string>>({
    tavily: '',
    serper: '',
    bocha: '',
    mcp: '',
  });
  /** API Key 描边：已配置绿 / 默认 / Key 异常红 */
  const [keyTone, setKeyTone] = useState<'default' | 'ok' | 'err'>('default');
  const [customVendors, setCustomVendors] = useState<CustomVendor[]>([]);
  const [addingCustom, setAddingCustom] = useState(false);
  const [probeLog, setProbeLog] = useState('');
  const [probeBusy, setProbeBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const pollRef = useRef<number | null>(null);
  /** 各厂商上次选中的模型（含已保存配置），切换时恢复而非总是默认模型 */
  const vendorModelMem = useRef<Partial<Record<string, string>>>({});

  const vendor = model.vendor;
  const isCustom = isCustomVendorId(String(vendor)) || addingCustom;
  const preset = getSmartChatVendorPreset(vendor, customVendors);
  const labels = getBillingLabels(vendor, balance.display);

  const resolveModelForVendor = useCallback((v: ScVendorId, preferred?: string) => {
    const p = getSmartChatVendorPreset(v);
    for (const cand of [preferred, vendorModelMem.current[v]]) {
      if (cand && p.models.some((m) => m.value === cand)) return cand;
    }
    return p.default_model;
  }, []);

  const applyConfig = useCallback((raw: SmartChatConfig) => {
    setCfg(raw || {});
    setCustomVendors(raw?.custom_vendors || []);
    setAddingCustom(false);
    setProbeLog('');
    const form = configToModelForm(raw || {});
    setModel(form);
    if (form.vendor && form.model) {
      vendorModelMem.current[form.vendor] = form.model;
    }
    setContext(configToContextForm(raw || {}));
    setOnline({
      toolsMaxRounds: raw?.tools_max_rounds ?? 3,
      imageRecognize: imageRecognizeFromConfig(raw || {}),
      keys: { tavily: '', serper: '', bocha: '', mcp: '' },
      mcpEnabled: raw?.web_search?.mcp_enabled !== false,
      mcpEndpoint: String(raw?.web_search?.mcp_endpoint || ''),
    });
    setClearFlags({ ...SC_WEB_SEARCH_CLEAR_INIT });
    setRotation(configToRotationForm(raw || {}));
    if (raw?.default_system_prompt) setDefaultPrompt(raw.default_system_prompt);
    setKeyTone(raw?.api_key_set ? 'ok' : 'default');
  }, []);

  const loadConfig = useCallback(async () => {
    const r = await api.get<SmartChatConfig>('/smart-chat/config');
    if (r.code !== 0) throw new Error(r.message || '加载配置失败');
    applyConfig(r.data || {});
  }, [api, applyConfig]);

  const loadUsage = useCallback(async () => {
    try {
      const r = await api.get<Record<string, unknown>>('/smart-chat/usage');
      setUsage(r.data || {});
    } catch {
      /* ignore */
    }
  }, [api]);

  const loadBalance = useCallback(async (force = false) => {
    setBalanceLoading(true);
    try {
      // 强刷先作废共享缓存：否则顶部状态条 / 总览页还拿着旧快照，
      // 用户刚点了「刷新余额」却在别处看到旧数字。
      if (force) invalidateBalance();
      const r = await api.get<BalanceData>('/smart-chat/balance', force ? { force: 1, refresh: 1, _t: Date.now() } : { _t: Date.now() });
      setBalance(r.data || {});
      if (force) {
        const info = r.data?.infos?.[0] || null;
        const v = inferVendorFromConfig(cfg);
        const text = computeBalanceDisplay(v, info || null, r.data || {});
        toast(
          info ? (v === 'nvidia' ? `限速已刷新：${text}` : `余额已刷新：${text}`) : (r.data?.error || '刷新完成'),
          info ? 'ok' : 'warn',
        );
      }
    } catch (e) {
      setBalance({ error: e instanceof Error ? e.message : String(e) });
      if (force) toast(`刷新余额失败: ${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setBalanceLoading(false);
    }
  }, [api, cfg, toast]);

  const toastRef = useRef(toast);
  toastRef.current = toast;

  const loadPage = useCallback(async () => {
    try {
      await loadConfig();
      await loadUsage();
    } catch (e) {
      toastRef.current(e instanceof Error ? e.message : String(e));
    }
  }, [loadConfig, loadUsage]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  useEffect(() => {
    if (section === 'model') void loadBalance(false);
  }, [section, loadBalance]);

  const loadToolSkills = useCallback(async () => {
    try {
      const r = await api.get<{ tools?: ToolSkill[] }>('/smart-chat/tool-skills');
      setToolSkills(r.data?.tools || []);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }, [api, toast]);

  const loadGalleries = useCallback(async () => {
    try {
      const r = await api.get<{ galleries?: GalleryRow[]; ready?: boolean }>('/smart-chat/sticker/galleries');
      setGalleries(r.data?.galleries || []);
      setGalleryReady(!!r.data?.ready);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }, [api, toast]);

  useEffect(() => {
    if (section === 'skills') {
      void loadToolSkills();
      void loadGalleries();
    }
  }, [section, loadToolSkills, loadGalleries]);

  useEffect(() => {
    if (section !== 'skills') return;
    const active = galleries.some((g) => isGalleryJobRunning(g.activeJob));
    if (!active) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      void loadGalleries();
    }, 1200);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [section, galleries, loadGalleries]);

  const onVendorChange = (next: VendorId) => {
    if (next === vendor && !addingCustom) return;
    setAddingCustom(false);
    setProbeLog('');
    setModelListOpen(false);
    setModelOptions([]);
    vendorModelMem.current[vendor] = model.model;
    if (isCustomVendorId(String(next))) {
      const c = customVendors.find((x) => x.id === next);
      if (!c) return;
      setModel((m) => ({
        ...m,
        vendor: next,
        apiKey: '',
        baseUrl: c.base_url,
        balanceUrl: String(c.balance_url || '').trim(),
        model: c.model,
        temperature: c.temperature ?? 0.7,
        maxTokens: c.max_tokens ?? 2048,
        customName: c.name,
        chatPath: c.chat_path ?? '',
        apiProtocol: (c.api_protocol as ApiProtocol) || 'openai',
      }));
      setKeyTone(c.api_key_set ? 'ok' : 'default');
      toast(`已切换为自定义「${c.name}」`, 'info');
      return;
    }
    const p = getSmartChatVendorPreset(next);
    const savedForNext = cfg.vendor === next ? String(cfg.model || '') : '';
    const nextModel = resolveModelForVendor(next as ScVendorId, savedForNext || vendorModelMem.current[next]);
    vendorModelMem.current[next] = nextModel;
    setModel((m) => ({
      ...m,
      vendor: next,
      apiKey: '',
      baseUrl: p.base_url,
      balanceUrl: p.balance_url,
      model: nextModel,
      customName: '',
      chatPath: p.chat_path,
    }));
    setKeyTone(cfg.api_key_set && cfg.vendor === next ? 'ok' : 'default');
    toast(`已切换为「${p.name}」预设，请填写密钥后保存`, 'info');
  };

  /** 模型下拉选择：记忆该厂商选中模型并更新表单 */
  const selectModel = (nextModel: string) => {
    vendorModelMem.current[vendor] = nextModel;
    setModel((m) => ({ ...m, model: nextModel }));
  };

  const startAddCustom = (protocol: ApiProtocol = 'openai') => {
    setAddingCustom(true);
    setProbeLog('');
    setModelListOpen(false);
    setModelOptions([]);
    setModel((m) => ({
      ...m,
      vendor: '',
      apiKey: '',
      baseUrl: protocol === 'anthropic' ? 'https://api.anthropic.com' : '',
      balanceUrl: '',
      model: '',
      temperature: 0.7,
      maxTokens: 2048,
      customName: '',
      chatPath: protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
      apiProtocol: protocol,
    }));
    setKeyTone('default');
  };

  const startAddCustomAnthropic = () => startAddCustom('anthropic');

  const buildCustomListForSave = (activeId: string, name: string): CustomVendor[] => {
    const bal = model.balanceUrl.trim();
    const row: CustomVendor = {
      id: activeId,
      name,
      base_url: model.baseUrl.trim(),
      ...(bal ? { balance_url: bal } : {}),
      model: model.model.trim(),
      temperature: Number(model.temperature),
      max_tokens: Number(model.maxTokens),
      chat_path: String(model.chatPath ?? '').trim(),
      api_protocol: model.apiProtocol || 'openai',
      api_key: model.apiKey.trim() || undefined,
    };
    const rest = customVendors.filter((c) => c.id !== activeId);
    return [...rest, row];
  };

  const saveConfig = async () => {
    try {
      let nextModel = model;
      let list = customVendors;
      if (addingCustom || isCustomVendorId(String(model.vendor))) {
        const name = String(model.customName || '').trim();
        if (!name) {
          toast('请填写自定义厂商名称', 'warn');
          return;
        }
        if (!model.baseUrl.trim() || !model.model.trim()) {
          toast('请填写 Base URL 与模型 ID', 'warn');
          return;
        }
        if (addingCustom && !model.apiKey.trim()) {
          toast('新建自定义厂商请填写 API Key', 'warn');
          return;
        }
        const id = addingCustom
          ? newCustomVendorId()
          : String(model.vendor);
        list = buildCustomListForSave(id, name);
        nextModel = { ...model, vendor: id, customName: name };
      }
      const r = await api.post<SmartChatConfig>(
        '/smart-chat/config',
        collectConfigPayload(nextModel, context, {
          customVendors: list,
          defaultSystemPrompt: defaultPrompt,
        }),
      );
      if (r.code !== 0) throw new Error(r.message || '保存失败');
      applyConfig(r.data || {});
      toast(r.data?.fingerprint_changed ? '已保存：会话命名空间已切换' : '配置已保存', 'ok');
      void loadUsage();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  const saveRotation = async () => {
    setRotationSaving(true);
    try {
      const r = await api.post<SmartChatConfig>(
        '/smart-chat/config',
        collectRotationPayload(rotation),
      );
      if (r.code !== 0) throw new Error(r.message || '保存失败');
      applyConfig(r.data || {});
      toast('模型轮替设置已保存', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setRotationSaving(false);
    }
  };

  const deleteCustomVendor = async (id: string) => {
    const c = customVendors.find((x) => x.id === id);
    const ok = await confirm({
      title: '删除自定义厂商',
      message: `确定删除「${c?.name || id}」？`,
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    try {
      const list = customVendors.filter((x) => x.id !== id);
      const nextVendor = model.vendor === id ? 'deepseek' : model.vendor;
      const nextModel = nextVendor === 'deepseek' && model.vendor === id
        ? {
            ...model,
            vendor: 'deepseek' as VendorId,
            apiKey: '',
            baseUrl: SC_VENDOR_PRESETS.deepseek.base_url,
            balanceUrl: SC_VENDOR_PRESETS.deepseek.balance_url,
            model: SC_VENDOR_PRESETS.deepseek.default_model,
            customName: '',
          }
        : model;
      const r = await api.post<SmartChatConfig>(
        '/smart-chat/config',
        collectConfigPayload(nextModel, context, {
          customVendors: list,
          deleteCustomVendor: id,
          defaultSystemPrompt: defaultPrompt,
        }),
      );
      if (r.code !== 0) throw new Error(r.message || '删除失败');
      applyConfig(r.data || {});
      toast('已删除自定义厂商', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  const isKeyRelatedError = (msg: string) =>
    /api_key|api.?key|401|403|unauthorized|invalid.?key|密钥|key_not|not_configured|authentication|鉴权/i.test(msg);

  const testProbe = async () => {
    setProbeBusy(true);
    setProbeLog('请求中…');
    try {
      const r = await api.post<{
        ok?: boolean;
        latency_ms?: number;
        status?: number;
        content?: string;
        raw?: string;
        error?: string;
      }>('/smart-chat/probe', {
        vendor: isCustomVendorId(String(model.vendor)) ? model.vendor : undefined,
        api_key: model.apiKey.trim() || undefined,
        base_url: model.baseUrl.trim(),
        model: model.model.trim(),
        chat_path: model.chatPath ?? '',
        max_tokens: model.maxTokens,
        temperature: model.temperature,
        api_protocol: model.apiProtocol || 'openai',
      });
      const d = r.data || {};
      const lines = [
        d.ok ? '✓ 访问成功' : '✗ 访问失败',
        d.latency_ms != null ? `耗时 ${d.latency_ms}ms` : '',
        d.status != null ? `HTTP ${d.status}` : '',
        d.error ? `错误: ${d.error}` : '',
        d.content != null ? `回复: ${d.content}` : '',
        d.raw ? `--- raw ---\n${d.raw}` : '',
      ].filter(Boolean);
      setProbeLog(lines.join('\n'));
      if (d.ok) {
        setKeyTone('ok');
        toast('测试访问成功', 'ok');
      } else {
        if (isKeyRelatedError(String(d.error || r.message || ''))) setKeyTone('err');
        toast(`测试访问失败: ${d.error || r.message || '未知错误'}`, 'err');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProbeLog(`异常: ${msg}`);
      if (isKeyRelatedError(msg)) setKeyTone('err');
      toast(msg, 'err');
    } finally {
      setProbeBusy(false);
    }
  };

  const fetchModelList = async () => {
    if (!model.baseUrl.trim()) {
      toast('请先填写 Base URL', 'warn');
      return;
    }
    setFetchingModels(true);
    try {
      const r = await api.post<{ ok?: boolean; models?: string[]; error?: string }>('/smart-chat/models', {
        vendor: isCustomVendorId(String(model.vendor)) ? model.vendor : undefined,
        api_key: model.apiKey.trim() || undefined,
        base_url: model.baseUrl.trim(),
        chat_path: model.chatPath ?? '',
        api_protocol: model.apiProtocol || 'openai',
      });
      const d = r.data || {};
      if (r.code !== 0 || !d.ok) {
        throw new Error(d.error || r.message || '拉取失败');
      }
      const list = Array.isArray(d.models) ? d.models : [];
      setModelOptions(list);
      setModelListOpen(true);
      toast(list.length ? `已拉取 ${list.length} 个模型` : '未返回模型', list.length ? 'ok' : 'warn');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setFetchingModels(false);
    }
  };

  const saveOnline = async () => {
    try {
      const r = await api.post<SmartChatConfig>('/smart-chat/config', collectOnlinePayload(online, clearFlags));
      if (r.code !== 0) throw new Error(r.message || '保存失败');
      applyConfig(r.data || {});
      toast(r.data?.fingerprint_changed ? '联网配置已保存：会话命名空间已切换' : '联网配置已保存', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  const testConnection = async () => {
    setProbeBusy(true);
    setProbeLog('请求中…');
    try {
      const r = await api.post<{
        ok?: boolean;
        latency_ms?: number;
        status?: number;
        content?: string;
        raw?: string;
        error?: string;
        message?: string;
        model?: string;
      }>('/smart-chat/test', {});
      const d = r.data || {};
      const detail = String(d.error || d.message || r.message || '');
      const lines = [
        d.ok ? '✓ 访问成功' : '✗ 访问失败',
        d.model ? `模型 ${d.model}` : '',
        d.latency_ms != null ? `耗时 ${d.latency_ms}ms` : '',
        d.status != null ? `HTTP ${d.status}` : '',
        d.error ? `错误: ${d.error}` : '',
        d.content != null ? `回复: ${d.content}` : '',
        d.raw ? `--- raw ---\n${d.raw}` : '',
      ].filter(Boolean);
      setProbeLog(lines.join('\n'));
      if (r.code === 0 && d.ok) {
        setKeyTone(cfg.api_key_set || model.apiKey.trim() ? 'ok' : 'default');
        const reply = d.content ? `：${d.content}` : '';
        toast(`连通性正常${d.latency_ms != null ? `（${d.latency_ms}ms）` : ''}${reply}`, 'ok');
      } else {
        if (isKeyRelatedError(detail)) setKeyTone('err');
        toast(`连通性失败: ${detail || '未知错误'}`, 'err');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProbeLog(`异常: ${msg}`);
      if (isKeyRelatedError(msg)) setKeyTone('err');
      toast(msg, 'err');
    } finally {
      setProbeBusy(false);
    }
  };

  const testWebSearch = async (provider: WebSearchProvider) => {
    setProviderStatus((s) => ({ ...s, [provider]: '测试中…' }));
    try {
      const payload = collectOnlinePayload(online, clearFlags);
      const hasNew = Object.keys(payload.web_search as object).length > 0;
      if (hasNew || clearFlags.tavily || clearFlags.serper || clearFlags.bocha) {
        await api.post('/smart-chat/config', payload);
        setClearFlags({ ...SC_WEB_SEARCH_CLEAR_INIT });
        await loadConfig();
      }
      const r = await api.post<{ ok?: boolean; error?: string; may_consume_quota?: boolean }>('/smart-chat/web-search/test', { provider });
      const ok = r.code === 0 && r.data?.ok;
      setProviderStatus((s) => ({
        ...s,
        [provider]: ok
          ? `正常${r.data?.may_consume_quota ? '（已耗极少额度）' : ''}`
          : (r.data?.error || r.message || '失败'),
      }));
      toast(
        ok ? `${provider} 测试通过` : `${provider} 测试失败: ${r.data?.error || r.message}`,
        ok ? 'ok' : 'err',
      );
    } catch (e) {
      setProviderStatus((s) => ({ ...s, [provider]: e instanceof Error ? e.message : '失败' }));
      toast(`测试失败: ${e instanceof Error ? e.message : e}`, 'err');
    }
  };

  const clearUsage = async () => {
    const ok = await confirm({
      title: '清空用量',
      message: '确定清空本地用量账本？此操作不可恢复。',
      danger: true,
      okText: '清空',
    });
    if (!ok) return;
    try {
      await api.post('/smart-chat/usage/clear', {});
      await loadUsage();
      toast('已清空本地用量', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  const toggleTool = async (code: string, enabled: boolean) => {
    try {
      await api.post('/smart-chat/tool-skills/toggle', { code, enabled });
      await loadToolSkills();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  /**
   * 点击「安装」：先弹悬浮窗选安装源（GitHub 仓库 / kakake 服务器），
   * 已装过则再确认一次覆盖，最后才真正发起下载。
   */
  const installGallery = async (galleryId: string) => {
    const g = galleries.find((x) => x.id === galleryId);
    if (!g) {
      toast('未找到图库定义', 'err');
      return;
    }
    // 「选择源」弹层由页面侧的 pickStickerSource 注入（React 组件在页面里，
      // 控制器不持 UI）；页面没注入时退回默认源，保证功能不丢。
    const picked = pickStickerSource ? await pickStickerSource(g) : DEFAULT_STICKER_SOURCE;
    if (!picked) return; // 用户取消

    if (g.installed) {
      const ok = await confirm({
        title: '重新安装',
        message: `重新安装将覆盖本地「${g.name || g.id}」的图片（源：${stickerSourceLabel(picked)}），是否继续？`,
        danger: true,
        okText: '重新安装',
      });
      if (!ok) return;
    }
    try {
      const r = await api.post<{ jobId?: string }>('/smart-chat/sticker/install', {
        galleryId,
        id: galleryId,
        source: picked,
      });
      if (r.data?.jobId) rememberStickerInstallJob(galleryId, r.data.jobId);
      toast(`${g.installed ? '开始重新安装图库' : '开始安装图库'} · ${stickerSourceLabel(picked)}`, 'info');
      void loadGalleries();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  const info = balance.infos?.[0] || null;
  const barPct = computeBalanceBarPct(vendor, info, balance);
  const badge = computeBalanceBadge(vendor, balance.available, barPct);

  const providers = useMemo(
    () =>
      ([
        { id: 'mcp' as const, name: 'MCP 免费搜索', home: '', docs: '' },
        { id: 'tavily' as const, name: 'Tavily', home: 'https://app.tavily.com/home', docs: 'https://docs.tavily.com' },
        { id: 'serper' as const, name: 'Serper', home: 'https://serper.dev', docs: '' },
        { id: 'bocha' as const, name: '博查', home: 'https://open.bochaai.com/api-keys', docs: 'https://open.bochaai.com/' },
      ]),
    [],
  );

  return {
    cfg,
    model,
    setModel,
    context,
    setContext,
    online,
    setOnline,
    clearFlags,
    setClearFlags,
    rotation,
    setRotation,
    rotationSaving,
    saveRotation,
    defaultPrompt,
    usage,
    balance,
    balanceLoading,
    toolSkills,
    galleries,
    galleryReady,
    providerStatus,
    keyTone,
    setKeyTone,
    customVendors,
    addingCustom,
    setAddingCustom,
    probeLog,
    setProbeLog,
    probeBusy,
    fetchingModels,
    modelListOpen,
    setModelListOpen,
    modelOptions,
    fetchModelList,
    vendor,
    isCustom,
    preset,
    labels,
    info,
    barPct,
    badge,
    providers,
    loadConfig,
    loadBalance,
    selectModel,
    onVendorChange,
    startAddCustom,
    startAddCustomAnthropic,
    saveConfig,
    deleteCustomVendor,
    testProbe,
    saveOnline,
    testConnection,
    testWebSearch,
    clearUsage,
    toggleTool,
    installGallery,
  };
}