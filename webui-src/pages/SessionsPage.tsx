import { useCallback, useEffect, useRef, useState } from 'react';
import type { MkaiApiClient } from '../api';
import type { ConfirmFn, ToastFn } from '../notify';
import { friendAvatarUrl, groupAvatarUrl } from '../smartChatLogic';
import { avatarLetter, groupRoleLabel, type ChatBubble } from '../sessionTranscript';
import {
  isPrivateRow,
  peerIdFromChat,
  rowKey,
  sessionTitle,
  useSessionsController,
  type SessionRow,
} from '../controllers/useSessionsController';

const LONG_PRESS_MS = 3000;

function AvatarImg({
  src,
  name,
  out,
}: {
  src: string;
  name: string;
  out?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`im-avatar${out ? ' out' : ''}`} aria-hidden>
        {avatarLetter(name)}
      </div>
    );
  }
  return (
    <img
      className={`im-avatar-img${out ? ' out' : ''}`}
      src={src}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}

export function SessionsPage({
  api,
  toast,
  confirm,
}: {
  api: MkaiApiClient;
  toast: ToastFn;
  confirm: ConfirmFn;
}) {
  const c = useSessionsController({ api, toast, confirm });
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickRef = useRef(false);

  const bubbles: ChatBubble[] = c.bubbles;

  useEffect(() => {
    if (!c.active) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [c.active, bubbles.length, c.loadingChat]);

  const cancelLongPress = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const startLongPress = useCallback(
    (row: SessionRow) => {
      cancelLongPress();
      pressTimerRef.current = setTimeout(() => {
        pressTimerRef.current = null;
        suppressClickRef.current = true;
        void c.deleteSession(row);
      }, LONG_PRESS_MS);
    },
    [cancelLongPress, c],
  );

  useEffect(() => () => cancelLongPress(), [cancelLongPress]);

  if (c.active) {
    const active = c.active;
    const title = sessionTitle(active);
    const scope = isPrivateRow(active) ? 'private' : 'group';
    const botName = String(c.detail?.bot_card || c.detail?.bot_nickname || '机器人');
    const botAvatar = c.botUserId ? friendAvatarUrl(c.botUserId) : '';
    return (
      <section className="mkai-page-sessions is-chat">
        <div className="im-shell im-shell-page">
          <div className="im-pane im-pane-full">
            <div className="im-pane-head">
              <button type="button" className="im-back" onClick={c.backToList} aria-label="返回列表">
                ← 返回
              </button>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="im-pane-title">
                  {title}
                  {active.messageCount != null ? ` (${active.messageCount})` : ''}
                </div>
                <div className="im-pane-sub">{active.chatId}</div>
              </div>
              <span className={`im-pane-type ${scope}`}>{scope === 'group' ? '群聊' : '好友'}</span>
            </div>
            <div className="im-messages" ref={listRef}>
              {c.loadingChat && !bubbles.length ? <div className="im-empty">加载中…</div> : null}
              {!c.loadingChat && !bubbles.length ? <div className="im-empty">该会话暂无消息</div> : null}
              {bubbles.map((b) => {
                if (b.side === 'sys') {
                  return (
                    <div key={b.id} className="im-sys">
                      {b.text}
                    </div>
                  );
                }
                const out = b.side === 'out';
                const src = out
                  ? botAvatar
                  : (b.qq ? friendAvatarUrl(b.qq) : '');
                return (
                  <div key={b.id} className={`im-msg${out ? ' out' : ''}`}>
                    <AvatarImg src={src} name={out ? botName : b.name} out={out} />
                    <div className="im-msg-body">
                      <div className="im-msg-head">
                        <span className="im-msg-name">{b.name}</span>
                        {b.groupTitle ? (
                          <span className="im-msg-title" title="群头衔">{b.groupTitle}</span>
                        ) : null}
                        {b.groupRole ? (
                          <span className="im-msg-role">{groupRoleLabel(b.groupRole)}</span>
                        ) : null}
                        {b.time ? <span className="im-msg-time">{b.time}</span> : null}
                      </div>
                      {b.replyTo || b.atTargets ? (
                        <div className="im-msg-meta">
                          {b.replyTo ? <span className="im-msg-meta__chip im-msg-meta__chip--reply">{b.replyTo}</span> : null}
                          {b.atTargets ? <span className="im-msg-meta__chip im-msg-meta__chip--at">{b.atTargets}</span> : null}
                        </div>
                      ) : null}
                      <div
                        className={`im-bubble${b.kind === 'react' || b.kind === 'sticker' ? ' im-bubble--meta' : ''}${b.kind === 'voice' ? ' im-bubble--voice' : ''}`}
                      >
                        <div className="im-bubble-text">{b.text}</div>
                        {b.imageNotes?.length ? (
                          <div className="im-bubble-eyes" title="识图解析">
                            {b.imageNotes.map((note, i) => (
                              <div key={`${b.id}-eye-${i}`} className="im-bubble-eyes__line">
                                {note}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} aria-hidden className="im-scroll-anchor" />
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mkai-page-sessions">
      <div className="im-shell im-shell-page stagger-item stagger-2">
        <div className="im-list-col im-list-full">
          <div className="im-list-head">
            <input
              type="search"
              placeholder="搜索会话…"
              value={c.q}
              onChange={(e) => c.setQ(e.target.value)}
            />
            <label className="im-list-toggle" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={c.showEmpty}
                onChange={(e) => c.setShowEmpty(e.target.checked)}
              />
              显示空会话
            </label>
            <button
              type="button"
              className="im-back"
              disabled={c.pruning}
              onClick={() => void c.pruneEmpty()}
              style={{ whiteSpace: 'nowrap' }}
            >
              {c.pruning ? '清理中…' : '清理空会话'}
            </button>
          </div>
          <div className="im-sessions">
            {c.loading ? <div className="im-empty">加载中…</div> : null}
            {!c.loading && !c.filtered.length ? <div className="im-empty">暂无会话</div> : null}
            {c.filtered.map((s) => {
              const name = sessionTitle(s);
              const scope = isPrivateRow(s) ? 'private' : 'group';
              const peer = peerIdFromChat(s);
              const avatarSrc = peer.id
                ? (peer.kind === 'group' ? groupAvatarUrl(peer.id) : friendAvatarUrl(peer.id))
                : '';
              const live = Boolean(s.active);
              return (
                <div
                  key={rowKey(s)}
                  className={`im-session ${live ? 'is-active' : 'is-stale'}`}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    void c.openChat(s);
                  }}
                  onPointerDown={() => startLongPress(s)}
                  onPointerUp={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void c.openChat(s);
                    }
                  }}
                >
                  <AvatarImg src={avatarSrc} name={name} />
                  <div className="im-session-body">
                    <div className="im-session-top">
                      <span className="im-session-title">{name}</span>
                      <span className={`im-type ${scope}`}>
                        {scope === 'group' ? '群聊' : '好友'}
                      </span>
                    </div>
                    <div className="im-session-bottom">
                      <span className="im-session-preview">
                        {s.chatId}
                        {s.messageCount != null ? ` · ${s.messageCount} 条` : ''}
                        {s.config_fingerprint
                          ? ` · fp ${String(s.config_fingerprint).slice(0, 8)}`
                          : ''}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}