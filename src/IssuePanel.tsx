// Inline issue detail — opens when you click an issue item in the inbox.
// Reads the issue state event + comments via MatrixSource.getIssueDetail,
// renders the schema fields, the comment timeline, status chips for
// quick state changes, and a back button.

import { useEffect, useState } from 'react';
import type { MatrixSource } from './sources/matrix';

export function IssuePanel({
  matrix,
  roomId,
  issueId,
  onClose,
}: {
  matrix: MatrixSource;
  roomId: string;
  issueId: string;
  onClose: () => void;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => matrix.subscribe(() => setTick((n) => n + 1)), [matrix]);
  const detail = matrix.getIssueDetail(roomId, issueId);
  void tick;

  if (!detail) {
    return (
      <div className="issue-panel">
        <Header title="Issue not found" onClose={onClose} />
        <div className="empty">
          We don't have this issue cached yet. Either Matrix is still syncing
          the room, or the issue has been deleted.
        </div>
      </div>
    );
  }

  const { content, schema, comments, roomName } = detail;
  const title = String(content.title ?? '(untitled)');
  // Find the kanban-group enum field, if any — used for the inline
  // status chip bar. Falls back to first enum field with values.
  const statusField = schema.fields.find((f) => f.kanban_group && f.type === 'enum' && f.values?.length)
    ?? schema.fields.find((f) => f.type === 'enum' && f.values?.length);

  const changeStatus = async (next: string) => {
    try { await matrix.updateIssue(roomId, issueId, { [statusField!.key]: next }); }
    catch (e) { console.warn('[wukkiemail] updateIssue failed', e); }
  };

  return (
    <div className="issue-panel">
      <Header title={title} subtitle={roomName} onClose={onClose} />
      <div className="issue-body">
        {statusField && statusField.values && (
          <div className="status-chips">
            {statusField.values.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip ${content[statusField.key] === v ? 'active' : ''}`}
                onClick={() => void changeStatus(v)}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <dl className="issue-fields">
          {schema.fields
            .filter((f) => f.key !== 'title' && (!statusField || f.key !== statusField.key))
            .map((f) => {
              const v = content[f.key];
              if (v === undefined || v === '' || v === null) return null;
              return (
                <div key={f.key} className="field-row">
                  <dt>{f.label}</dt>
                  <dd>{renderField(v, f.type)}</dd>
                </div>
              );
            })}
        </dl>

        <h3 style={{ marginTop: 24 }}>Comments</h3>
        {comments.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No comments yet.</p>
        ) : (
          <ul className="comment-list">
            {comments.map((c) => (
              <li key={c.id}>
                <div className="comment-head">
                  <strong>{c.sender}</strong>
                  <span className="ts">{new Date(c.ts).toLocaleString()}</span>
                </div>
                <div className="comment-body">{c.body}</div>
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

function renderField(value: unknown, type: string): string {
  if (type === 'date' && typeof value === 'string') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toLocaleDateString();
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
