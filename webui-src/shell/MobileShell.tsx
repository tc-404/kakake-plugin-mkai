import { useCallback, type ReactNode } from 'react';
import type { ViewId } from '../api';
import { BottomSheet } from './BottomSheet';
import { useOverlay } from './overlay';

type TabKey = 'overview' | 'switch' | 'sessions' | 'config' | 'more';

const TABS: { key: TabKey; label: string; glyph: string }[] = [
  { key: 'overview', label: '总览', glyph: '◈' },
  { key: 'switch', label: '开关', glyph: '◉' },
  { key: 'sessions', label: '会话', glyph: '❒' },
  { key: 'config', label: '配置', glyph: '⚙' },
  { key: 'more', label: '更多', glyph: '⋯' },
];

const CONFIG_SECTIONS: { id: ViewId; label: string }[] = [
  { id: 'model', label: '模型' },
  { id: 'policy', label: '策略' },
  { id: 'skills', label: '能力' },
  { id: 'rotation', label: '轮替' },
];

const MORE_ITEMS: { id: ViewId; label: string; desc: string }[] = [
  { id: 'voice', label: '语音输出', desc: '配音密钥与角色设置' },
  { id: 'blacklist', label: '黑户管理', desc: '拉黑或恢复用户' },
];

const CONFIG_VIEWS: ViewId[] = ['model', 'policy', 'skills', 'rotation'];

function tabOf(view: ViewId): TabKey {
  if (view === 'overview') return 'overview';
  if (view === 'switch') return 'switch';
  if (view === 'sessions') return 'sessions';
  if (view === 'blacklist') return 'more';
  if (view === 'voice') return 'more';
  return 'config';
}

/**
 * 手机壳（类原生 iOS）：精简底部标签栏 + 居中弹层宿主。
 * 信息架构合并：配置聚合为分段（模型 / 策略 / 能力），黑户收入「更多」弹层。
 * 页面视图作为 children 渲染；视觉语言由 mobile.css 提供。
 */
export function MobileShell({
  view,
  setView,
  children,
}: {
  view: ViewId;
  setView: (v: ViewId) => void;
  children: ReactNode;
}) {
  const overlay = useOverlay();
  const activeTab = tabOf(view);
  const inConfig = activeTab === 'config';

  const openMore = useCallback(() => {
    overlay.open({
      key: 'more',
      title: '更多',
      subtitle: '其余管理入口',
      body: (
        <div className="mk-sheet-list">
          {MORE_ITEMS.map((it) => (
            <button
              key={it.id}
              type="button"
              className="mk-sheet-list__item"
              onClick={() => {
                setView(it.id);
                overlay.close();
              }}
            >
              <span className="mk-sheet-list__label">{it.label}</span>
              <span className="mk-sheet-list__desc">{it.desc}</span>
            </button>
          ))}
        </div>
      ),
    });
  }, [overlay, setView]);

  const onTab = useCallback(
    (key: TabKey) => {
      if (key === 'more') {
        openMore();
        return;
      }
      if (key === 'config') {
        if (!CONFIG_VIEWS.includes(view)) setView('model');
        return;
      }
      if (key === 'overview') {
        setView('overview');
        return;
      }
      setView(key === 'switch' ? 'switch' : 'sessions');
    },
    [openMore, setView, view],
  );

  return (
    <div className="mk-ios">
      {inConfig ? (
        <header className="mk-ios__nav">
          <div className="mk-ios__segment" role="tablist" aria-label="配置分段">
            {CONFIG_SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={view === s.id}
                className={view === s.id ? 'is-active' : ''}
                onClick={() => setView(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </header>
      ) : null}

      <main className="mk-ios__scroll">
        <div className="mk-ios__page" key={view}>
          {children}
        </div>
      </main>

      <nav className="mk-ios__tabbar" aria-label="主导航">
        {TABS.map((t) => {
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={`mk-ios__tab${isActive ? ' is-active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onTab(t.key)}
            >
              <span className="mk-ios__tab-glyph" aria-hidden>
                {t.glyph}
              </span>
              <span className="mk-ios__tab-label">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <BottomSheet />
    </div>
  );
}