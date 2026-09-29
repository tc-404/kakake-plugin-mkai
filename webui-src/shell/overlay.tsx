import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useDeviceKind } from '../hooks/useDeviceKind';

/**
 * 叠层内容（设备无关）：桌面与手机均渲染为屏幕正中的覆盖级居中弹窗。
 * 页面只描述内容，由各自的壳决定呈现皮肤（desktop.css / mobile.css）。
 */
export interface OverlayContent {
  /** 用于区分不同来源，切换时可重置滚动 */
  key?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
}

interface OverlayApi {
  content: OverlayContent | null;
  isOpen: boolean;
  open: (content: OverlayContent) => void;
  close: () => void;
  /** 根级叠层 portal 宿主（挂于 document.body，相对视口 fixed） */
  host: HTMLElement | null;
}

const OverlayContext = createContext<OverlayApi | null>(null);

/** 全局叠层状态：供任意页面推送弹窗内容；宿主 portal 至 body 以脱离 backdrop-filter 陷阱 */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const kind = useDeviceKind();
  const [content, setContent] = useState<OverlayContent | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [bodyMount, setBodyMount] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setBodyMount(document.body);
  }, []);

  const open = useCallback((next: OverlayContent) => setContent(next), []);
  const close = useCallback(() => setContent(null), []);
  const value = useMemo<OverlayApi>(
    () => ({ content, isOpen: content != null, open, close, host }),
    [content, open, close, host],
  );

  const hostNode = (
    <div
      className={`mk-overlay-host mkai-admin is-${kind}`}
      ref={setHost}
      data-mkai-overlay-host=""
      aria-hidden={false}
    />
  );

  return (
    <OverlayContext.Provider value={value}>
      {children}
      {bodyMount ? createPortal(hostNode, bodyMount) : null}
    </OverlayContext.Provider>
  );
}

export function useOverlay(): OverlayApi {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error('useOverlay 必须在 OverlayProvider 内使用');
  return ctx;
}
