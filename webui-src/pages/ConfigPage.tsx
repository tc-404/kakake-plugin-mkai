import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { MkaiApiClient } from '../api';
import type { ConfirmFn, ToastFn } from '../notify';
import { ModalPortal } from '../components/ModalPortal';
import { useLiquidIndicator } from '../hooks/useLiquidIndicator';
import {
  ROTATION_MODE_OPTIONS,
  ROTATION_NOTES,
  SC_VENDOR_PRESETS,
  clampMeterPercent,
  computeBalanceDetail,
  computeBalanceDisplay,
  formatBytes,
  formatEtaSec,
  formatMeterPct,
  formatSpeed,
  formatTokenCount,
  isCustomVendorId,
  isWebSearchProviderConfigured,
  protocolLabel,
  type SmartChatConfig,
} from '../smartChatLogic';
import {
  DEFAULT_STICKER_SOURCE,
  STICKER_SOURCES,
  isGalleryJobRunning,
  stickerSourceLabel,
  useConfigController,
  type ConfigSection,
  type GalleryRow,
  type StickerSourceId,
} from '../controllers/useConfigController';

function Meter({
  title,
  pct,
  sub,
  warnBelow,
  balance,
  badgeText,
  badgeColor,
}: {
  title: string;
  pct: number | null;
  sub: string;
  warnBelow?: number | null;
  balance?: boolean;
  badgeText?: string;
  badgeColor?: string;
}) {
  const width = clampMeterPercent(pct ?? 0);
  const warn = warnBelow != null && pct != null && pct < warnBelow;
  return (
    <div className="sc-meter">
      <div className="sc-meter__head">
        <span className="sc-meter__title">{title}</span>
        <span className="sc-meter__pct" style={badgeColor ? { color: badgeColor } : undefined}>
          {badgeText ?? formatMeterPct(pct)}
        </span>
      </div>
      <div className="sc-meter__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)}>
        <div
          className={`sc-meter__fill${balance ? ' sc-meter__fill--balance' : ''}${warn ? ' sc-meter__fill--warn' : ''}`}
          style={{ width: `${width.toFixed(1)}%` }}
        />
      </div>
      <p className="sc-meter__sub">{sub}</p>
    </div>
  );
}

export function ConfigPage({
  api,
  toast,
  confirm,
  section,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
  section: ConfigSection;
}) {
  /**
   * 「选安装源」悬浮窗状态。
   *
   * 为什么用 Promise + resolver 而不是布尔 state：安装是 async 流程，
   * 需要在 onClick 里「弹窗 → await 用户选择 → 继续下载」。用 state 就得
   * 把整条流程拆成回调，反而更难读。这里把 resolve 存进 ref，关闭时一次性settle。
   */
  const [sourcePicker, setSourcePicker] = useState<{ gallery: GalleryRow; selected: StickerSourceId } | null>(null);
  const sourceResolverRef = useRef<((v: StickerSourceId | null) => void) | null>(null);

  const pickStickerSource = useCallback(async (gallery: GalleryRow): Promise<StickerSourceId | null> => {
    // 已有弹窗未关（连点）：先按取消结算旧的，避免 Promise 泄漏
    sourceResolverRef.current?.(null);
    return new Promise<StickerSourceId | null>((resolve) => {
      sourceResolverRef.current = resolve;
      setSourcePicker({ gallery, selected: DEFAULT_STICKER_SOURCE });
    });
  }, []);

  const closeSourcePicker = useCallback((picked: StickerSourceId | null) => {
    const resolve = sourceResolverRef.current;
    sourceResolverRef.current = null;
    setSourcePicker(null);
    resolve?.(picked);
  }, []);

  const c = useConfigController({ api, toast, confirm, section, pickStickerSource });
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const rotModeIndex = Math.max(
    0,
    ROTATION_MODE_OPTIONS.findIndex((o) => o.value === c.rotation.mode),
  );
  const rotLiquid = useLiquidIndicator(rotModeIndex, ROTATION_MODE_OPTIONS.length, c.rotation.mode);

  useEffect(() => {
    if (!c.modelListOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const el = modelPickerRef.current;
      if (el && !el.contains(ev.target as Node)) {
        c.setModelListOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [c.modelListOpen, c.setModelListOpen]);
  const u = c.usage as {
    total_tokens?: number;
    total_cache_hit_tokens?: number;
    total_prompt_tokens?: number;
    total_requests?: number;
    cache_hit_rate_percent?: number;
    today?: {
      total_tokens?: number;
      cache_hit_tokens?: number;
      prompt_tokens?: number;
      requests?: number;
      cache_hit_rate_percent?: number;
    };
    last?: {
      at?: string;
      prompt_tokens?: number;
      prompt_cache_hit_tokens?: number;
      cache_hit_rate_percent?: number;
      completion_tokens?: number;
      total_tokens?: number;
      model?: string;
    };
  };

  return (
    <section className="mkai-page-config">
      {section === 'model' ? (
        <>
          <div className="panel stagger-item stagger-2">
            <div className="field field-span-2" style={{ marginBottom: 14 }}>
              <div className="vendor-grid" role="radiogroup" aria-label="上游厂商">
                {Object.values(SC_VENDOR_PRESETS).map((p) => {
                  const active = !c.addingCustom && c.vendor === p.id;
                  const previewModel = p.id === 'nvidia'
                    ? String(p.default_model).split('/').pop() || p.default_model
                    : p.default_model;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`vendor-card${active ? ' is-active' : ''}`}
                      onClick={() => c.onVendorChange(p.id)}
                    >
                      <span className="vendor-card__name">{p.name}</span>
                      <span className="vendor-card__model">{previewModel}</span>
                    </button>
                  );
                })}
                {c.customVendors.map((cv) => {
                  const active = !c.addingCustom && c.vendor === cv.id;
                  return (
                    <button
                      key={cv.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`vendor-card vendor-card--custom${active ? ' is-active' : ''}`}
                      onClick={() => c.onVendorChange(cv.id)}
                    >
                      <span className="vendor-card__name-row">
                        <span className="vendor-card__name">{cv.name}</span>
                        <span className={`vendor-card__tag${cv.api_protocol === 'anthropic' ? ' vendor-card__tag--anthropic' : ''}`}>
                          {protocolLabel(cv.api_protocol)}
                        </span>
                      </span>
                      <span className="vendor-card__model">{String(cv.model).split('/').pop() || cv.model}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`vendor-card vendor-card--add${c.addingCustom && c.model.apiProtocol === 'openai' ? ' is-active' : ''}`}
                  aria-label="新增 OpenAI 兼容厂商"
                  title="新增 OpenAI 兼容厂商"
                  onClick={() => c.startAddCustom('openai')}
                >
                  <span className="vendor-card__corner">OpenAI</span>
                  <span className="vendor-card__plus" aria-hidden>+</span>
                </button>
                <button
                  type="button"
                  className={`vendor-card vendor-card--add${c.addingCustom && c.model.apiProtocol === 'anthropic' ? ' is-active' : ''}`}
                  aria-label="新增 Anthropic 厂商"
                  title="新增 Anthropic Messages API 厂商"
                  onClick={() => c.startAddCustomAnthropic()}
                >
                  <span className="vendor-card__corner vendor-card__corner--anthropic">Anthropic</span>
                  <span className="vendor-card__plus" aria-hidden>+</span>
                </button>
              </div>
              {!c.isCustom && c.preset.website ? (
                <p className="mk-hint" style={{ marginTop: 8 }}>
                  获取 API Key：
                  <a href={c.preset.website} target="_blank" rel="noopener noreferrer">{c.preset.website}</a>
                  {c.preset.docs ? (
                    <> · 文档 <a href={c.preset.docs} target="_blank" rel="noopener noreferrer">查看</a></>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div className="form-grid">
              {c.isCustom ? (
                <div className="field field-span-2">
                  <label className="mk-label">厂商名称</label>
                  <input
                    type="text"
                    className="mk-input"
                    placeholder="例如：硅基流动 / 本地 Ollama"
                    value={c.model.customName || ''}
                    onChange={(e) => c.setModel((m) => ({ ...m, customName: e.target.value }))}
                  />
                </div>
              ) : null}
              <div className="field">
                <label className="mk-label">API Key</label>
                <input
                  type="text"
                  className={`mk-input mk-input--secret${c.keyTone === 'ok' ? ' mk-input--ok' : ''}${c.keyTone === 'err' ? ' mk-input--err' : ''}`}
                  name="mkai-sc-api-key"
                  placeholder={
                    c.isCustom
                      ? (c.customVendors.find((cv) => cv.id === c.vendor)?.api_key_set ? '已配置（留空不修改）' : '粘贴 API Key')
                      : (c.cfg.api_key_set ? '已配置（留空不修改）' : '粘贴 API Key')
                  }
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-form-type="other"
                  value={c.model.apiKey}
                  onChange={(e) => {
                    const v = e.target.value;
                    c.setModel((m) => ({ ...m, apiKey: v }));
                    if (c.keyTone === 'err') c.setKeyTone('default');
                    else if (!v.trim() && !c.cfg.api_key_set) c.setKeyTone('default');
                    else if (v.trim()) c.setKeyTone('default');
                  }}
                />
              </div>
              <div className="field">
                <label className="mk-label">Base URL</label>
                <input
                  type="text"
                  className="mk-input"
                  placeholder={c.isCustom ? 'https://api.example.com/v1' : c.preset.base_url}
                  value={c.model.baseUrl}
                  onChange={(e) => c.setModel((m) => ({ ...m, baseUrl: e.target.value }))}
                />
              </div>
              {!c.labels.hideBalanceUrl ? (
                <div className="field">
                  <label className="mk-label">Balance URL</label>
                  <input
                    type="text"
                    className="mk-input"
                    placeholder={c.isCustom ? '留空自动' : c.preset.balance_url}
                    value={c.model.balanceUrl}
                    onChange={(e) => c.setModel((m) => ({ ...m, balanceUrl: e.target.value }))}
                  />
                </div>
              ) : null}
              <div className="field">
                <label className="mk-label">模型</label>
                {c.isCustom ? (
                  <div className="mk-model-picker" ref={modelPickerRef}>
                    <div className="mk-input-with-action">
                      <input
                        type="text"
                        className="mk-input"
                        placeholder="模型 ID，仅填一个"
                        value={c.model.model}
                        onChange={(e) => c.setModel((m) => ({ ...m, model: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="mk-input-with-action__btn"
                        title="拉取模型列表"
                        disabled={c.fetchingModels}
                        onClick={() => void c.fetchModelList()}
                      >
                        {c.fetchingModels ? '…' : '↻'}
                      </button>
                    </div>
                    {c.modelListOpen && c.modelOptions.length > 0 ? (
                      <div className="mk-model-list" role="listbox" aria-label="模型列表">
                        <div className="mk-model-list__head">
                          <span>{c.modelOptions.length} 个模型</span>
                          <button
                            type="button"
                            className="mk-model-list__close"
                            aria-label="关闭"
                            onClick={() => c.setModelListOpen(false)}
                          >
                            ×
                          </button>
                        </div>
                        <ul className="mk-model-list__items">
                          {c.modelOptions.map((id) => (
                            <li key={id}>
                              <button
                                type="button"
                                className="mk-model-list__item"
                                role="option"
                                aria-selected={c.model.model === id}
                                onClick={() => {
                                  c.setModel((m) => ({ ...m, model: id }));
                                  c.setModelListOpen(false);
                                  toast(`已选择 ${id}`, 'ok');
                                }}
                              >
                                {id}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <select
                    className="mk-input"
                    value={c.model.model}
                    onChange={(e) => c.selectModel(e.target.value)}
                  >
                    {c.preset.models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                )}
              </div>
              {c.isCustom ? (
                <div className="field">
                  <label className="mk-label">Chat Path</label>
                  <input
                    type="text"
                    className="mk-input"
                    placeholder={
                      c.model.apiProtocol === 'anthropic'
                        ? '/v1/messages'
                        : '/v1/chat/completions'
                    }
                    value={c.model.chatPath ?? ''}
                    onChange={(e) => c.setModel((m) => ({ ...m, chatPath: e.target.value }))}
                  />
                </div>
              ) : null}
              <div className="field">
                <label className="mk-label">Temperature</label>
                <input
                  type="number"
                  className="mk-input"
                  step={0.1}
                  min={0}
                  max={2}
                  value={c.model.temperature}
                  onChange={(e) => c.setModel((m) => ({ ...m, temperature: Number(e.target.value) }))}
                />
              </div>
              <div className="field">
                <label className="mk-label">Max tokens</label>
                <input
                  type="number"
                  className="mk-input"
                  min={64}
                  max={16384}
                  value={c.model.maxTokens}
                  onChange={(e) => c.setModel((m) => ({ ...m, maxTokens: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div className="mk-btn-row">
              <button type="button" className="mk-btn mk-btn--primary" onClick={() => void c.saveConfig()}>保存</button>
              {c.isCustom ? (
                <>
                  <button
                    type="button"
                    className="mk-btn mk-btn--ghost"
                    disabled={c.probeBusy}
                    onClick={() => void c.testProbe()}
                  >
                    {c.probeBusy ? '测试中…' : '测试访问'}
                  </button>
                  {!c.addingCustom && isCustomVendorId(String(c.vendor)) ? (
                    <button
                      type="button"
                      className="mk-btn mk-btn--danger"
                      onClick={() => void c.deleteCustomVendor(String(c.vendor))}
                    >
                      删除
                    </button>
                  ) : null}
                  {c.addingCustom ? (
                    <button
                      type="button"
                      className="mk-btn mk-btn--ghost"
                      onClick={() => {
                        c.setAddingCustom(false);
                        c.setProbeLog('');
                        void c.loadConfig();
                      }}
                    >
                      取消
                    </button>
                  ) : null}
                </>
              ) : (
                <button type="button" className="mk-btn mk-btn--ghost" onClick={() => void c.testConnection()}>连通性测试</button>
              )}
            </div>
            {c.isCustom ? (
              <div className="field" style={{ marginTop: 12 }}>
                <label className="mk-label">测试访问输出</label>
                <pre className="mk-probe-log">{c.probeLog || '点击「测试访问」将只发送「你好」，不加载插件系统提示词。'}</pre>
              </div>
            ) : (
              <div className="field" style={{ marginTop: 12 }}>
                <label className="mk-label">连通性测试输出</label>
                <pre className="mk-probe-log">{c.probeLog || '点击「连通性测试」将用当前配置发送「你好」，返回模型真实输出。'}</pre>
              </div>
            )}
          </div>

          <div className="panel stagger-item stagger-3">
            <h2 className="panel-title">额度概览</h2>
            <div className="mk-cs-stats">
              <div className="mk-cs-stat mk-cs-stat--accent">
                <span className="mk-cs-stat__label">{c.labels.totalLabel}</span>
                <span className="mk-cs-stat__value">{computeBalanceDisplay(c.vendor, c.info, c.balance)}</span>
              </div>
              <div className="mk-cs-stat">
                <span className="mk-cs-stat__label">累计 tokens</span>
                <span className="mk-cs-stat__value">{formatTokenCount(u.total_tokens ?? 0)}</span>
              </div>
              <div className="mk-cs-stat">
                <span className="mk-cs-stat__label">今日 tokens</span>
                <span className="mk-cs-stat__value">{formatTokenCount(u.today?.total_tokens ?? 0)}</span>
              </div>
              {!c.labels.hideCache ? (
                <div className="mk-cs-stat mk-cs-stat--ok">
                  <span className="mk-cs-stat__label">累计缓存命中</span>
                  <span className="mk-cs-stat__value">
                    {u.cache_hit_rate_percent != null
                      ? `${formatTokenCount(u.total_cache_hit_tokens ?? 0)} (${u.cache_hit_rate_percent}%)`
                      : formatTokenCount(u.total_cache_hit_tokens ?? 0)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel stagger-item stagger-4">
            <h2 className="panel-title">用量详情</h2>
            {!c.labels.hideCache ? (
              <>
                <Meter
                  title="缓存命中率（累计 prompt）"
                  pct={u.cache_hit_rate_percent ?? null}
                  warnBelow={70}
                  sub={`命中 ${formatTokenCount(u.total_cache_hit_tokens || 0)} / prompt ${formatTokenCount(u.total_prompt_tokens || 0)} · 请求 ${u.total_requests || 0} 次`}
                />
                <Meter
                  title="今日缓存命中率"
                  pct={u.today?.cache_hit_rate_percent ?? null}
                  warnBelow={70}
                  sub={`今日命中 ${formatTokenCount(u.today?.cache_hit_tokens || 0)} / prompt ${formatTokenCount(u.today?.prompt_tokens || 0)} · ${u.today?.requests || 0} 次`}
                />
              </>
            ) : null}

            <div className="sc-meter">
              <div className="sc-meter__head">
                <span className="sc-meter__title">{c.labels.meterTitle}</span>
                <span className="sc-meter__pct" style={{ color: c.badge.color }}>{c.badge.text}</span>
              </div>
              <div className="sc-meter__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clampMeterPercent(c.barPct ?? 0))}>
                <div className="sc-meter__fill sc-meter__fill--balance" style={{ width: `${clampMeterPercent(c.barPct ?? 0).toFixed(1)}%` }} />
              </div>
              <div className="sc-balance-split">
                <div className="sc-balance-split__item">
                  <span>{c.labels.toppedLabel}</span>
                  <strong>
                    {c.info
                      ? (c.vendor === 'nvidia'
                        ? `${c.info.topped_up_balance} 次`
                        : `${c.info.topped_up_balance} ${c.info.currency || ''}`.trim())
                      : '—'}
                  </strong>
                </div>
                <div className="sc-balance-split__item">
                  <span>{c.labels.grantedLabel}</span>
                  <strong>
                    {c.info
                      ? (c.vendor === 'nvidia'
                        ? `${c.info.granted_balance} RPM`
                        : `${c.info.granted_balance} ${c.info.currency || ''}`.trim())
                      : '—'}
                  </strong>
                </div>
              </div>
              <p className="sc-meter__sub">{computeBalanceDetail(c.vendor, c.info, c.balance)}</p>
            </div>

            <p className="mk-hint" style={{ margin: '12px 0' }}>
              {u.last
                ? `最近一次：${u.last.at || ''} · prompt ${u.last.prompt_tokens}（命中 ${u.last.prompt_cache_hit_tokens || 0} / ${u.last.cache_hit_rate_percent ?? '—'}%）· completion ${u.last.completion_tokens} · ${u.last.model || ''}`
                : '暂无本地用量记录'}
            </p>
            <div className="mk-btn-row">
              <button type="button" className="mk-btn mk-btn--primary" disabled={c.balanceLoading} onClick={() => void c.loadBalance(true)}>
                {c.balanceLoading ? '查询中…' : c.labels.refreshBtn}
              </button>
              <button type="button" className="mk-btn mk-btn--ghost" onClick={() => void c.clearUsage()}>清空本地用量账本</button>
            </div>
          </div>
        </>
      ) : null}

      {section === 'policy' ? (
        <div className="panel stagger-item stagger-2">
          <h2 className="panel-title">对话行为</h2>
          <div className="form-grid">
            <div className="field">
              <label className="mk-label">防抖 (ms)</label>
              <input type="number" className="mk-input" min={1000} max={120000} value={c.context.debounceMs} onChange={(e) => c.setContext((cx) => ({ ...cx, debounceMs: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">最大合并条数</label>
              <input type="number" className="mk-input" min={1} max={25} value={c.context.maxBatch} onChange={(e) => c.setContext((cx) => ({ ...cx, maxBatch: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">随机等待</label>
              <select className="mk-input" value={c.context.randomWaitEnabled ? 'on' : 'off'} onChange={(e) => c.setContext((cx) => ({ ...cx, randomWaitEnabled: e.target.value === 'on' }))}>
                <option value="on">开启（每条消息重抽）</option>
                <option value="off">关闭（用固定防抖）</option>
              </select>
            </div>
            <div className="field">
              <label className="mk-label">随机等待下限 (分钟)</label>
              <input type="number" className="mk-input" min={1} max={60} value={c.context.randomWaitMinMin} onChange={(e) => c.setContext((cx) => ({ ...cx, randomWaitMinMin: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">随机等待上限 (分钟)</label>
              <input type="number" className="mk-input" min={1} max={60} value={c.context.randomWaitMaxMin} onChange={(e) => c.setContext((cx) => ({ ...cx, randomWaitMaxMin: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">连发间隔 (ms)</label>
              <input type="number" className="mk-input" min={400} max={8000} step={100} value={c.context.replyGapMs} onChange={(e) => c.setContext((cx) => ({ ...cx, replyGapMs: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">闭嘴上限</label>
              <input type="number" className="mk-input" min={1} max={50} value={c.context.shutUpLimit} onChange={(e) => c.setContext((cx) => ({ ...cx, shutUpLimit: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">没人对你说话时闭嘴 (%)</label>
              <input type="number" className="mk-input" min={0} max={100} step={5} value={c.context.silenceVetoPercent} onChange={(e) => c.setContext((cx) => ({ ...cx, silenceVetoPercent: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">行为下限</label>
              <input type="number" className="mk-input" min={0} max={10} value={c.context.actionMin} onChange={(e) => c.setContext((cx) => ({ ...cx, actionMin: Number(e.target.value) }))} />
            </div>
            <div className="field">
              <label className="mk-label">行为上限</label>
              <input type="number" className="mk-input" min={1} max={10} value={c.context.actionMax} onChange={(e) => c.setContext((cx) => ({ ...cx, actionMax: Number(e.target.value) }))} />
            </div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <label className="mk-label" style={{ margin: 0 }}>【你是谁】（全局人格）</label>
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirm({
                      title: '恢复内置默认',
                      message: '将全局人格恢复为插件内置默认？群/好友若未设独立人设会跟随后续保存生效。未保存的修改会丢失（仍需点「保存」才会写入）。',
                      okText: '恢复',
                    });
                    if (!ok) return;
                    c.setContext((cx) => ({ ...cx, systemPrompt: c.defaultPrompt || cx.systemPrompt }));
                    toast('已恢复内置默认（请保存生效）', 'ok');
                  })();
                }}
              >
                恢复默认
              </button>
            </div>
            <textarea
              className="mk-input mk-input--prompt"
              rows={6}
              maxLength={1200}
              value={c.context.systemPrompt}
              onChange={(e) => {
                const v = e.target.value.slice(0, 1200);
                c.setContext((cx) => ({ ...cx, systemPrompt: v }));
              }}
              placeholder="你是群里的「喵喵」：日常摸鱼的熟人损友……"
            />
            <p className="mk-hint" style={{ margin: '4px 0 0', textAlign: 'right' }}>
              {(c.context.systemPrompt || '').length}/1200 · 最多 1200 字
            </p>
          </div>
          <div className="mk-btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="mk-btn mk-btn--primary" onClick={() => void c.saveConfig()}>保存</button>
          </div>
        </div>
      ) : null}

      {section === 'skills' ? (
        <>
          <details className="fold-panel stagger-item stagger-2">
            <summary className="fold-panel__summary">
              <span>工具技能</span>
              <span className="fold-panel__meta">{c.toolSkills.length} 项</span>
            </summary>
            <div className="fold-panel__body">
              <div className="sc-kb-list">
                {c.toolSkills.map((t) => (
                  <div key={t.code} className="sc-kb-row">
                    <div className="sc-kb-row__main">
                      <strong>{t.title || t.code}</strong>
                      <p className="mk-hint" style={{ margin: '4px 0 0' }}>{t.when || t.params || ''}</p>
                    </div>
                    <label className="toggle-switch">
                      <input type="checkbox" checked={!!t.enabled} onChange={(e) => void c.toggleTool(t.code, e.target.checked)} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}
                {!c.toolSkills.length ? <div className="mk-state">暂无工具技能</div> : null}
              </div>
            </div>
          </details>

          <details className="fold-panel stagger-item stagger-3">
            <summary className="fold-panel__summary">
              <span>表情图库</span>
              <span className="fold-panel__meta">{c.galleryReady ? '已就绪' : '未就绪'}</span>
            </summary>
            <div className="fold-panel__body">
              <p className="mk-hint" style={{ margin: '0 0 12px' }}>{c.galleryReady ? '图库服务已就绪' : '需安装图库后可用'}</p>
              <div className="sc-sticker-gallery-list">
                {c.galleries.map((g) => {
                  const prog = g.activeJob;
                  const running = isGalleryJobRunning(prog);
                  const pct = clampMeterPercent(prog?.percent);
                  const downloaded = prog?.downloadedBytes ?? prog?.downloaded;
                  const total = prog?.totalBytes ?? prog?.total;
                  const statusLabel = prog?.status === 'extracting'
                    ? '解压中'
                    : running
                      ? '下载中'
                      : g.installed
                        ? `已安装 · ${g.imageCount ?? 0} 张`
                        : '未安装';
                  return (
                    <div key={g.id} className="sc-sticker-card">
                      <div className="sc-sticker-card__top">
                        <strong>{g.name || g.id}</strong>
                        <span>{statusLabel}</span>
                      </div>
                      {running ? (
                        <div className="sc-sticker-progress is-on">
                          <div className="sc-sticker-progress__track">
                            <div className="sc-sticker-progress__fill" style={{ width: `${pct.toFixed(1)}%` }} />
                          </div>
                          <p className="sc-sticker-progress__meta">
                            {prog?.status === 'extracting'
                              ? '正在解压覆盖安装…'
                              : `${formatMeterPct(prog?.percent)} · ${formatBytes(downloaded)} / ${formatBytes(total)} · ${formatSpeed(prog?.speedBps)} · ${formatEtaSec(prog?.etaSec)}`}
                          </p>
                        </div>
                      ) : null}
                      {prog?.error ? <p className="mk-hint" style={{ color: '#dc2626' }}>{prog.error}</p> : null}
                      {!running && prog?.source ? (
                        <p className="sc-sticker-card__source">上次安装源：{stickerSourceLabel(prog.source)}</p>
                      ) : null}
                      <div className="mk-btn-row">
                        <button
                          type="button"
                          className="mk-btn mk-btn--primary mk-btn--sm"
                          disabled={!!running}
                          onClick={() => void c.installGallery(g.id)}
                        >
                          {running ? '安装中…' : g.installed ? '重新安装' : '安装'}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!c.galleries.length ? <div className="mk-state">暂无图库定义</div> : null}
              </div>
            </div>
          </details>

          {/* 安装源选择悬浮窗：点「安装/重新安装」时弹出 */}
          <ModalPortal open={!!sourcePicker} onClose={() => closeSourcePicker(null)}>
            <div
              className="mk-modal mk-modal--enter sc-source-modal"
              role="dialog"
              aria-modal="true"
              aria-label="选择安装源"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mk-modal__title">选择安装源</h3>
              <p className="mk-hint" style={{ margin: '0 0 14px' }}>
                即将安装「{sourcePicker?.gallery.name || sourcePicker?.gallery.id}」，请选择从哪个源下载。
              </p>
              <div className="sc-source-list" role="radiogroup" aria-label="安装源">
                {STICKER_SOURCES.map((s) => {
                  const active = sourcePicker?.selected === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`sc-source-opt${active ? ' is-active' : ''}`}
                      onClick={() => setSourcePicker((p) => (p ? { ...p, selected: s.id } : p))}
                    >
                      <span className="sc-source-opt__radio" aria-hidden="true" />
                      <span className="sc-source-opt__body">
                        <strong className="sc-source-opt__label">{s.label}</strong>
                        <span className="sc-source-opt__desc">{s.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="mk-btn-row">
                <button
                  type="button"
                  className="mk-btn mk-btn--primary"
                  onClick={() => {
                    const picked = sourcePicker?.selected || DEFAULT_STICKER_SOURCE;
                    closeSourcePicker(picked);
                  }}
                >
                  开始安装
                </button>
                <button type="button" className="mk-btn mk-btn--ghost" onClick={() => closeSourcePicker(null)}>
                  取消
                </button>
              </div>
            </div>
          </ModalPortal>

          <details className="fold-panel stagger-item stagger-4">
            <summary className="fold-panel__summary">
              <span>联网与识别</span>
              <span className="fold-panel__meta">参数 / Key</span>
            </summary>
            <div className="fold-panel__body">
            <div className="sc-param-box">
              <strong className="sc-param-box__title">识别图片参数</strong>
              <div className="sc-param-grid">
                <div className="field">
                  <label className="mk-label">工具轮上限</label>
                  <input type="number" className="mk-input" min={1} max={5} value={c.online.toolsMaxRounds} onChange={(e) => c.setOnline((o) => ({ ...o, toolsMaxRounds: Number(e.target.value) }))} />
                </div>
                <div className="field">
                  <label className="mk-label">超时（秒）</label>
                  <input type="number" className="mk-input" min={5} max={120} value={c.online.imageRecognize.timeout_sec} onChange={(e) => c.setOnline((o) => ({ ...o, imageRecognize: { ...o.imageRecognize, timeout_sec: Number(e.target.value) } }))} />
                </div>
                <div className="field">
                  <label className="mk-label">普通排队上限</label>
                  <input type="number" className="mk-input" min={1} max={20} value={c.online.imageRecognize.queue_normal} onChange={(e) => c.setOnline((o) => ({ ...o, imageRecognize: { ...o.imageRecognize, queue_normal: Number(e.target.value) } }))} />
                </div>
                <div className="field">
                  <label className="mk-label">艾特排队上限</label>
                  <input type="number" className="mk-input" min={1} max={20} value={c.online.imageRecognize.queue_at} onChange={(e) => c.setOnline((o) => ({ ...o, imageRecognize: { ...o.imageRecognize, queue_at: Number(e.target.value) } }))} />
                </div>
                <div className="field">
                  <label className="mk-label">普通单条最多</label>
                  <input type="number" className="mk-input" min={1} max={10} value={c.online.imageRecognize.per_msg_normal} onChange={(e) => c.setOnline((o) => ({ ...o, imageRecognize: { ...o.imageRecognize, per_msg_normal: Number(e.target.value) } }))} />
                </div>
                <div className="field">
                  <label className="mk-label">艾特单条最多</label>
                  <input type="number" className="mk-input" min={1} max={10} value={c.online.imageRecognize.per_msg_at} onChange={(e) => c.setOnline((o) => ({ ...o, imageRecognize: { ...o.imageRecognize, per_msg_at: Number(e.target.value) } }))} />
                </div>
              </div>
            </div>

            <div className="sc-provider-grid" style={{ marginTop: 16 }}>
              {c.providers.map((p) => {
                const configured = isWebSearchProviderConfigured(p.id, c.cfg, c.clearFlags);
                const masked = c.cfg.web_search_masked?.[`${p.id}_key` as keyof NonNullable<SmartChatConfig['web_search_masked']>];
                return (
                  <div key={p.id} className={`sc-provider-card${configured ? ' is-configured' : ''}`}>
                    <div className="sc-provider-card__top">
                      <strong>{p.name}</strong>
                      <span className="sc-provider-card__badge">{configured ? '已配置' : '未配置'}</span>
                    </div>
                    <p className="sc-provider-card__links">
                      获取 Key：
                      <a href={p.home} target="_blank" rel="noopener noreferrer">{p.home}</a>
                      {p.docs ? <> · <a href={p.docs} target="_blank" rel="noopener noreferrer">文档</a></> : null}
                    </p>
                    <input
                      type="text"
                      className="mk-input mk-input--secret sc-provider-key"
                      name={`mkai-ws-${p.id}`}
                      placeholder={configured ? `已配置 ${masked || ''}（留空不修改）` : '粘贴 API Key'}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-form-type="other"
                      value={c.online.keys[p.id]}
                      onChange={(e) => c.setOnline((o) => ({ ...o, keys: { ...o.keys, [p.id]: e.target.value } }))}
                    />
                    <div className="mk-btn-row" style={{ marginTop: 8 }}>
                      <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={() => void c.testWebSearch(p.id)}>测试</button>
                      <button
                        type="button"
                        className="mk-btn mk-btn--ghost mk-btn--sm"
                        onClick={() => {
                          c.setClearFlags((f) => ({ ...f, [p.id]: true }));
                          c.setOnline((o) => ({ ...o, keys: { ...o.keys, [p.id]: '' } }));
                          toast('已标记清空，请点「保存联网配置」生效');
                        }}
                      >
                        清空 Key
                      </button>
                      <span className={`sc-provider-card__status${c.providerStatus[p.id].includes('正常') ? ' is-ok' : c.providerStatus[p.id] && c.providerStatus[p.id] !== '测试中…' ? ' is-err' : ''}`}>
                        {c.providerStatus[p.id]}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mk-btn-row" style={{ marginTop: 14 }}>
              <button type="button" className="mk-btn mk-btn--primary" onClick={() => void c.saveOnline()}>保存联网配置</button>
            </div>
            </div>
          </details>
        </>
      ) : null}
      {section === 'rotation' ? (
        <div className="panel stagger-item stagger-2">
          <h2 className="panel-title">模型轮替</h2>

          <div className="switch-row">
            <div>
              <div className="switch-row__title">是否开启自动轮替</div>
              <div className="switch-row__desc">默认关闭；开启后 API 访问报错会按下面的方式自动换模型重试</div>
            </div>
            <label className="toggle-switch" aria-label="是否开启自动轮替">
              <input
                type="checkbox"
                checked={c.rotation.enabled}
                onChange={(e) => c.setRotation((r) => ({ ...r, enabled: e.target.checked }))}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <div className="switch-row">
            <div>
              <div className="switch-row__title">切换方式</div>
              <div className="switch-row__desc">右侧为轮替次数上限，0 = 不限，把候选全试完才算失败</div>
            </div>
            <input
              type="number"
              className="mk-input sc-rot-limit"
              min={0}
              max={20}
              step={1}
              value={c.rotation.limit}
              aria-label="轮替次数上限"
              onChange={(e) => {
                const n = Math.min(20, Math.max(0, Math.round(Number(e.target.value) || 0)));
                c.setRotation((r) => ({ ...r, limit: n }));
              }}
            />
          </div>

          <div className="seg seg--center sc-rot-seg" ref={rotLiquid.navRef as RefObject<HTMLDivElement>}>
            <div
              className={`nav-liquid${rotLiquid.box.ready ? ' is-ready' : ''}`}
              style={{
                transform: `translate3d(${rotLiquid.box.left}px, ${rotLiquid.box.top}px, 0)`,
                width: rotLiquid.box.width,
                height: rotLiquid.box.height,
              }}
              aria-hidden
            />
            {ROTATION_MODE_OPTIONS.map((o, i) => (
              <button
                key={o.value}
                type="button"
                ref={(el) => rotLiquid.setItemRef(i, el)}
                className={`seg__btn${c.rotation.mode === o.value ? ' is-active' : ''}`}
                title={o.full}
                onClick={() => c.setRotation((r) => ({ ...r, mode: o.value }))}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="sc-rot-notes">
            {ROTATION_NOTES.map((line) => (
              <p key={line} className="mk-hint sc-rot-notes__line">{line}</p>
            ))}
          </div>

          <div className="mk-btn-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="mk-btn mk-btn--primary"
              disabled={c.rotationSaving}
              onClick={() => void c.saveRotation()}
            >
              {c.rotationSaving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}