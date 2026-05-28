// Per-room "done" status editor. For each room whose task schema has a
// kanban-group enum, the user picks which status values count as done
// (and therefore sink in the inbox). Empty selection falls back to the
// schema default (the last value). Applies immediately via triage
// account data — no Save button, since each toggle is its own change.

import { useState } from 'react';
import type { MatrixSource, IssueRoomStatus } from './sources/matrix';

export function DoneValuesSheet({ matrix, onClose }: { matrix: MatrixSource; onClose: () => void }) {
  const [rooms, setRooms] = useState<IssueRoomStatus[]>(() => matrix.listIssueRoomsWithStatus());
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (room: IssueRoomStatus, value: string) => {
    // Build the next done set. If the room is currently on the default
    // (no override), start from the default set so the first toggle is
    // an explicit edit rather than wiping everything.
    const current = new Set(room.doneValues);
    if (current.has(value)) current.delete(value); else current.add(value);
    const next = [...current];
    setBusy(room.roomId);
    try {
      await matrix.setDoneValuesForRoom(room.roomId, next);
      setRooms(matrix.listIssueRoomsWithStatus());
    } finally {
      setBusy(null);
    }
  };

  const reset = async (room: IssueRoomStatus) => {
    setBusy(room.roomId);
    try {
      await matrix.setDoneValuesForRoom(room.roomId, []);
      setRooms(matrix.listIssueRoomsWithStatus());
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Task "done" statuses</div>
        </header>
        <div className="sheet-body">
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
            Pick which status values count as <strong>done</strong> per room —
            done tasks sink to the bottom of the inbox. Leave none selected to
            use the schema default (the last status).
          </p>
          {rooms.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              No task rooms with a status field yet. Create a task first.
            </p>
          ) : (
            rooms.map((room) => (
              <div key={room.roomId} className="done-room">
                <div className="done-room-head">
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {room.name}
                  </strong>
                  {room.isOverride && (
                    <button
                      type="button"
                      className="mini-chip"
                      onClick={() => void reset(room)}
                      disabled={busy === room.roomId}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <div className="section-filters" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
                  {room.values.map((value) => {
                    const on = room.doneValues.includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`mini-chip ${on ? 'active' : ''}`}
                        onClick={() => void toggle(room, value)}
                        disabled={busy === room.roomId}
                      >
                        {on && <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check</span>}
                        {value}
                      </button>
                    );
                  })}
                </div>
                {!room.isOverride && (
                  <div className="hint">Using default — only "{room.doneValues[0]}" is done.</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
