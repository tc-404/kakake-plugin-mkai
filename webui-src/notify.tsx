import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from './shell/overlay';

export type ToastKind = 'ok' | 'err' | 'info' | 'warn';

export type ToastFn = (msg: string, kind?: ToastKind) => void;

export type ConfirmOptions = {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
};

export type ConfirmFn = (opts: ConfirmOptions | string) => Promise<boolean>;

type ToastItem = {
  id: number;
  msg: string;
  kind: ToastKind;
};

type ConfirmState = ConfirmOptions & {
  resolve: (v: boolean) => void;
};

type NotifyApi = {
  toast: ToastFn;
  confirm: ConfirmFn;
};

const NotifyCtx = createContext<NotifyApi | null>(null);

function inferKind(msg: string, kind?: ToastKind): ToastKind {
  if (kind) return kind;
  if (/失败|异常|错误|error|拒绝|不可用|无法/i.test(msg)) return 'err';
  if (/成功|已保存|已清空|已删除|已移除|已加入|正常|通过|完成|已开启|已关闭/i.test(msg)) return 'ok';
  if (/请|注意|标记|打开|切换为/i.test(msg)) return 'info';
  return 'info';
}

const KIND_LABEL: Record<ToastKind, string> = {
  ok: '成功',
  err: '异常',
  info: '提示',
  warn: '注意',
};

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const seq = useRef(1);
  const { host } = useOverlay();

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback<ToastFn>((msg, kind) => {
    const text = String(msg || '').trim();
    if (!text) return;
    const id = seq.current++;
    const item: ToastItem = { id, msg: text, kind: inferKind(text, kind) };
    setToasts((list) => [...list.slice(-3), item]);
    window.setTimeout(() => dismiss(id), item.kind === 'err' ? 3600 : 2400);
  }, [dismiss]);

  const confirm = useCallback<ConfirmFn>((opts) => {
    const options: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts;
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...options, resolve });
    });
  }, []);

  const api = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  const closeConfirm = (ok: boolean) => {
    confirmState?.resolve(ok);
    setConfirmState(null);
  };

  const toastStack = (
    <div className="mk-toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`mk-toast mk-toast--${t.kind}`} role="status">
          <span className="mk-toast__badge">{KIND_LABEL[t.kind]}</span>
          <span className="mk-toast__msg">{t.msg}</span>
          <button type="button" className="mk-toast__close" aria-label="关闭" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );

  const confirmDialog = confirmState ? (
    <div
      className="mk-modal-overlay mk-confirm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeConfirm(false);
      }}
    >
      <div className="mk-modal mk-confirm mk-modal--enter" role="alertdialog" aria-modal="true">
        <h3 className="mk-modal__title">{confirmState.title || '请确认'}</h3>
        <p className="mk-confirm__msg">{confirmState.message}</p>
        <div className="mk-btn-row">
          <button
            type="button"
            className={`mk-btn ${confirmState.danger ? 'mk-btn--danger' : 'mk-btn--primary'}`}
            onClick={() => closeConfirm(true)}
          >
            {confirmState.okText || '确定'}
          </button>
          <button type="button" className="mk-btn mk-btn--ghost" onClick={() => closeConfirm(false)}>
            {confirmState.cancelText || '取消'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <NotifyCtx.Provider value={api}>
      {children}
      {host ? createPortal(toastStack, host) : null}
      {host && confirmState ? createPortal(confirmDialog, host) : null}
    </NotifyCtx.Provider>
  );
}

export function useNotify(): NotifyApi {
  const ctx = useContext(NotifyCtx);
  if (!ctx) {
    return {
      toast: (m) => {
        console.warn('[mkai notify]', m);
      },
      confirm: async () => false,
    };
  }
  return ctx;
}
