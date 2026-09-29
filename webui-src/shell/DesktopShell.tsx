import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import type { MkaiApiClient, ViewId } from '../api';
import { useLiquidIndicator } from '../hooks/useLiquidIndicator';
import { CommandPalette } from './CommandPalette';
import { InspectorDrawer } from './InspectorDrawer';
import type { NavItem } from './nav';
import { useAdminStatus, type AdminStatus } from './useAdminStatus';

const CONN_LABEL: Record<AdminStatus['conn'], string> = {
  idle: '未测',
  checking: '探测中',
  ok: '已连通',
  fail: '不可用',
};

function StatChip({
  label,
  value,
  tone = 'muted',
  loading,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'muted';
  loading?: boolean;
}) {
  return (
    <div className={`mk-topbar__tile mk-stat mk-stat--${tone}`}>
      <span className="mk-topbar__tile-label mk-stat__label">{label}</span>
      <span
        className={`mk-topbar__tile-value mk-stat__value${loading ? ' is-loading' : ''}`}
        title={!loading && value ? value : undefined}
      >
        {loading ? '···' : value || '—'}
      </span>
    </div>
  );
}

function ConnPill({ status }: { status: AdminStatus }) {
  const latency =
    status.conn === 'ok' && status.connLatency != null ? ` · ${status.connLatency}ms` : '';
  return (
    <button
      type="button"
      className={`mk-conn mk-conn--${status.conn}`}
      onClick={() => void status.probe()}
      disabled={status.conn === 'checking'}
      title="测试模型连通性"
    >
      <span className="mk-conn__dot" aria-hidden />
      <span className="mk-conn__text">
        {CONN_LABEL[status.conn]}
        {latency}
      </span>
    </button>
  );
}

/**
 * 桌面控制台壳：常驻分组侧栏 + 顶部状态条 + 右侧检查器抽屉宿主。
 * 页面视图作为 children 渲染在主区；视觉语言由 desktop.css 提供。
 */
export function DesktopShell({
  nav,
  view,
  setView,
  api,
  children,
}: {
  nav: NavItem[];
  view: ViewId;
  setView: (v: ViewId) => void;
  api: MkaiApiClient;
  children: ReactNode;
}) {
  const activeIndex = useMemo(
    () => Math.max(0, nav.findIndex((n) => n.id === view)),
    [nav, view],
  );
  const ind = useLiquidIndicator(activeIndex, nav.length);
  const status = useAdminStatus(api);
  const [cmdkOpen, setCmdkOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let lastGroup = '';

  return (
    <div className="mk-console">
      <aside className="mk-console__aside">
        <div className="mk-brand">
          <span className="mk-brand__glyph" aria-hidden>
            ◇
          </span>
          <span className="mk-brand__text">
            <span className="mk-brand__name">智能对话</span>
            <span className="mk-brand__sub">独立 AI 控制台</span>
          </span>
        </div>

        <nav className="mk-nav" ref={ind.navRef as RefObject<HTMLElement>} aria-label="主导航">
          <div
            className={`mk-nav__liquid${ind.box.ready ? ' is-ready' : ''}`}
            style={{
              transform: `translate3d(${ind.box.left}px, ${ind.box.top}px, 0)`,
              width: ind.box.width,
              height: ind.box.height,
            }}
            aria-hidden
          />
          {nav.map((item, index) => {
            const showGroup = item.group && item.group !== lastGroup;
            if (item.group) lastGroup = item.group;
            const isActive = view === item.id;
            return (
              <div key={item.id} className="mk-nav__slot">
                {showGroup ? <div className="mk-nav__group">{item.group}</div> : null}
                <button
                  type="button"
                  ref={(el) => ind.setItemRef(index, el)}
                  className={`mk-nav__item${isActive ? ' is-active' : ''}`}
                  onClick={() => setView(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className="mk-nav__dot" aria-hidden />
                  <span className="mk-nav__label">{item.label}</span>
                </button>
              </div>
            );
          })}
        </nav>

        <div className="mk-console__aside-foot">
          <ConnPill status={status} />
        </div>
      </aside>

      <div className="mk-console__body">
        <header className="mk-topbar">
          <div className="mk-topbar__stats">
            <StatChip label="厂商" value={status.vendorName} loading={status.loading} />
            <StatChip label="模型" value={status.modelLabel} loading={status.loading} />
            <StatChip
              label="余额"
              value={status.balanceLabel}
              tone={status.balanceTone}
              loading={status.loading}
            />
            <button
              type="button"
              className="mk-topbar__tile mk-topbar__cmdk"
              onClick={() => setCmdkOpen(true)}
              title="命令面板 (Ctrl/⌘ K)"
            >
              <span className="mk-topbar__tile-label">命令</span>
              <span className="mk-topbar__tile-value">
                <span aria-hidden>⌘</span>K
              </span>
            </button>
            <button
              type="button"
              className="mk-topbar__tile mk-topbar__refresh"
              onClick={() => void status.refresh()}
              title="刷新状态"
              aria-label="刷新状态"
            >
              <span className="mk-topbar__tile-label">刷新</span>
              <span className="mk-topbar__tile-value" aria-hidden>⟳</span>
            </button>
          </div>
        </header>

        <main className="mk-console__main">
          <div className="mk-console__page" key={view}>
            {children}
          </div>
        </main>

        <InspectorDrawer />
      </div>

      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        nav={nav}
        setView={setView}
        status={status}
      />
    </div>
  );
}