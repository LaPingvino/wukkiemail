// Inline issue detail — opens when you click an issue item in the inbox.
// Reads the issue state event + comments via MatrixSource.getIssueDetail,
// renders the schema fields, the comment timeline, and a back button.

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
  const detail = matrix.getIssueDetail(roomId, issueId);

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

  return (
    <div className="issue-panel">
      <Header title={title} subtitle={roomName} onClose={onClose} />
      <div className="issue-body">
        <dl className="issue-fields">
          {schema.fields
            .filter((f) => f.key !== 'title')
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
