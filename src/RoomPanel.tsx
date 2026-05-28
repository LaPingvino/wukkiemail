// Room detail — slide-in panel with the most recent messages of a room.
// Subscribes to the source's change events so new messages appear as
// they arrive. No compose/reply yet — this is the read-side preview.

import { useEffect, useRef, useState } from 'react';
import type { MatrixSource } from './sources/matrix';
import type { RoomTimelineSnapshot } from './sources/matrix';
import { renderInline, renderFormattedHtml, markdownToHtml } from './markdown';
import { CollapsibleBody } from './CollapsibleBody';

export function RoomPanel({
  matrix,
  roomId,
  onClose,
}: {
  matrix: MatrixSource;
  roomId: string;
  onClose: () => void;
}) {
  const [snap, setSnap] = useState<RoomTimelineSnapshot | null>(() => matrix.getRoomTimeline(roomId, 200));
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ eventId: string; senderName: string; body: string } | null>(null);
  const [editing, setEditing] = useState<{ eventId: string; originalBody: string } | null>(null);
  const selfId = matrix.id;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const pickFile = () => fileInputRef.current?.click();
  const onFileSelected = async (file: File) => {
    setUploading(true);
    setSendError(null);
    try {
      await matrix.uploadAndSendFile(roomId, file);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    const unsub = matrix.subscribe(() => {
      setSnap(matrix.getRoomTimeline(roomId, 200));
    });
    void matrix.markRoomRead(roomId);
    return unsub;
  }, [matrix, roomId]);

  // Auto-scroll: on initial open jump to the bottom; on subsequent
  // updates, stay glued to the bottom only if we were already there.
  const stuckRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [snap]);

  const loadOlder = async () => {
    if (loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const more = await matrix.loadOlder(roomId, 50);
      setHasMore(more);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] loadOlder failed', e);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Auto-load when the message list is scrolled near the top.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80) void loadOlder();
      // Track stickiness: if we're within ~80px of the bottom we stay
      // glued; otherwise we don't yank the user back when new events arrive.
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stuckRef.current = distFromBottom < 80;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingOlder, hasMore]);

  const send = async () => {
    const body = composeText.trim();
    if (!body) return;
    setSending(true);
    setSendError(null);
    try {
      if (editing) {
        await matrix.editMessage(roomId, editing.eventId, body, markdownToHtml(body));
        setEditing(null);
      } else {
        await matrix.sendMessage(roomId, body, markdownToHtml(body), replyTo);
        setReplyTo(null);
      }
      setComposeText('');
      // Imperatively clear the Material field too — its `value` property
      // doesn't track React state directly across renders.
      const field = document.querySelector('.composer md-outlined-text-field') as HTMLElement | null;
      if (field) (field as unknown as { value: string }).value = '';
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (!snap) {
    return (
      <div className="issue-panel">
        <Header title="Room not loaded yet" onClose={onClose} />
        <div className="empty">
          Matrix sync hasn't reached this room yet. It'll appear once the
          next /sync response lands.
        </div>
      </div>
    );
  }

  return (
    <div className="issue-panel">
      <Header
        title={snap.roomName}
        subtitle={`${snap.memberCount} member${snap.memberCount === 1 ? '' : 's'}`}
        onClose={onClose}
      />
      <div
        className={`issue-body ${dragOver ? 'drag-over' : ''}`}
        ref={bodyRef}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void onFileSelected(f);
        }}
      >
        {hasMore && (
          <button
            type="button"
            className="show-read"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
          >
            {loadingOlder ? 'Loading older…' : 'Load older messages'}
          </button>
        )}
        {!hasMore && snap.messages.length > 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center', margin: '8px 0' }}>
            — start of room —
          </p>
        )}
        {snap.messages.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No messages.</p>
        ) : (
          <ul className="comment-list">
            {snap.messages.map((m) => (
              <li key={m.id}>
                <div className="comment-head">
                  <strong>{m.senderName}</strong>
                  <span className="ts">{new Date(m.ts).toLocaleString()}</span>
                </div>
                {m.image ? (
                  <a href={m.image.url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={m.image.url}
                      alt={m.image.alt}
                      className="msg-image"
                      loading="lazy"
                    />
                  </a>
                ) : m.file ? (
                  <a href={m.file.url} target="_blank" rel="noopener noreferrer" className="msg-file">
                    <span className="material-symbols-outlined">attach_file</span>
                    <span>{m.file.name}</span>
                    {m.file.size && <span style={{ color: 'var(--muted)' }}>· {formatBytes(m.file.size)}</span>}
                  </a>
                ) : m.html ? (
                  <CollapsibleBody className="comment-body">{renderFormattedHtml(m.html)}</CollapsibleBody>
                ) : (
                  <CollapsibleBody className="comment-body">{renderInline(m.body)}</CollapsibleBody>
                )}
                <div className="msg-actions">
                  <button
                    type="button"
                    className="msg-reply"
                    aria-label="Reply"
                    onClick={() => setReplyTo({ eventId: m.id, senderName: m.senderName, body: m.body })}
                  >
                    <span className="material-symbols-outlined">reply</span>
                  </button>
                  {m.senderId === selfId && (
                    <>
                      <button
                        type="button"
                        className="msg-reply"
                        aria-label="Edit"
                        onClick={() => {
                          setEditing({ eventId: m.id, originalBody: m.body });
                          setComposeText(m.body);
                          setReplyTo(null);
                        }}
                      >
                        <span className="material-symbols-outlined">edit</span>
                      </button>
                      <button
                        type="button"
                        className="msg-reply"
                        aria-label="Delete"
                        onClick={async () => {
                          if (!confirm('Delete this message?')) return;
                          try { await matrix.redactMessage(roomId, m.id); }
                          catch (e) { console.warn('[wukkiemail] redact failed', e); }
                        }}
                      >
                        <span className="material-symbols-outlined">delete</span>
                      </button>
                    </>
                  )}
                </div>
                {m.edited && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}> (edited)</span>
                )}
                <div className="reactions">
                  {m.reactions?.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      className={`reaction ${r.selfReacted ? 'self' : ''}`}
                      onClick={() => void matrix.toggleReaction(roomId, m.id, r.key)}
                      title={r.selfReacted ? 'Remove your reaction' : 'Add your reaction'}
                    >
                      <span>{r.key}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.count}</span>
                    </button>
                  ))}
                  <ReactionAdder onAdd={(key) => void matrix.toggleReaction(roomId, m.id, key)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TypingLine matrix={matrix} roomId={roomId} />
      {replyTo && (
        <div className="reply-chip">
          <div className="reply-chip-inner">
            <div className="reply-chip-label">Replying to {replyTo.senderName}</div>
            <div className="reply-chip-body">{replyTo.body.slice(0, 200)}</div>
          </div>
          <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}
      {editing && (
        <div className="reply-chip">
          <div className="reply-chip-inner">
            <div className="reply-chip-label">Editing</div>
            <div className="reply-chip-body">{editing.originalBody.slice(0, 200)}</div>
          </div>
          <button
            type="button"
            onClick={() => { setEditing(null); setComposeText(''); }}
            aria-label="Cancel edit"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}
      <div className="composer">
        {sendError && (
          <p style={{ color: 'var(--md-sys-color-error)', fontSize: 12, margin: '0 0 6px' }}>
            Send failed: {sendError}
          </p>
        )}
        <md-outlined-text-field
          label="Reply"
          placeholder="Type a message…"
          value={composeText}
          ref={(el: HTMLElement | null) => {
            if (!el) return;
            el.addEventListener('input', (ev) => {
              const v = (ev.target as HTMLInputElement & { value: string }).value;
              setComposeText(v);
              // Send a typing tick when the user is actively typing; the
              // SDK will let the server know we stopped after the
              // ~30s timeout if we don't refresh.
              void matrix.sendTyping(roomId, v.length > 0, 30_000);
            });
            el.addEventListener('keydown', (ev: Event) => {
              const ke = ev as KeyboardEvent;
              if (ke.key === 'Enter' && !ke.shiftKey) {
                ev.preventDefault();
                void send();
                void matrix.sendTyping(roomId, false);
              }
            });
            el.addEventListener('blur', () => { void matrix.sendTyping(roomId, false); });
            el.addEventListener('paste', (ev: Event) => {
              const pe = ev as ClipboardEvent;
              const items = pe.clipboardData?.items;
              if (!items) return;
              for (const item of items) {
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                  const file = item.getAsFile();
                  if (file) {
                    ev.preventDefault();
                    void onFileSelected(file);
                    return;
                  }
                }
              }
            });
          }}
          disabled={sending || undefined}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          className="hamburger"
          aria-label="Attach file"
          onClick={pickFile}
          disabled={uploading}
        >
          <span className="material-symbols-outlined">attach_file</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFileSelected(f);
            e.target.value = '';
          }}
        />
        <md-icon-button
          aria-label="Send"
          onClick={() => void send()}
          disabled={sending || uploading || !composeText.trim() || undefined}
        >
          <md-icon>send</md-icon>
        </md-icon-button>
      </div>
    </div>
  );
}

function ReactionAdder({ onAdd }: { onAdd: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  // Tiny built-in palette + free-text. Full emoji picker is a separate
  // dependency we'll add later if needed.
  const palette = ['👍', '👎', '❤️', '😂', '🎉', '✅', '❌', '🙏', '🤔'];
  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className="reaction-add"
        onClick={() => setOpen((o) => !o)}
        aria-label="Add reaction"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add_reaction</span>
      </button>
      {open && (
        <div className="reaction-popover" onMouseLeave={() => setOpen(false)}>
          {palette.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { onAdd(e); setOpen(false); }}
            >{e}</button>
          ))}
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const input = (ev.currentTarget.elements.namedItem('k') as HTMLInputElement);
              const v = input.value.trim();
              if (v) { onAdd(v); setOpen(false); input.value = ''; }
            }}
          >
            <input name="k" placeholder="…" maxLength={32} style={{ width: 40, padding: 2, font: 'inherit' }} />
          </form>
        </div>
      )}
    </span>
  );
}

function TypingLine({ matrix, roomId }: { matrix: MatrixSource; roomId: string }) {
  const [names, setNames] = useState<string[]>(() => matrix.getTypingUsers(roomId));
  useEffect(() => {
    const unsub = matrix.subscribe(() => setNames(matrix.getTypingUsers(roomId)));
    return unsub;
  }, [matrix, roomId]);
  if (names.length === 0) return null;
  const summary = names.length === 1
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : `${names[0]} and ${names.length - 1} others are typing…`;
  return <div className="typing-line">{summary}</div>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Header({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <header className="issue-head">
      <md-icon-button onClick={onClose} aria-label="Close">
        <md-icon>close</md-icon>
      </md-icon-button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="issue-title">{title}</div>
        {subtitle && <div className="issue-subtitle">{subtitle}</div>}
      </div>
    </header>
  );
}
