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
  items, selfMxid, initial, initialQuery, onSave, onCreateSpace, onDelete, onClose,
}: {
  items: InboxItem[];
  selfMxid: string | null;
  initial?: ManualBundle;            // editing an existing bundle
  initialQuery?: string;             // seed query (e.g. "save current search")
  onSave: (bundle: ManualBundle) => void;
  onCreateSpace?: (name: string) => void; // create a real Matrix Space (renders as a bundle)
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [query, setQuery] = useState(initial?.query ?? initialQuery ?? '');
  const [display, setDisplay] = useState<'folded' | 'expanded' | 'inline'>(initial?.display ?? 'folded');
  // A new bundle can be a saved filter (the classic) or a real Space. Editing
  // is always a saved filter (existing manual bundles are filters).
  const [kind, setKind] = useState<'filter' | 'space'>('filter');
  const isSpace = !initial && kind === 'space';

  const matchCount = useMemo(() => {
    const f = parseQuery(query);
    return items.filter((it) => matchItem(f, it, { selfMxid })).length;
  }, [query, items, selfMxid]);

  const canSave = isSpace
    ? label.trim().length > 0
    : label.trim().length > 0 && query.trim().length > 0;
  const save = () => {
    if (!canSave) return;
    if (isSpace) { onCreateSpace?.(label.trim()); return; }
    onSave({ id: initial?.id ?? crypto.randomUUID(), label: label.trim(), query: query.trim(), display });
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Bundle editor" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>{initial ? 'Edit bundle' : isSpace ? 'New space' : 'New bundle'}</div>
          {initial && onDelete && (
            <button type="button" className="hamburger" aria-label="Delete bundle" title="Delete" onClick={() => onDelete(initial.id)}>
              <span aria-hidden="true" className="material-symbols-outlined">delete</span>
            </button>
          )}
        </header>
        <div className="sheet-body">
          {!initial && onCreateSpace && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className={`chip ${kind === 'filter' ? 'active' : ''}`} title="A saved search that gathers matching conversations" onClick={() => setKind('filter')}>Saved filter</button>
              <button type="button" className={`chip ${kind === 'space' ? 'active' : ''}`} title="A real Matrix Space — a shared, movable folder for rooms" onClick={() => setKind('space')}>Space</button>
            </div>
          )}
          <label className="sheet-label">
            <span>Name</span>
            <input type="text" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={isSpace ? 'e.g. Family, Team, Project X' : 'e.g. Family, Work, Bills'} />
          </label>
          {isSpace ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Creates a shared Space that shows here as a bundle. You can move
              rooms into it, and (unlike a saved filter) it syncs across your
              devices and people you invite.
            </div>
          ) : (
          <>
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
          </>
          )}
          <button type="button" className="sheet-submit" onClick={save} disabled={!canSave} style={{ justifySelf: 'end' }}>
            {initial ? 'Save changes' : isSpace ? 'Create space' : 'Create bundle'}
          </button>
        </div>
      </div>
    </div>
  );
}
