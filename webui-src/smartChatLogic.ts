export type ScVendorId = 'deepseek' | 'nvidia';
export type VendorId = ScVendorId | string;
export type ApiProtocol = 'openai' | 'anthropic';

export interface CustomVendor {
  id: string;
  name: string;
  api_key?: string;
  api_key_set?: boolean;
  api_key_masked?: string;
  base_url: string;
  /** 可选；留空由后端按中转站惯例推导 */
  balance_url?: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  chat_path?: string;
  api_protocol?: ApiProtocol;
}

export function isCustomVendorId(id: string): boolean {
  return /^custom_[a-zA-Z0-9_-]{1,64}$/.test(String(id || '').trim());
}

export function newCustomVendorId(): string {
  return `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export type ScTabId = 'model' | 'billing' | 'context' | 'kb' | 'online' | 'sessions';

export interface VendorModel {
  value: string;
  label: string;
}

export interface VendorPreset {
  id: ScVendorId;
  name: string;
  website: string;
  docs: string;
  base_url: string;
  balance_url: string;
  chat_path: string;
  models: VendorModel[];
  default_model: string;
}

export const SC_VENDOR_PRESETS: Record<ScVendorId, VendorPreset> = {
  deepseek: {
    id: 'deepseek',
    name: '深度求索',
    website: 'https://platform.deepseek.com/',
    docs: 'https://api-docs.deepseek.com/',
    base_url: 'https://api.deepseek.com',
    balance_url: 'https://api.deepseek.com/user/balance',
    chat_path: '/v1/chat/completions',
    models: [
      { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash（更快更省）' },
      { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（更强）' },
    ],
    default_model: 'deepseek-v4-flash',
  },
  nvidia: {
    id: 'nvidia',
    name: '英伟达 NIM',
    website: 'https://build.nvidia.com/',
    docs: 'https://docs.api.nvidia.com/nim/',
    base_url: 'https://integrate.api.nvidia.com/v1',
    balance_url: '',
    chat_path: '/chat/completions',
    models: [
      { value: 'deepseek-ai/deepseek-v4-flash-0731', label: 'deepseek-v4-flash-0731（1M · 官方最新）' },
      { value: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra（1M）' },
      { value: 'nvidia/nemotron-3-super-120b-a12b', label: 'nemotron-3-super（1M）' },
      { value: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'nemotron-3.5-lightning（快）' },
      { value: 'openai/gpt-oss-120b', label: 'gpt-oss-120b（128K）' },
      { value: 'openai/gpt-oss-20b', label: 'gpt-oss-20b（128K）' },
      { value: 'moonshotai/kimi-k2.6', label: 'kimi-k2.6（128K）' },
      { value: 'meta/llama-3.3-70b-instruct', label: 'llama-3.3-70b（128K）' },
      { value: 'google/gemma-4-31b-it', label: 'gemma-4-31b（128K）' },
      { value: 'google/diffusiongemma-26b-a4b-it', label: 'diffusiongemma-26b（128K）' },
    ],
    default_model: 'deepseek-ai/deepseek-v4-flash-0731',
  },
};

export function getSmartChatVendorPreset(vendor: string, customs: CustomVendor[] = []): VendorPreset {
  if (vendor in SC_VENDOR_PRESETS) return SC_VENDOR_PRESETS[vendor as ScVendorId];
  const c = customs.find((x) => x.id === vendor);
  if (c) {
    return {
      id: c.id as ScVendorId,
      name: c.name,
      website: '',
      docs: '',
      base_url: c.base_url,
      balance_url: String(c.balance_url || '').trim(),
      chat_path: c.chat_path || '',
      models: [{ value: c.model, label: c.model }],
      default_model: c.model,
    };
  }
  return SC_VENDOR_PRESETS.deepseek;
}

export function protocolLabel(protocol?: ApiProtocol | string): string {
  return String(protocol || '').toLowerCase() === 'anthropic' ? 'Anthropic' : 'OpenAI';
}

export function inferVendorFromConfig(cfg: {
  vendor?: string;
  base_url?: string;
  custom_vendors?: CustomVendor[];
}): VendorId {
  const v = String(cfg.vendor || '').trim();
  if (isCustomVendorId(v) && (cfg.custom_vendors || []).some((c) => c.id === v)) return v;
  if (v in SC_VENDOR_PRESETS) return v as ScVendorId;
  const url = String(cfg.base_url || '');
  if (url.includes('nvidia.com')) return 'nvidia';
  return 'deepseek';
}

export interface BillingLabels {
  totalLabel: string;
  meterTitle: string;
  toppedLabel: string;
  grantedLabel: string;
  refreshBtn: string;
  hideCache: boolean;
  hideBalanceUrl: boolean;
}

export function getBillingLabels(vendor: VendorId, display?: string): BillingLabels {
  if (isCustomVendorId(String(vendor))) {
    const relay = display === 'hcnsec' || !display;
    return {
      totalLabel: '账户余额',
      meterTitle: relay ? '额度构成（已用 / 总额）' : '余额构成（充值 / 赠送）',
      toppedLabel: relay ? '已用额度' : '充值余额',
      grantedLabel: relay ? '令牌总额' : '赠送余额',
      refreshBtn: '刷新余额',
      hideCache: false,
      hideBalanceUrl: false,
    };
  }
  const isNvidia = vendor === 'nvidia';
  return {
    totalLabel: isNvidia ? '近1分钟用量' : '账户余额',
    meterTitle: isNvidia
      ? '每分钟请求占比（免费档约 40 RPM）'
      : '余额构成（充值 / 赠送）',
    toppedLabel: isNvidia ? '本分钟已用' : '充值余额',
    grantedLabel: isNvidia ? '参考上限 RPM' : '赠送余额',
    refreshBtn: isNvidia ? '刷新限速' : '刷新余额',
    hideCache: isNvidia,
    hideBalanceUrl: isNvidia,
  };
}

export function normalizeScRoundsInput(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(999, Math.max(1, Math.floor(n)));
}

export function clampMeterPercent(percent: number | null | undefined): number {
  return Math.max(0, Math.min(100, Number(percent) || 0));
}

export function formatMeterPct(percent: number | null | undefined): string {
  if (percent == null || Number.isNaN(Number(percent))) return '—';
  return `${clampMeterPercent(percent).toFixed(1)}%`;
}

export function formatTokenCount(n: unknown): string {
  const v = Number(n) || 0;
  // 超过 100 万（1,000,000）统一转成 M，并去掉多余的尾零：1,000,000→1M、1,500,000→1.5M
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function formatBytes(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(2)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: unknown): string {
  return `${formatBytes(bps)}/s`;
}

export function formatEtaSec(sec: unknown): string {
  if (sec == null || !Number.isFinite(Number(sec))) return '计算中…';
  let s = Math.max(0, Math.ceil(Number(sec)));
  if (s <= 0) return '即将完成';
  if (s < 60) return `约剩余 ${s} 秒`;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s %= 60;
  if (h > 0) {
    return s > 0 || m > 0 ? `约剩余 ${h} 小时 ${m} 分` : `约剩余 ${h} 小时`;
  }
  return s > 0 ? `约剩余 ${m} 分 ${s} 秒` : `约剩余 ${m} 分`;
}

export type WebSearchProvider = 'tavily' | 'serper' | 'bocha';

export const SC_WEB_SEARCH_CLEAR_INIT: Record<WebSearchProvider, boolean> = {
  tavily: false,
  serper: false,
  bocha: false,
};

export interface SmartChatConfig {
  vendor?: string;
  base_url?: string;
  balance_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  debounce_ms?: number;
  max_batch?: number;
  random_wait_enabled?: boolean;
  random_wait_min_ms?: number;
  random_wait_max_ms?: number;
  silence_veto_ratio?: number;
  reply_gap_ms?: number;
  kb_top_m?: number;
  shut_up_limit?: number;
  action_min?: number;
  action_max?: number;
  system_prompt?: string;
  default_system_prompt?: string;
  private_chat_enabled?: boolean;
  api_key_set?: boolean;
  api_key_masked?: string;
  session_fingerprint?: string;
  session_fingerprint_preview?: string;
  tools_max_rounds?: number;
  fingerprint_changed?: boolean;
  image_recognize?: ImageRecognizeConfig;
  custom_vendors?: CustomVendor[];
  model_rotation_enabled?: boolean;
  model_rotation_mode?: RotationMode | string;
  model_rotation_limit?: number;
  bot_nickname?: string;
  bot_user_id?: string;
  web_search_masked?: {
    tavily_set?: boolean;
    tavily_key?: string;
    serper_set?: boolean;
    serper_key?: string;
    bocha_set?: boolean;
    bocha_key?: string;
  };
}

export interface ImageRecognizeConfig {
  timeout_sec?: number;
  queue_normal?: number;
  queue_at?: number;
  per_msg_normal?: number;
  per_msg_at?: number;
}

/** 自动模型轮替方式 */
export type RotationMode = 'same_vendor' | 'other_vendor_default' | 'other_vendor_any';

export interface RotationModeOption {
  value: RotationMode;
  /** 胶囊按钮上的短标签（手机端需单行） */
  label: string;
  /** 完整名称（title / 说明用） */
  full: string;
}

export const ROTATION_MODE_OPTIONS: RotationModeOption[] = [
  { value: 'same_vendor', label: '本厂商内', full: '仅本厂商内轮替切换' },
  { value: 'other_vendor_default', label: '其他厂商', full: '其他厂商模型' },
  { value: 'other_vendor_any', label: '任意模型', full: '其他厂商任意模型' },
];

/** 三行声明：与后端 smart-chat-rotation.ts 的实际行为一一对应 */
export const ROTATION_NOTES: string[] = [
  '仅本厂商内轮替切换：同 Key 同地址拉取模型列表，随机换一个别的模型；没有别的模型即判失败。',
  '其他厂商模型：换到其他已配好的自定义厂商，只用它自己保存的模型；没有其他厂商即判失败。',
  '其他厂商任意模型：换到一家后随机试完它列表里的模型，全不行再换下一家；次数填 N 则累计 N 次仍失败即判失败。',
];

export interface RotationFormState {
  enabled: boolean;
  mode: RotationMode;
  /** 0 = 不限（候选全试完才算失败） */
  limit: number;
}

export function normalizeRotationMode(raw: unknown): RotationMode {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'other_vendor_default' || v === 'other_vendor_any') return v;
  return 'same_vendor';
}

export function configToRotationForm(cfg: SmartChatConfig): RotationFormState {
  const limit = Number(cfg.model_rotation_limit);
  return {
    enabled: cfg.model_rotation_enabled === true,
    mode: normalizeRotationMode(cfg.model_rotation_mode),
    limit: Number.isFinite(limit) ? Math.min(20, Math.max(0, Math.round(limit))) : 3,
  };
}

/** 轮替页单独提交：后端 mergeConfigFromBody 只覆盖出现过的键 */
export function collectRotationPayload(r: RotationFormState): Record<string, unknown> {
  return {
    model_rotation_enabled: r.enabled === true,
    model_rotation_mode: normalizeRotationMode(r.mode),
    model_rotation_limit: Math.min(20, Math.max(0, Math.round(Number(r.limit) || 0))),
  };
}

export interface ModelFormState {
  vendor: VendorId;
  apiKey: string;
  baseUrl: string;
  balanceUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 自定义厂商显示名（仅 custom_*） */
  customName?: string;
  chatPath?: string;
  apiProtocol?: ApiProtocol;
}

export interface ContextFormState {
  debounceMs: number;
  maxBatch: number;
  randomWaitEnabled: boolean;
  randomWaitMinMin: number;
  randomWaitMaxMin: number;
  /** 「没人对你说话」时闭嘴的概率（0-100%，对应 silence_veto_ratio） */
  silenceVetoPercent: number;
  replyGapMs: number;
  kbTopM: number;
  shutUpLimit: number;
  actionMin: number;
  actionMax: number;
  systemPrompt: string;
  privateEnabled: boolean;
}

export interface OnlineFormState {
  toolsMaxRounds: number;
  imageRecognize: Required<ImageRecognizeConfig>;
  keys: Record<WebSearchProvider, string>;
}

export function imageRecognizeFromConfig(cfg: SmartChatConfig): Required<ImageRecognizeConfig> {
  const ir = cfg.image_recognize || {};
  return {
    timeout_sec: ir.timeout_sec ?? 30,
    queue_normal: ir.queue_normal ?? 3,
    queue_at: ir.queue_at ?? 3,
    per_msg_normal: ir.per_msg_normal ?? 3,
    per_msg_at: ir.per_msg_at ?? 2,
  };
}

export function configToModelForm(cfg: SmartChatConfig): ModelFormState {
  const customs = cfg.custom_vendors || [];
  const vendor = inferVendorFromConfig(cfg);
  const preset = getSmartChatVendorPreset(vendor, customs);
  const custom = isCustomVendorId(String(vendor))
    ? customs.find((c) => c.id === vendor)
    : undefined;
  const ok = preset.models.some((m) => m.value === cfg.model);
  return {
    vendor,
    apiKey: '',
    baseUrl: cfg.base_url || custom?.base_url || '',
    balanceUrl: cfg.balance_url || custom?.balance_url || '',
    model: custom
      ? (cfg.model || custom.model)
      : (ok ? (cfg.model || preset.default_model) : preset.default_model),
    temperature: cfg.temperature ?? custom?.temperature ?? 0.7,
    maxTokens: cfg.max_tokens ?? custom?.max_tokens ?? 2048,
    customName: custom?.name || '',
    chatPath: custom?.chat_path ?? '',
    apiProtocol: (custom?.api_protocol as ApiProtocol) || 'openai',
  };
}

export function configToContextForm(cfg: SmartChatConfig): ContextFormState {
  return {
    debounceMs: cfg.debounce_ms ?? 8000,
    maxBatch: cfg.max_batch ?? 12,
    randomWaitEnabled: cfg.random_wait_enabled !== false,
    randomWaitMinMin: Math.round((cfg.random_wait_min_ms ?? 60000) / 60000),
    randomWaitMaxMin: Math.round((cfg.random_wait_max_ms ?? 1800000) / 60000),
    silenceVetoPercent: Math.round((cfg.silence_veto_ratio ?? 0.55) * 100),
    replyGapMs: cfg.reply_gap_ms ?? 1200,
    kbTopM: cfg.kb_top_m ?? 3,
    shutUpLimit: cfg.shut_up_limit ?? 5,
    actionMin: cfg.action_min ?? 0,
    actionMax: cfg.action_max ?? 3,
    systemPrompt: cfg.system_prompt || '',
    privateEnabled: true,
  };
}

export function collectConfigPayload(
  model: ModelFormState,
  context: ContextFormState,
  extras?: {
    customVendors?: CustomVendor[];
    deleteCustomVendor?: string;
    /** 与后端 default_system_prompt 对齐：相等则提交空串，让磁盘删键 */
    defaultSystemPrompt?: string;
  },
): Record<string, unknown> {
  let actionMin = Math.min(10, Math.max(0, Number(context.actionMin) || 0));
  let actionMax = Math.min(10, Math.max(0, Number(context.actionMax) || 3));
  if (actionMax < 1) actionMax = 1;
  if (actionMin > actionMax) actionMin = actionMax;
  const prompt = String(context.systemPrompt || '').trim();
  const stock = String(extras?.defaultSystemPrompt || '').trim();
  const system_prompt = stock && prompt === stock ? '' : prompt;
  const body: Record<string, unknown> = {
    vendor: model.vendor,
    base_url: model.baseUrl.trim(),
    balance_url: model.balanceUrl.trim(),
    model: model.model.trim(),
    temperature: Number(model.temperature),
    max_tokens: Number(model.maxTokens),
    debounce_ms: Number(context.debounceMs),
    max_batch: Math.min(25, Math.max(1, Number(context.maxBatch) || 12)),
    random_wait_enabled: context.randomWaitEnabled !== false,
    random_wait_min_ms: Math.min(60, Math.max(1, Number(context.randomWaitMinMin) || 1)) * 60000,
    random_wait_max_ms: Math.min(60, Math.max(1, Number(context.randomWaitMaxMin) || 30)) * 60000,
    silence_veto_ratio: Math.min(100, Math.max(0, Number(context.silenceVetoPercent) || 0)) / 100,
    reply_gap_ms: Math.min(8000, Math.max(400, Number(context.replyGapMs) || 1200)),
    kb_top_m: Number(context.kbTopM),
    shut_up_limit: Math.min(50, Math.max(1, Number(context.shutUpLimit) || 5)),
    action_min: actionMin,
    action_max: actionMax,
    system_prompt,
    /** 私聊由「聊天开关」按好友控制，总开关恒开 */
    private_chat_enabled: true,
  };
  const key = model.apiKey.trim();
  if (key) body.api_key = key;
  if (extras?.customVendors) {
    body.custom_vendors = extras.customVendors.map((c) => ({
      id: c.id,
      name: c.name,
      base_url: c.base_url,
      model: c.model,
      temperature: c.temperature ?? 0.7,
      max_tokens: c.max_tokens ?? 2048,
      chat_path: String(c.chat_path ?? '').trim(),
      api_protocol: c.api_protocol || 'openai',
      ...(c.api_key && !c.api_key.includes('…') ? { api_key: c.api_key } : {}),
    }));
  }
  if (extras?.deleteCustomVendor) body.delete_custom_vendor = extras.deleteCustomVendor;
  return body;
}

export function collectOnlinePayload(
  online: OnlineFormState,
  clearFlags: Record<WebSearchProvider, boolean>,
): Record<string, unknown> {
  const web_search: Record<string, unknown> = {};
  const tavily = online.keys.tavily.trim();
  const serper = online.keys.serper.trim();
  const bocha = online.keys.bocha.trim();
  if (tavily && !tavily.includes('…')) web_search.tavily_key = tavily;
  if (serper && !serper.includes('…')) web_search.serper_key = serper;
  if (bocha && !bocha.includes('…')) web_search.bocha_key = bocha;
  if (clearFlags.tavily) web_search.clear_tavily_key = true;
  if (clearFlags.serper) web_search.clear_serper_key = true;
  if (clearFlags.bocha) web_search.clear_bocha_key = true;
  const ir = online.imageRecognize;
  return {
    tools_max_rounds: Math.min(5, Math.max(1, Number(online.toolsMaxRounds) || 3)),
    image_recognize: {
      timeout_sec: Math.min(120, Math.max(5, Math.floor(Number(ir.timeout_sec) || 30))),
      queue_normal: Math.min(20, Math.max(1, Math.floor(Number(ir.queue_normal) || 3))),
      queue_at: Math.min(20, Math.max(1, Math.floor(Number(ir.queue_at) || 3))),
      per_msg_normal: Math.min(10, Math.max(1, Math.floor(Number(ir.per_msg_normal) || 3))),
      per_msg_at: Math.min(10, Math.max(1, Math.floor(Number(ir.per_msg_at) || 2))),
    },
    web_search,
  };
}

export function isWebSearchProviderConfigured(
  provider: WebSearchProvider,
  cfg: SmartChatConfig,
  clearFlags: Record<WebSearchProvider, boolean>,
): boolean {
  const m = cfg.web_search_masked || {};
  const map: Record<WebSearchProvider, boolean> = {
    tavily: !!m.tavily_set,
    serper: !!m.serper_set,
    bocha: !!m.bocha_set,
  };
  return Boolean(map[provider]) && !clearFlags[provider];
}

export interface SwitchState {
  enabled: boolean;
  ai_only: boolean;
  rounds: number;
  image_recognize: boolean;
  /** 识别文件：仅群聊；开启后群文件才落盘并进上下文（只读不执行） */
  file_recognize: boolean;
  sticker_output: boolean;
  web_search: boolean;
  /** 仅 @ 触发：开启后防抖/最大合并失效，仅被 @ 时回应 */
  at_only: boolean;
  /** 仅 @ 模式下是否记录其他（未 @）消息，默认开启；仅 @ 关闭时不可点 */
  at_only_record: boolean;
  /** 伪装思考：开启后允许模型先写 <think> 草稿（被剥离不外发，仅落盘复盘），默认关闭 */
  fake_think: boolean;
  /** 允许语音输出：开启后合格短句可转语音发送（需在「语音输出」页配好角色），默认关闭 */
  allow_voice: boolean;
  /** 独立人设（空 = 跟随全局） */
  system_prompt: string;
}

export const DEFAULT_SWITCH_STATE: SwitchState = {
  enabled: false,
  ai_only: false,
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
};

export function groupAvatarUrl(id: string): string {
  return `http://p.qlogo.cn/gh/${id}/${id}/100/`;
}

export function friendAvatarUrl(id: string): string {
  return `http://q.qlogo.cn/headimg_dl?dst_uin=${id}&spec=640`;
}

export function switchMetaBits(st: SwitchState): string[] {
  const bits: string[] = [];
  if (st.at_only) bits.push('仅@');
  if (st.image_recognize) bits.push('识图');
  if (st.file_recognize) bits.push('文件');
  if (st.web_search) bits.push('联网');
  if (st.sticker_output) bits.push('表情');
  if (st.fake_think) bits.push('思考');
  const rounds = normalizeScRoundsInput(st.rounds);
  if (rounds > 0) bits.push(`轮次${rounds}`);
  return bits;
}

export interface BalanceInfo {
  total_balance?: string | number;
  topped_up_balance?: string | number;
  granted_balance?: string | number;
  currency?: string;
}

export interface BalanceData {
  available?: boolean;
  error?: string;
  fetched_at?: string;
  display?: string;
  infos?: BalanceInfo[];
  meta?: Record<string, unknown>;
}

export function computeBalanceDisplay(vendor: VendorId, info: BalanceInfo | null, b: BalanceData): string {
  if (!info) return b.error || '—';
  if (vendor === 'nvidia') return `${info.total_balance} RPM`;
  return `${info.total_balance} ${info.currency || 'CNY'}`;
}

export function computeBalanceBarPct(vendor: VendorId, info: BalanceInfo | null, b: BalanceData): number | null {
  if (!info) return null;
  const topped = Number(info.topped_up_balance || 0);
  const granted = Number(info.granted_balance || 0);
  const total = Number(info.total_balance || 0) || topped + granted;
  if (vendor === 'nvidia') {
    const used = Number(b.meta?.rpm_used ?? topped);
    const limit = Number(b.meta?.rpm_limit ?? granted) || 40;
    return limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
  }
  return total > 0 ? (topped / total) * 100 : 0;
}

export function computeBalanceBadge(
  vendor: VendorId,
  available: boolean | undefined,
  barPct: number | null,
): { text: string; color: string } {
  const okColor = 'var(--mk-success, #16a34a)';
  const badColor = 'var(--mk-danger, #ef4444)';
  if (barPct != null && Number.isFinite(barPct) && vendor === 'nvidia') {
    return { text: `${available ? '用量 ' : '限速 '}${barPct.toFixed(1)}%`, color: available ? okColor : badColor };
  }
  if (available) {
    return { text: '可用', color: okColor };
  }
  return {
    text: vendor === 'nvidia' ? '接近限速' : '不可用',
    color: badColor,
  };
}

export function computeBalanceDetail(vendor: VendorId, info: BalanceInfo | null, b: BalanceData): string {
  if (!info) return b.error || '未配置余额地址或密钥';
  if (vendor === 'nvidia') {
    const tokenName = b.meta?.token_name ? `令牌「${b.meta.token_name}」 · ` : '';
    const hdrRem = b.meta?.header_remaining;
    const hdrLim = b.meta?.header_limit;
    const resetSec = b.meta?.reset_in_sec;
    const hdrPart =
      hdrRem != null || hdrLim != null ? `响应头剩余 ${hdrRem ?? '—'} / ${hdrLim ?? '—'}` : '响应头暂无（对话后会更新）';
    const resetPart = resetSec != null ? ` · 约 ${resetSec}s 后重置` : '';
    return `${tokenName}${hdrPart}${resetPart} · 更新于 ${b.fetched_at || '—'} · 本地统计近 60 秒请求；免费档常见约 40 RPM，官方无余额接口`;
  }
  return `更新于 ${b.fetched_at || '—'} · 进度条表示充值余额占比`;
}

export const SC_STICKER_JOB_KEY = 'mk_sc_sticker_job_';

export function rememberStickerInstallJob(galleryId: string, jobId: string) {
  try {
    if (galleryId && jobId) sessionStorage.setItem(SC_STICKER_JOB_KEY + galleryId, String(jobId));
  } catch { /* ignore */ }
}

export function forgetStickerInstallJob(galleryId: string) {
  try {
    sessionStorage.removeItem(SC_STICKER_JOB_KEY + galleryId);
  } catch { /* ignore */ }
}

export function isValidGroupScope(scope: string): boolean {
  return /^\d{5,12}$/.test(scope);
}
