import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ViewId } from '../api';
import type { NavItem } from './nav';
import { useOverlay } from './overlay';
import type { AdminStatus } from './useAdminStatus';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  keywords?: string;
  run: () => void;
}

/** 桌面命令面板：Cmd/Ctrl+K 打开，↑↓ 选择、Enter 执行、Esc 关闭；开合受外壳控制。 */
export function CommandPalette({
  open,
  onClose,
  nav,
  setView,
  status,
}: {
  open: boolean;
  onClose: () => void;
  nav: NavItem[];
  setView: (v: ViewId) => void;
  status: AdminStatus;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { host } = useOverlay();

  const commands = useMemo<Command[]>(() => {
    const navCmds: Command[] = nav.map((n) => ({
      id: `nav:${n.id}`,
      label: n.label,
      hint: '前往',
      group: n.group ? `导航 · ${n.group}` : '导航',
      keywords: `${n.label} ${n.short} ${n.id}`,
      run: () => setView(n.id),
    }));
    const actions: Command[] = [
      { id: 'act:refresh', label: '刷新状态', hint: '厂商 / 模型 / 余额', group: '操作', keywords: 'refresh shuaxin zhuangtai', run: () => void status.refresh() },
      { id: 'act:probe', label: '测试模型连通性', hint: '探测 API', group: '操作', keywords: 'probe test liantong', run: () => void status.probe() },
    ];
    return [...navCmds, ...actions];
  }, [nav, setView, status]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return commands;
    return commands.filter((c) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(kw));
  }, [commands, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const runAt = useCallback(
    (idx: number) => {
      const cmd = filtered[idx];
      if (!cmd) return;
      cmd.run();
      onClose();
    },
    [filtered, onClose],
  );

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open || !host) return null;

  let lastGroup = '';

  return createPortal(
    <div className="mk-cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
      <div className="mk-cmdk__scrim" onClick={onClose} />
      <div className="mk-cmdk__panel">
        <div className="mk-cmdk__search">
          <span className="mk-cmdk__icon" aria-hidden>⌘</span>
          <input
            ref={inputRef}
            className="mk-cmdk__input"
            type="text"
            placeholder="搜索视图或操作…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="mk-cmdk-list"
            aria-autocomplete="list"
          />
          <kbd className="mk-cmdk__kbd">Esc</kbd>
        </div>
        <ul className="mk-cmdk__list" id="mk-cmdk-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="mk-cmdk__empty">无匹配命令</li>
          ) : (
            filtered.map((c, i) => {
              const showGroup = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <li key={c.id} role="presentation">
                  {showGroup ? <div className="mk-cmdk__group">{c.group}</div> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`mk-cmdk__item${i === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => runAt(i)}
                  >
                    <span className="mk-cmdk__item-label">{c.label}</span>
                    {c.hint ? <span className="mk-cmdk__item-hint">{c.hint}</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>,
    host,
  );
}