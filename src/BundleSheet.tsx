// Create / edit a manual bundle — a named saved filter. The query field
// uses the same filter language as search (src/filter.ts); the quick-add
// chips are a compose helper that appends predicates, and a live count
// shows how many current items match. This composer is intentionally
// standalone so the search box can reuse it later (step e).

import { useMemo, useState } from 'react';
import type { ManualBundle } from './sources/matrix';
import type { InboxItem, ItemFlavor } from './sources/types';
import { parseQuery, matchItem } from './filter';

const FLAVORS: { flavor: ItemFlavor; label: string }[] = [
  { flavor: 'matrix', label: 'Matrix' },
  { flavor: 'whatsapp', label: 'WhatsApp' },
  { flavor: 'meta', label: 'Meta' },
  { flavor: 'signal', label: 'Signal' },
  { flavor: 'irc', label: 'IRC' },
  { flavor: 'issue', label: 'Tasks' },
  { flavor: 'gmail', label: 'Mail' },
];

export function BundleSheet({
  items, selfMxid, initial, initialQuery, onSave, onDelete, onClose,
}: {
  items: InboxItem[];
  selfMxid: string | null;
  initial?: ManualBundle;            // editing an existing bundle
  initialQuery?: string;             // seed query (e.g. "save current search")
  onSave: (bundle: ManualBundle) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [query, setQuery] = useState(initial?.query ?? initialQuery ?? '');

  // Append a predicate token if it isn't already in the query.
  const addToken = (tok: string) => setQuery((q) => {
    const has = q.split(/\s+/).includes(tok);
    if (has) return q.split(/\s+/).filter((t) => t !== tok).join(' ').trim(); // toggle off
    return (q.trim() + ' ' + tok).trim();
  });
  const hasToken = (tok: string) => query.split(/\s+/).includes(tok);

  const matchCount = useMemo(() => {
    const f = parseQuery(query);
    return items.filter((it) => matchItem(f, it, { selfMxid })).length;
  }, [query, items, selfMxid]);

  const canSave = label.trim().length > 0 && query.trim().length > 0;
  const save = () => {
    if (!canSave) return;
    onSave({ id: initial?.id ?? crypto.randomUUID(), label: label.trim(), query: query.trim() });
  };

  const chip = (tok: string, text: string) => (
    <button
      key={tok}
      type="button"
      className={`mini-chip ${hasToken(tok) ? 'active' : ''}`}
      onClick={() => addToken(tok)}
    >{text}</button>
  );

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>{initial ? 'Edit bundle' : 'New bundle'}</div>
          {initial && onDelete && (
            <button type="button" className="hamburger" aria-label="Delete bundle" title="Delete" onClick={() => onDelete(initial.id)}>
              <span className="material-symbols-outlined">delete</span>
            </button>
          )}
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Name</span>
            <input type="text" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Family, Work, Bills" />
          </label>
          <label className="sheet-label">
            <span>Filter query</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='is:unread flavor:whatsapp from:mom'
            />
            <span className="hint">
              Same syntax as search. Combine free text with is:unread, is:dm,
              is:mine, flavor:x, from:name, status:value.
            </span>
          </label>
          <div className="section-filters" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
            {chip('is:unread', 'Unread')}
            {chip('is:dm', 'DMs')}
            {chip('is:mine', 'Assigned to me')}
            {chip('is:pinned', 'Pinned')}
            {chip('is:task', 'Tasks')}
          </div>
          <div className="section-filters" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
            {FLAVORS.map((f) => chip(`flavor:${f.flavor}`, f.label))}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            Matches <strong>{matchCount}</strong> current item{matchCount === 1 ? '' : 's'}.
          </div>
          <button type="button" className="sheet-submit" onClick={save} disabled={!canSave} style={{ justifySelf: 'end' }}>
            {initial ? 'Save changes' : 'Create bundle'}
          </button>
        </div>
      </div>
    </div>
  );
}
