import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay, type OverlayContent } from './overlay';

/**
 * 手机弹窗：消费全局叠层状态，portal 到根级宿主后在屏幕正中居中覆盖。
 * 关闭时保留最后一次内容，保证退场动画期间不闪空。
 */
export function BottomSheet() {
  const { content, isOpen, close, host } = useOverlay();
  const [shown, setShown] = useState<OverlayContent | null>(content);

  useEffect(() => {
    if (content) setShown(content);
  }, [content]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  const view = content ?? shown;
  const titleText = typeof view?.title === 'string' ? view.title : '弹窗';

  if (!host) return null;

  return createPortal(
    <div className={`mk-sheet${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
      <div className="mk-sheet__scrim" onClick={close} />
      <section
        className="mk-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label={titleText}
      >
        {view?.title ? (
          <header className="mk-sheet__head">
            <div className="mk-sheet__titles">
              <div className="mk-sheet__title">{view.title}</div>
              {view?.subtitle ? <div className="mk-sheet__subtitle">{view.subtitle}</div> : null}
            </div>
            <button
              type="button"
              className="mk-sheet__close"
              onClick={close}
              aria-label="关闭"
            >
              ×
            </button>
          </header>
        ) : null}
        <div className="mk-sheet__body">{view?.body}</div>
        {view?.footer ? <footer className="mk-sheet__foot">{view.footer}</footer> : null}
      </section>
    </div>,
    host,
  );
}