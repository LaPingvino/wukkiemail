// Modal sheet for creating a new task (eu.kiefte.issue) in a chosen
// Matrix room. The room itself is the public/private boundary — a
// private DM with yourself = personal todo; a team room = shared.

import { useMemo, useState } from 'react';
import type { MatrixSource } from './sources/matrix';

export function NewTaskSheet({
  matrix, onClose, onCreated,
}: {
  matrix: MatrixSource;
  onClose: () => void;
  onCreated: (roomId: string, issueId: string) => void;
}) {
  const targets = useMemo(() => matrix.listTaskTargetRooms(), [matrix]);
  const [title, setTitle] = useState('');
  const [roomId, setRoomId] = useState<string>(targets[0]?.roomId ?? '');
  const [filter, setFilter] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = filter
    ? targets.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : targets;

  const submit = async () => {
    if (!roomId || !title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const issueId = await matrix.createTask(roomId, title.trim());
      onCreated(roomId, issueId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New task" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button
            type="button"
            className="hamburger"
            aria-label="Close"
            onClick={onClose}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>New task</div>
          <button
            type="button"
            className="sheet-submit"
            onClick={() => void submit()}
            disabled={!title.trim() || !roomId || submitting}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Title</span>
            <input
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief description…"
              onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && roomId) void submit(); }}
            />
          </label>
          <label className="sheet-label">
            <span>Where to track it</span>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter rooms…"
            />
          </label>
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
            Rooms already set up for issues come first. Rooms you can
            bootstrap a schema in are listed second — picking one will
            seed a default schema when you create your first task.
            Rooms where you can't post issues are hidden.
          </p>
          <ul className="target-list">
            {filtered.length === 0 ? (
              <li style={{ color: 'var(--muted)', padding: '12px 4px' }}>
                No matching rooms.
              </li>
            ) : filtered.map((t) => (
              <li key={t.roomId}>
                <label className={`target-row ${roomId === t.roomId ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="task-target"
                    checked={roomId === t.roomId}
                    onChange={() => setRoomId(t.roomId)}
                  />
                  <span className={`src ${t.flavor}`} />
                  <div className="target-name">{t.name}</div>
                  <div className="target-meta">
                    {!t.hasSchema && '+ schema · '}
                    {t.isDm ? 'Private' : `${t.memberCount} members`}
                  </div>
                </label>
              </li>
            ))}
          </ul>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13 }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
