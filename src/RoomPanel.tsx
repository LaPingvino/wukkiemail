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

  useEffect(() => {
    const unsub = matrix.subscribe(() => {
      setSnap(matrix.getRoomTimeline(roomId));
    });
    return unsub;
  }, [matrix, roomId]);

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
