import { type RefObject } from 'react';
import type { MkaiApiClient } from '../api';
import { useLiquidIndicator } from '../hooks/useLiquidIndicator';
import type { ConfirmFn, ToastFn } from '../notify';
import { useBlacklistController } from '../controllers/useBlacklistController';

export function BlacklistPage({
  api,
  toast,
  confirm,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}) {
  const c = useBlacklistController({ api, toast, confirm });
  const tabIndex = c.tab === 'group' ? 0 : 1;
  const tabLiquid = useLiquidIndicator(tabIndex, 2, c.tab);

  return (
    <section className="mkai-page-blacklist">
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
            onClick={() => c.setTab('group')}
          >
            群聊
          </button>
          <button
            type="button"
            ref={(el) => tabLiquid.setItemRef(1, el)}
            className={`seg__btn${c.tab === 'user' ? ' is-active' : ''}`}
            onClick={() => c.setTab('user')}
          >
            用户
          </button>
        </div>
      </div>

      <div className="panel stagger-item stagger-3">
        <div className="bl-add-row">
          <input
            className="mk-input"
            placeholder={c.tab === 'group' ? '输入群号，多个用空格或逗号分隔' : '输入 QQ 号，多个用空格或逗号分隔'}
            value={c.input}
            onChange={(e) => c.setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void c.addIds();
              }
            }}
            autoComplete="off"
          />
          <button type="button" className="mk-btn mk-btn--primary" onClick={() => void c.addIds()}>
            添加
          </button>
        </div>
      </div>

      <div className="panel stagger-item stagger-4">
        <h2 className="panel-title">{c.tab === 'group' ? '黑户群' : '黑户用户'}（{c.ids.length}）</h2>
        {c.loading ? <div className="mk-state">加载中…</div> : null}
        {!c.loading && !c.ids.length ? <div className="mk-state">暂无黑户</div> : null}
        {!c.loading && c.ids.length ? (
          <div className="bl-list">
            {c.ids.map((id) => (
              <div key={id} className="bl-row">
                <span className="bl-row__id">{id}</span>
                <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={() => void c.removeId(id)}>
                  移除
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}