// Create / edit a manual bundle — a named saved filter. The query field
// uses the same filter language as search (src/filter.ts); the quick-add
// chips are a compose helper that appends predicates, and a live count
// shows how many current items match. This composer is intentionally
// standalone so the search box can reuse it later (step e).

import { useMemo, useState } from 'react';
import type { ManualBundle } from './sources/matrix';
import type { InboxItem } from './sources/types';
import { parseQuery, matchItem } from './filter';
import { QueryChips } from './QueryChips';

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
  const [display, setDisplay] = useState<'folded' | 'expanded' | 'inline'>(initial?.display ?? 'folded');

  const matchCount = useMemo(() => {
    const f = parseQuery(query);
    return items.filter((it) => matchItem(f, it, { selfMxid })).length;
  }, [query, items, selfMxid]);

  const canSave = label.trim().length > 0 && query.trim().length > 0;
  const save = () => {
    if (!canSave) return;
    onSave({ id: initial?.id ?? crypto.randomUUID(), label: label.trim(), query: query.trim(), display });
  };

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
          <QueryChips query={query} onChange={setQuery} flavors={[...new Set(items.map((i) => i.flavor))]} />
          <label className="sheet-label">
            <span>Show as</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {([
                ['folded', 'Folded', 'Collapsed row you tap to open'],
                ['expanded', 'Expanded', 'Row open by default'],
                ['inline', 'Top section', 'Items shown directly at the top of the inbox (like Pinned)'],
              ] as const).map(([mode, name, desc]) => (
                <button
                  key={mode}
                  type="button"
                  className={`chip ${display === mode ? 'active' : ''}`}
                  title={desc}
                  onClick={() => setDisplay(mode)}
                >{name}</button>
              ))}
            </div>
          </label>
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
