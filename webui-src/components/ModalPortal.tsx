import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useOverlay } from '../shell/overlay';

/** 将居中模态框 portal 到根级叠层宿主，避免被内容区 scroll / backdrop-filter 影响 */
export function ModalPortal({
  open,
  onClose,
  children,
  className = '',
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { host } = useOverlay();
  if (!open || !host) return null;

  return createPortal(
    <div
      className={`mk-modal-overlay${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        if (onClose && e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    host,
  );
}
