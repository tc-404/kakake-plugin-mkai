import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay, type OverlayContent } from './overlay';

/**
 * 桌面弹窗：消费全局叠层状态，portal 到根级宿主后在屏幕正中居中覆盖。
 * 关闭时保留最后一次内容，保证退场动画期间不闪空。
 */
export function InspectorDrawer() {
  const { content, isOpen, close, host } = useOverlay();
  const [shown, setShown] = useState<OverlayContent | null>(content);

  useEffect(() => {
    if (content) setShown(content);
  }, [content]);

  const view = content ?? shown;
  const titleText = typeof view?.title === 'string' ? view.title : '弹窗';

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  if (!host) return null;

  return createPortal(
    <div className={`mk-inspector${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
      <div className="mk-inspector__scrim" onClick={close} />
      <aside
        className="mk-inspector__panel"
        role="dialog"
        aria-label={titleText}
        aria-modal="true"
      >
        <header className="mk-inspector__head">
          <div className="mk-inspector__titles">
            <div className="mk-inspector__title">{view?.title ?? '弹窗'}</div>
            {view?.subtitle ? (
              <div className="mk-inspector__subtitle">{view.subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            className="mk-inspector__close"
            onClick={close}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <div className="mk-inspector__body">{view?.body}</div>
        {view?.footer ? <footer className="mk-inspector__foot">{view.footer}</footer> : null}
      </aside>
    </div>,
    host,
  );
}