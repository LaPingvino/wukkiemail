// Room detail — slide-in panel with the most recent messages of a room.
// Subscribes to the source's change events so new messages appear as
// they arrive. No compose/reply yet — this is the read-side preview.

import { useEffect, useRef, useState } from 'react';
import type { MatrixSource } from './sources/matrix';
import type { RoomTimelineSnapshot } from './sources/matrix';
import { renderInline, renderFormattedHtml, markdownToHtml } from './markdown';
import { expandShortcodes } from './emoji';
import { CollapsibleBody } from './CollapsibleBody';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Lazily fetch + decrypt an E2EE image into a blob URL, revoking on unmount.
function EncryptedImage({ matrix, file, alt }: { matrix: MatrixSource; file: import('./media').EncryptedFile; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; let made: string | null = null;
    matrix.decryptMedia(file).then((u) => {
      if (!live) { if (u) URL.revokeObjectURL(u); return; }
      if (u) { made = u; setUrl(u); } else setFailed(true);
    });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [matrix, file]);
  if (failed) return <span className="msg-file"><span className="material-symbols-outlined">image</span> (couldn't decrypt image)</span>;
  if (!url) return <span className="msg-file"><span className="material-symbols-outlined">lock</span> decrypting image…</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt={alt} className="msg-image" loading="lazy" />
    </a>
  );
}

export function RoomPanel({
  matrix,
  roomId,
  onClose,
  onNext,
  nextLabel,
  onStartCall,
  threadRootId,
  onOpenThread,
}: {
  matrix: MatrixSource;
  roomId: string;
  onClose: () => void;
  onNext?: () => void;
  nextLabel?: string;
  onStartCall?: (roomName: string) => void;
  // When set, this panel is a thread view: the timeline is filtered to the
  // thread, the composer threads new messages, and there is no "N replies"
  // affordance (we're already inside the thread).
  threadRootId?: string;
  // Open the thread hanging off a given message (main timeline only).
  onOpenThread?: (rootEventId: string) => void;
}) {
  const [snap, setSnap] = useState<RoomTimelineSnapshot | null>(() => matrix.getRoomTimeline(roomId, 200, threadRootId));
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
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
      // Drop the failed echo so it doesn't look sent and doesn't block the queue.
      matrix.cancelFailedEvents(roomId);
    } finally {
      setUploading(false);
    }
  };
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // ── @-mention autocomplete ──
  // `mention` is the active trailing "@query" being typed (null when none).
  // We keep refs in sync so the imperative composer listeners (attached
  // once) always read the latest values without stale closures.
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const membersRef = useRef<{ userId: string; name: string; avatarUrl?: string }[]>([]);
  const mentionRef = useRef<{ query: string; index: number } | null>(null);
  mentionRef.current = mention;
  const composeTextRef = useRef('');
  composeTextRef.current = composeText;
  // Display name → userId for mentions the user picked, so send() can build
  // matrix.to pills + m.mentions even though the composer is plain text.
  const acceptedMentions = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    // Seed with whatever's already known, then fetch the full roster — with
    // lazyLoadMembers the synchronous list is only the members seen so far,
    // so autocomplete would otherwise miss people who haven't spoken.
    membersRef.current = matrix.getRoomMembers(roomId);
    void matrix.loadRoomMembers(roomId).then((mem) => { if (!cancelled && mem.length) membersRef.current = mem; });
    return () => { cancelled = true; };
  }, [matrix, roomId]);

  const TRAILING_MENTION = /(^|\s)@([^\s@]{0,30})$/;
  const computeMatches = (query: string) => {
    const q = query.toLowerCase();
    return membersRef.current
      .filter((m) => m.name.toLowerCase().includes(q) || m.userId.slice(1).toLowerCase().includes(q))
      .slice(0, 8);
  };
  const mentionMatches = mention ? computeMatches(mention.query) : [];

  const acceptMention = (member: { userId: string; name: string }, fieldEl: { value: string } & HTMLElement) => {
    const v = composeTextRef.current;
    const newV = v.replace(TRAILING_MENTION, (_full, lead: string) => `${lead}@${member.name} `);
    acceptedMentions.current.set(member.name, member.userId);
    fieldEl.value = newV;
    setComposeText(newV);
    setMention(null);
    fieldEl.focus();
  };

  useEffect(() => {
    const unsub = matrix.subscribe(() => {
      setSnap(matrix.getRoomTimeline(roomId, 200, threadRootId));
    });
    void matrix.markRoomRead(roomId);
    return unsub;
  }, [matrix, roomId, threadRootId]);

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
    // The composer stays focusable during send (disabling it dropped focus
    // after Enter), so guard re-entrancy here against a fast double-Enter.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      // Turn accepted @mentions still present in the body into matrix.to
      // pills and collect their user ids for m.mentions.
      const mentionIds: string[] = [];
      const used: Array<[string, string]> = [];
      for (const [name, uid] of acceptedMentions.current) {
        if (!body.includes(`@${name}`)) continue;
        mentionIds.push(uid);
        used.push([name, uid]);
      }
      // Build formatted_body. If there's no markdown but there ARE mentions, we
      // still need HTML so the pills are sent as proper <a> mentions — some
      // bots (and clients) only recognise mentions in formatted_body. Fall back
      // to an escaped plain body in that case.
      let html = markdownToHtml(body);
      if (!html && used.length) html = escapeHtml(body).replace(/\n/g, '<br/>');
      if (html) {
        for (const [name, uid] of used) {
          const pill = `<a href="https://matrix.to/#/${uid}">${escapeHtml(`@${name}`)}</a>`;
          html = html.split(escapeHtml(`@${name}`)).join(pill);
        }
      }
      if (editing) {
        await matrix.editMessage(roomId, editing.eventId, body, html);
        setEditing(null);
      } else {
        await matrix.sendMessage(roomId, body, html, replyTo, mentionIds, threadRootId);
        setReplyTo(null);
      }
      acceptedMentions.current.clear();
      setComposeText('');
      // Imperatively clear the Material field too — its `value` property
      // doesn't track React state directly across renders.
      const field = document.querySelector('.composer md-outlined-text-field') as HTMLElement | null;
      if (field) { (field as unknown as { value: string }).value = ''; field.focus(); }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      // Remove the failed echo (so it doesn't look sent / block the queue).
      // The composer still holds `body`, so the user can edit and retry.
      matrix.cancelFailedEvents(roomId);
      setComposeText(body);
      const field = document.querySelector('.composer md-outlined-text-field') as (HTMLElement & { value: string }) | null;
      if (field) { field.value = body; field.focus(); }
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };
  // The composer listeners are attached once (guarded), so route send()
  // through a ref to always invoke the latest closure.
  const sendRef = useRef(send);
  sendRef.current = send;

  if (!snap) {
    // Full-screen even while loading — on a hash refresh the timeline isn't
    // hydrated yet, and a bare .issue-panel here is the old narrow side
    // overlay flashing before the room-panel takes over.
    return (
      <div className="issue-panel room-panel">
        <Header title="Loading…" onClose={onClose} onNext={onNext} nextLabel={nextLabel} />
        <div className="empty">
          <p>Loading conversation…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="issue-panel room-panel">
      <Header
        title={threadRootId ? 'Thread' : snap.roomName}
        subtitle={threadRootId ? snap.roomName : `${snap.memberCount} member${snap.memberCount === 1 ? '' : 's'}`}
        onClose={onClose}
        onNext={threadRootId ? undefined : onNext}
        nextLabel={nextLabel}
        onStartCall={!threadRootId && onStartCall ? () => onStartCall(snap.roomName) : undefined}
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
                {m.image && m.image.encrypted ? (
                  <EncryptedImage matrix={matrix} file={m.image.encrypted} alt={m.image.alt} />
                ) : m.image ? (
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
                  <CollapsibleBody className="comment-body">{renderFormattedHtml(m.html, { mxcToHttp: (mxc) => matrix.mxcToHttp(mxc, 64, 64) })}</CollapsibleBody>
                ) : (
                  <CollapsibleBody className="comment-body">{renderInline(m.body)}</CollapsibleBody>
                )}
                {m.edited && (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}> (edited)</span>
                )}
                {!threadRootId && m.threadSummary && onOpenThread && (
                  <button
                    type="button"
                    className="thread-summary"
                    onClick={() => onOpenThread(m.id)}
                    aria-label={`Open thread, ${m.threadSummary.count} repl${m.threadSummary.count === 1 ? 'y' : 'ies'}`}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>forum</span>
                    <span>{m.threadSummary.count} repl{m.threadSummary.count === 1 ? 'y' : 'ies'}</span>
                    <span className="thread-summary-ts">{new Date(m.threadSummary.latestTs).toLocaleString()}</span>
                  </button>
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
                      {r.key.startsWith('mxc://')
                        ? <img className="reaction-emoji" src={matrix.mxcToHttp(r.key, 32, 32) ?? ''} alt="reaction" />
                        : <span>{r.key}</span>}
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{r.count}</span>
                    </button>
                  ))}
                  <ReactionAdder onAdd={(key) => void matrix.toggleReaction(roomId, m.id, key)} />
                  {/* Reply / edit / delete: after the react button, always shown
                      (no hover reveal, so the message never reflows). */}
                  <button
                    type="button"
                    className="msg-reply"
                    aria-label="Reply"
                    title="Reply"
                    onClick={() => setReplyTo({ eventId: m.id, senderName: m.senderName, body: m.body })}
                  >
                    <span className="material-symbols-outlined">reply</span>
                  </button>
                  {!threadRootId && onOpenThread && (
                    <button
                      type="button"
                      className="msg-reply"
                      aria-label="Reply in thread"
                      title="Reply in thread"
                      onClick={() => onOpenThread(m.id)}
                    >
                      <span className="material-symbols-outlined">forum</span>
                    </button>
                  )}
                  {m.senderId === selfId && (
                    <>
                      <button
                        type="button"
                        className="msg-reply"
                        aria-label="Edit"
                        title="Edit"
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
                        title="Delete"
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
                {m.readBy && m.readBy.length > 0 && (
                  <div className="read-by" aria-label={`Read by ${m.readBy.map((r) => r.name).join(', ')}`}>
                    {m.readBy.slice(0, 5).map((r) => (
                      <span key={r.userId} title={r.name} className="read-by-avatar">
                        {r.avatarUrl
                          ? <img src={r.avatarUrl} alt="" />
                          : <span>{r.name.slice(0, 1).toUpperCase()}</span>}
                      </span>
                    ))}
                    {m.readBy.length > 5 && (
                      <span className="read-by-more">+{m.readBy.length - 5}</span>
                    )}
                  </div>
                )}
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
          <div className="send-error">
            <span className="material-symbols-outlined send-error-icon">error</span>
            <span className="send-error-text">Send failed: {sendError}</span>
            <button type="button" className="send-error-x" aria-label="Dismiss error" onClick={() => setSendError(null)}>
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        )}
        {mention && mentionMatches.length > 0 && (
          <div className="mention-menu" role="listbox">
            {mentionMatches.map((m, i) => (
              <button
                key={m.userId}
                type="button"
                role="option"
                aria-selected={i === mention.index}
                className={`mention-item ${i === mention.index ? 'active' : ''}`}
                // Use mousedown so it fires before the field's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  const field = document.querySelector('.composer md-outlined-text-field') as (HTMLElement & { value: string }) | null;
                  if (field) acceptMention(m, field);
                }}
              >
                {m.avatarUrl
                  ? <img className="mention-avatar" src={m.avatarUrl} alt="" />
                  : <span className="mention-avatar mention-avatar-fallback">{m.name.slice(0, 1).toUpperCase()}</span>}
                <span className="mention-name">{m.name}</span>
                <span className="mention-mxid">{m.userId}</span>
              </button>
            ))}
          </div>
        )}
        <md-outlined-text-field
          label="Reply"
          placeholder="Type a message…"
          value={composeText}
          ref={(el: HTMLElement | null) => {
            if (!el) return;
            // Attach listeners ONCE per element; re-running on every render
            // would stack duplicates (and double-fire send). Handlers read
            // live state through refs, so a single attach stays correct.
            const guard = el as unknown as { _wmComposerInit?: boolean };
            if (guard._wmComposerInit) return;
            guard._wmComposerInit = true;
            el.addEventListener('input', (ev) => {
              const target = ev.target as HTMLInputElement & { value: string };
              let v = target.value;
              const expanded = expandShortcodes(v);
              if (expanded !== v) {
                v = expanded;
                target.value = v;
              }
              setComposeText(v);
              // Detect a trailing "@query" to drive the mention dropdown.
              const m = v.match(TRAILING_MENTION);
              setMention(m ? { query: m[2], index: 0 } : null);
              void matrix.sendTyping(roomId, v.length > 0, 30_000);
            });
            el.addEventListener('keydown', (ev: Event) => {
              const ke = ev as KeyboardEvent;
              const target = ev.target as HTMLInputElement & { value: string };
              // Mention navigation takes precedence over send / newline.
              const men = mentionRef.current;
              if (men) {
                const matches = computeMatches(men.query);
                if (matches.length > 0) {
                  if (ke.key === 'ArrowDown') {
                    ev.preventDefault();
                    setMention({ ...men, index: (men.index + 1) % matches.length });
                    return;
                  }
                  if (ke.key === 'ArrowUp') {
                    ev.preventDefault();
                    setMention({ ...men, index: (men.index - 1 + matches.length) % matches.length });
                    return;
                  }
                  if (ke.key === 'Enter' || ke.key === 'Tab') {
                    ev.preventDefault();
                    acceptMention(matches[men.index], target);
                    return;
                  }
                  if (ke.key === 'Escape') {
                    ev.preventDefault();
                    setMention(null);
                    return;
                  }
                }
              }
              if (ke.key === 'Enter' && !ke.shiftKey) {
                ev.preventDefault();
                void sendRef.current();
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

function Header({ title, subtitle, onClose, onNext, nextLabel, onStartCall }: { title: string; subtitle?: string; onClose: () => void; onNext?: () => void; nextLabel?: string; onStartCall?: () => void }) {
  return (
    <header className="issue-head">
      <md-icon-button onClick={onClose} aria-label="Close">
        <md-icon>close</md-icon>
      </md-icon-button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="issue-title">{title}</div>
        {subtitle && <div className="issue-subtitle">{subtitle}</div>}
      </div>
      {onStartCall && (
        <button type="button" className="hamburger" aria-label="Start voice or video call" title="Start call" onClick={onStartCall}>
          <span className="material-symbols-outlined">videocam</span>
        </button>
      )}
      {onNext && (
        <button type="button" className="next-btn" title={nextLabel ? `Next: ${nextLabel}` : 'Next conversation'} onClick={onNext}>
          <span className="next-btn-text">
            <span className="next-btn-label">Next</span>
            {nextLabel && <span className="next-btn-sub">{nextLabel}</span>}
          </span>
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      )}
    </header>
  );
}
