// Inline issue detail — opens when you click an issue item in the inbox.
// Every field is inline-editable: click the value to edit, blur or
// Enter to save. Status uses a horizontal chip bar instead of an
// edit-in-place control because it's the highest-frequency change.

import { useEffect, useState } from 'react';
import type { MatrixSource, SchemaField } from './sources/matrix';
import { renderInline, renderFormattedHtml, markdownToHtml } from './markdown';
import { expandShortcodes } from './emoji';

export function IssuePanel({
  matrix,
  roomId,
  issueId,
  onClose,
  onOpenChat,
}: {
  matrix: MatrixSource;
  roomId: string;
  issueId: string;
  onClose: () => void;
  onOpenChat?: () => void;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => matrix.subscribe(() => setTick((n) => n + 1)), [matrix]);
  const detail = matrix.getIssueDetail(roomId, issueId);
  void tick;
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const postComment = async () => {
    const body = comment.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await matrix.commentOnIssue(roomId, issueId, body, markdownToHtml(body));
      setComment('');
    } catch (e) {
      console.warn('[wukkiemail] commentOnIssue failed', e);
    } finally {
      setPosting(false);
    }
  };

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
  const statusField = schema.fields.find((f) => f.kanban_group && f.type === 'enum' && f.values?.length)
    ?? schema.fields.find((f) => f.type === 'enum' && f.values?.length);

  const save = async (key: string, value: unknown) => {
    try { await matrix.updateIssue(roomId, issueId, { [key]: value }); }
    catch (e) { console.warn('[wukkiemail] updateIssue failed', e); }
  };

  return (
    <div className="issue-panel">
      <Header
        title={String(content.title ?? '(untitled)')}
        subtitle={roomName}
        onClose={onClose}
        onOpenChat={onOpenChat}
      />
      <div className="issue-body">
        {statusField && statusField.values && (
          <div className="status-chips">
            {statusField.values.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip ${content[statusField.key] === v ? 'active' : ''}`}
                onClick={() => void save(statusField.key, v)}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <dl className="issue-fields">
          {schema.fields
            .filter((f) => !statusField || f.key !== statusField.key)
            .map((f) => (
              <EditableFieldRow
                key={f.key}
                field={f}
                value={content[f.key]}
                onSave={(v) => void save(f.key, v)}
              />
            ))}
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
                <div className="comment-body">
                  {c.html ? renderFormattedHtml(c.html) : renderInline(c.body)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="composer">
        <textarea
          value={comment}
          onChange={(e) => setComment(expandShortcodes(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void postComment();
            }
          }}
          placeholder="Add a comment…"
          rows={1}
          disabled={posting}
          style={{
            flex: 1, minWidth: 0,
            padding: '10px 12px',
            border: '1px solid var(--border)', borderRadius: 8,
            background: 'var(--bg)', color: 'var(--fg)', font: 'inherit',
            resize: 'vertical', minHeight: 40,
          }}
        />
        <button
          type="button"
          onClick={() => void postComment()}
          disabled={!comment.trim() || posting}
          style={{
            background: 'var(--md-sys-color-primary)',
            color: 'var(--md-sys-color-on-primary)',
            border: 'none', borderRadius: 999,
            padding: '8px 16px', cursor: 'pointer', font: 'inherit',
          }}
        >
          {posting ? 'Sending…' : 'Comment'}
        </button>
      </div>
    </div>
  );
}

function EditableFieldRow({
  field, value, onSave,
}: {
  field: SchemaField;
  value: unknown;
  onSave: (v: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => valueToString(value, field.type));

  if (!editing) {
    const display = value !== undefined && value !== '' && value !== null
      ? renderField(value, field.type)
      : <span style={{ color: 'var(--muted)' }}>—</span>;
    return (
      <div className="field-row">
        <dt>{field.label}</dt>
        <dd
          className="editable"
          onClick={() => { setDraft(valueToString(value, field.type)); setEditing(true); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(valueToString(value, field.type)); setEditing(true); } }}
        >
          {display}
        </dd>
      </div>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft === valueToString(value, field.type)) return;
    if (field.type === 'date' && draft === '') { onSave(''); return; }
    onSave(draft);
  };

  return (
    <div className="field-row">
      <dt>{field.label}</dt>
      <dd>
        {field.type === 'enum' && field.values ? (
          <div className="status-chips">
            {field.values.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip ${draft === v ? 'active' : ''}`}
                onClick={() => { setDraft(v); onSave(v); setEditing(false); }}
              >
                {v}
              </button>
            ))}
            <button type="button" className="chip" onClick={() => { setDraft(''); onSave(''); setEditing(false); }}>—</button>
          </div>
        ) : (
          <input
            autoFocus
            type={field.type === 'date' ? 'date' : 'text'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            placeholder={field.type === 'user' ? '@user:server' : ''}
            style={{
              width: '100%', padding: '6px 10px',
              border: '1px solid var(--border)', borderRadius: 8,
              background: 'var(--bg)', color: 'var(--fg)', font: 'inherit',
            }}
          />
        )}
      </dd>
    </div>
  );
}

function Header({ title, subtitle, onClose, onOpenChat }: { title: string; subtitle?: string; onClose: () => void; onOpenChat?: () => void }) {
  return (
    <header className="issue-head">
      <md-icon-button onClick={onClose} aria-label="Close">
        <md-icon>close</md-icon>
      </md-icon-button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="issue-title">{title}</div>
        {subtitle && <div className="issue-subtitle">{subtitle}</div>}
      </div>
      {onOpenChat && (
        <button type="button" className="hamburger" aria-label="Open chat" title="Open the chat for this room" onClick={onOpenChat}>
          <span className="material-symbols-outlined">forum</span>
        </button>
      )}
    </header>
  );
}

function valueToString(value: unknown, type: string): string {
  if (value === undefined || value === null) return '';
  if (type === 'date' && typeof value === 'string') {
    // Reformat for the date input's YYYY-MM-DD format if possible.
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return value;
  }
  return String(value);
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
