// Room detail — slide-in panel with the most recent messages of a room.
// Subscribes to the source's change events so new messages appear as
// they arrive. No compose/reply yet — this is the read-side preview.

import { useEffect, useState } from 'react';
import type { MatrixSource } from './sources/matrix';
import type { RoomTimelineSnapshot } from './sources/matrix';

export function RoomPanel({
  matrix,
  roomId,
  onClose,
}: {
  matrix: MatrixSource;
  roomId: string;
  onClose: () => void;
}) {
  const [snap, setSnap] = useState<RoomTimelineSnapshot | null>(() => matrix.getRoomTimeline(roomId));
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = matrix.subscribe(() => {
      setSnap(matrix.getRoomTimeline(roomId));
    });
    // Mark read on open. Fire-and-forget — the listItems poll picks up
    // the new unread state on the next refresh tick.
    void matrix.markRoomRead(roomId);
    return unsub;
  }, [matrix, roomId]);

  const send = async () => {
    const body = composeText.trim();
    if (!body) return;
    setSending(true);
    setSendError(null);
    try {
      await matrix.sendMessage(roomId, body);
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
      <div className="issue-body">
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
                <div className="comment-body">{m.body}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
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
              setComposeText((ev.target as HTMLInputElement & { value: string }).value);
            });
            el.addEventListener('keydown', (ev: Event) => {
              const ke = ev as KeyboardEvent;
              // Enter sends; Shift+Enter would insert a newline once we
              // upgrade this to a textarea variant.
              if (ke.key === 'Enter' && !ke.shiftKey) {
                ev.preventDefault();
                void send();
              }
            });
          }}
          disabled={sending || undefined}
          style={{ flex: 1, minWidth: 0 }}
        />
        <md-icon-button
          aria-label="Send"
          onClick={() => void send()}
          disabled={sending || !composeText.trim() || undefined}
        >
          <md-icon>send</md-icon>
        </md-icon-button>
      </div>
    </div>
  );
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
