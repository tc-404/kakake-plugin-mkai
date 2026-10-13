import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MkaiApiClient } from '../api';
import { useLiquidIndicator } from '../hooks/useLiquidIndicator';
import type { ToastFn } from '../notify';
import {
  DEFAULT_SWITCH_STATE,
  friendAvatarUrl,
  groupAvatarUrl,
  switchMetaBits,
} from '../smartChatLogic';
import { ModalPortal } from '../components/ModalPortal';
import { useSwitchController, type SwitchTab } from '../controllers/useSwitchController';

function Cap({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="switch-row__cap">
      <button
        type="button"
        className={`sc-kb-cap${on ? ' is-on' : ''}`}
        role="switch"
        aria-checked={on ? 'true' : 'false'}
        disabled={disabled}
        onClick={onToggle}
        style={disabled ? { opacity: 0.45 } : undefined}
      >
        <span className="sc-kb-cap__knob" />
      </button>
      <span className="sc-kb-cap__label">{label}</span>
    </div>
  );
}

function AvatarImg({ src, fallback }: { src: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span>{fallback}</span>;
  return (
    <img
      className="sw-card__avatar-img"
      src={src}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

export function SwitchPage({
  api,
  toast,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
}) {
  const c = useSwitchController({ api, toast });
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const tabIndex = c.tab === 'group' ? 0 : 1;
  const tabLiquid = useLiquidIndicator(tabIndex, 2, c.tab);

  const clearLongPress = () => {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const startLongPress = (next: SwitchTab) => {
    longPressFired.current = false;
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      c.setTab(next);
      c.setSearch('');
      c.setSearchOpen(true);
      toast('临时搜索已打开（切换界面后清空）', 'info');
      window.setTimeout(() => searchInputRef.current?.focus(), 50);
    }, 3000);
  };

  const switchTab = (next: SwitchTab) => {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    c.setTab(next);
    c.setSearch('');
    c.setSearchOpen(false);
  };

  useEffect(() => () => clearLongPress(), []);

  return (
    <section className="mkai-page-switch">
      <div className="sw-tabbar stagger-item stagger-2">
        <div className="seg seg--center" ref={tabLiquid.navRef as RefObject<HTMLDivElement>}>
          <div
            className={`nav-liquid${tabLiquid.box.ready ? ' is-ready' : ''}`}
            style={{
              transform: `translate3d(${tabLiquid.box.left}px, ${tabLiquid.box.top}px, 0)`,
              width: tabLiquid.box.width,
              height: tabLiquid.box.height,
            }}
            aria-hidden
          />
          <button
            type="button"
            ref={(el) => tabLiquid.setItemRef(0, el)}
            className={`seg__btn${c.tab === 'group' ? ' is-active' : ''}`}
            title="长按 3 秒打开临时搜索"
            onClick={() => switchTab('group')}
            onPointerDown={() => startLongPress('group')}
            onPointerUp={clearLongPress}
            onPointerLeave={clearLongPress}
            onPointerCancel={clearLongPress}
          >
            群聊
          </button>
          <button
            type="button"
            ref={(el) => tabLiquid.setItemRef(1, el)}
            className={`seg__btn${c.tab === 'friend' ? ' is-active' : ''}`}
            title="长按 3 秒打开临时搜索"
            onClick={() => switchTab('friend')}
            onPointerDown={() => startLongPress('friend')}
            onPointerUp={clearLongPress}
            onPointerLeave={clearLongPress}
            onPointerCancel={clearLongPress}
          >
            好友
          </button>
        </div>
      </div>

      {c.searchOpen ? (
        <div className="mk-search-field stagger-item stagger-3">
          <span className="mk-search-field__icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
          </span>
          <input
            ref={searchInputRef}
            type="search"
            className="mk-search-field__input"
            placeholder={c.tab === 'group' ? '临时搜索群名或群号…' : '临时搜索好友昵称或 QQ…'}
            value={c.search}
            onChange={(e) => c.setSearch(e.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            className="mk-search-field__clear"
            aria-label="关闭搜索"
            onClick={() => {
              c.setSearch('');
              c.setSearchOpen(false);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ) : null}

      <div className="stagger-item stagger-4">
        {c.loading ? (
          <div className="sw-skeleton-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="sw-skeleton" />
            ))}
          </div>
        ) : null}
        {!c.loading && !c.filtered.length ? (
          <div className="mk-state">{c.search.trim() ? '无匹配结果' : '暂无数据'}</div>
        ) : null}
        {!c.loading && c.filtered.length ? (
          <div className="sw-grid">
            {c.filtered.map((it, idx) => {
              const st = c.switchMap[it.id] || DEFAULT_SWITCH_STATE;
              const enabled = !!st.enabled;
              const isGroup = c.tab === 'group';
              const meta = switchMetaBits(st);
              return (
                <article
                  key={it.id}
                  className={`sw-card${enabled ? ' is-on' : ''} ${isGroup ? 'is-group' : 'is-friend'} stagger-item`}
                  style={{ animationDelay: `${0.05 + Math.min(idx, 12) * 0.04}s` }}
                >
                  <button
                    type="button"
                    className="sw-card__avatar"
                    title="更多设置"
                    onClick={() => void c.openModal(it.id, it.name)}
                  >
                    <AvatarImg
                      src={isGroup ? groupAvatarUrl(it.id) : friendAvatarUrl(it.id)}
                      fallback={(it.name || '?').charAt(0)}
                    />
                  </button>
                  <div className="sw-card__body">
                    <div className="sw-card__name" title={it.name}>{it.name}</div>
                    <div className="sw-card__meta">
                      {isGroup ? '群' : 'QQ'} {it.id}
                      {meta.length ? ` · ${meta.join(' · ')}` : ''}
                    </div>
                  </div>
                  <label className="toggle-switch sw-card__toggle" aria-label="开关">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        const next = e.target.checked;
                        void c.toggleEnabled(it.id, next).catch(() => {
                          e.target.checked = !next;
                        });
                      }}
                    />
                    <span className="toggle-slider" />
                  </label>
                </article>
              );
            })}
          </div>
        ) : null}
      </div>

      <ModalPortal open={c.modalOpen} onClose={() => c.setModalOpen(false)}>
          <div className="mk-modal mk-modal--enter" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="mk-modal__title">更多设置</h3>
            <p className="mk-hint" style={{ margin: '0 0 16px' }}>{c.draft.name} · {c.draft.id}</p>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">识别图片</div>
                <div className="switch-row__desc">异步识图；参数在「能力扩展」</div>
              </div>
              <Cap
                on={c.draft.image_recognize}
                label={c.draft.image_recognize ? '开' : '关'}
                onToggle={() => c.setDraft((d) => ({ ...d, image_recognize: !d.image_recognize }))}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">识别文件</div>
                <div className="switch-row__desc">
                  {c.tab === 'group'
                    ? '群文件存到插件目录并读进上下文，支持 txt/js/mjs/ts/go/sh/bat/log，单个 ≤500KB，只读不运行'
                    : '仅群聊可用，私聊没有群文件'}
                </div>
              </div>
              <Cap
                on={c.draft.file_recognize}
                label={c.draft.file_recognize ? '开' : '关'}
                disabled={c.tab !== 'group'}
                onToggle={() => {
                  if (c.tab !== 'group') {
                    toast('识别文件仅群聊可用', 'warn');
                    return;
                  }
                  c.setDraft((d) => ({ ...d, file_recognize: !d.file_recognize }));
                }}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">联网搜索</div>
                <div className="switch-row__desc">允许调用 web_search</div>
              </div>
              <Cap
                on={c.draft.web_search}
                label={c.draft.web_search ? '开' : '关'}
                onToggle={() => c.setDraft((d) => ({ ...d, web_search: !d.web_search }))}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">表情输出</div>
                <div className="switch-row__desc">
                  {c.stickerGalleryReady ? '可发送已装图库表情' : '请先在「能力扩展」安装图库'}
                </div>
              </div>
              <Cap
                on={c.draft.sticker_output}
                label={c.draft.sticker_output ? '开' : '关'}
                disabled={!c.stickerGalleryReady && !c.draft.sticker_output}
                onToggle={() => {
                  if (!c.stickerGalleryReady && !c.draft.sticker_output) {
                    toast('请先安装表情图库', 'warn');
                    return;
                  }
                  c.setDraft((d) => ({ ...d, sticker_output: !d.sticker_output }));
                }}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">是否仅@时触发</div>
                <div className="switch-row__desc">开启后防抖/最大合并失效，仅被 @ 时才回应</div>
              </div>
              <Cap
                on={c.draft.at_only}
                label={c.draft.at_only ? '开' : '关'}
                onToggle={() => c.setDraft((d) => ({ ...d, at_only: !d.at_only }))}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">仅艾特模式时是否记录其他消息</div>
                <div className="switch-row__desc">
                  {c.draft.at_only
                    ? '关闭则只记录被 @ 的那条消息'
                    : '需先开启「仅@时触发」'}
                </div>
              </div>
              <Cap
                on={c.draft.at_only_record}
                label={c.draft.at_only_record ? '开' : '关'}
                disabled={!c.draft.at_only}
                onToggle={() => {
                  if (!c.draft.at_only) {
                    toast('请先开启「仅@时触发」', 'warn');
                    return;
                  }
                  c.setDraft((d) => ({ ...d, at_only_record: !d.at_only_record }));
                }}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">伪装思考</div>
                <div className="switch-row__desc">开启后允许模型先写一段思考草稿，不发到群、仅后台留存复盘；模型自带思考时自动跳过</div>
              </div>
              <Cap
                on={c.draft.fake_think}
                label={c.draft.fake_think ? '开' : '关'}
                onToggle={() => c.setDraft((d) => ({ ...d, fake_think: !d.fake_think }))}
              />
            </div>

            <div className="switch-row">
              <div>
                <div className="switch-row__title">允许以语音形式输出</div>
                <div className="switch-row__desc">开启后，合格短句（净化后≤150字、无@/引用/特殊符号）可转语音发送；需先在「语音输出」页配好角色，单次回复最多两条语音，超长或失败自动回退文本</div>
              </div>
              <Cap
                on={c.draft.allow_voice}
                label={c.draft.allow_voice ? '开' : '关'}
                onToggle={() => c.setDraft((d) => ({ ...d, allow_voice: !d.allow_voice }))}
              />
            </div>

            <div className="mk-form-group" style={{ marginTop: 14 }}>
              <label className="mk-label">历史轮次</label>
              <input
                type="number"
                className="mk-input"
                min={0}
                max={999}
                value={c.draft.rounds}
                onChange={(e) => c.setDraft((d) => ({ ...d, rounds: Number(e.target.value) || 0 }))}
              />
              <p className="mk-hint">0 = 全部历史；1～999 = 最近 N 轮</p>
            </div>

            <div className="mk-form-group" style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <label className="mk-label" style={{ margin: 0 }}>独立人设</label>
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost mk-btn--sm"
                  onClick={() => c.setDraft((d) => ({ ...d, system_prompt: c.globalSystemPrompt }))}
                >
                  重置
                </button>
              </div>
              <textarea
                className="mk-input mk-input--prompt"
                rows={5}
                maxLength={1200}
                value={c.draft.system_prompt}
                onChange={(e) => {
                  const v = e.target.value.slice(0, 1200);
                  c.setDraft((d) => ({ ...d, system_prompt: v }));
                }}
                placeholder="默认跟随全局人格；可在此个性化"
                style={{ marginTop: 8, resize: 'vertical', minHeight: 100 }}
              />
              <p className="mk-hint" style={{ margin: '4px 0 0', textAlign: 'right' }}>
                {(c.draft.system_prompt || '').length}/1200
              </p>
            </div>

            <div className="mk-btn-row">
              <button type="button" className="mk-btn mk-btn--primary" onClick={() => void c.saveModal()}>保存</button>
              <button type="button" className="mk-btn mk-btn--ghost" onClick={() => c.setModalOpen(false)}>取消</button>
            </div>
          </div>
      </ModalPortal>
    </section>
  );
}