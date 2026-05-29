// Shared person picker: a search box with an avatar dropdown, used wherever
// the UI needs a Matrix user — New DM (single), New group invites (multi),
// and the issue "assignee" field (single, scoped to the room's members).
//
// Sources come from MatrixSource.searchUsers(query, roomId?): room members
// when roomId is set, otherwise known contacts + the homeserver directory.
// A full mxid typed by hand is always accepted (Enter), so directory-less
// servers and not-yet-known users still work.

import { useEffect, useId, useRef, useState } from 'react';
import type { MatrixSource, PersonHit } from './sources/matrix';

const MXID_RE = /^@[^:\s]+:[^:\s]+$/;

export function PersonPicker({
  matrix, roomId, value, onChange, multi = false, placeholder = 'Search people…', autoFocus,
}: {
  matrix: MatrixSource;
  roomId?: string;
  value: string[];
  onChange: (ids: string[]) => void;
  multi?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PersonHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number | undefined>(undefined);
  const listId = useId();

  // Debounced search whenever the query (or room) changes and the box is open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await matrix.searchUsers(query, roomId);
        if (!cancelled) { setHits(res.filter((h) => !value.includes(h.userId))); setActive(0); }
      } catch { if (!cancelled) setHits([]); }
    }, 160);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [query, roomId, matrix, open, value]);

  const pick = (id: string) => {
    if (!id) return;
    if (multi) {
      if (!value.includes(id)) onChange([...value, id]);
      setQuery('');
      setHits([]);
    } else {
      onChange([id]);
      setQuery('');
      setOpen(false);
    }
  };

  const remove = (id: string) => onChange(value.filter((x) => x !== id));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[active]) pick(hits[active].userId);
      else if (MXID_RE.test(query.trim())) pick(query.trim());
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); }
    } else if (e.key === 'Backspace' && !query && multi && value.length) {
      remove(value[value.length - 1]);
    }
  };

  // In single mode, the selected person replaces the input content.
  const single = !multi && value.length > 0 ? matrix.resolveUser(value[0]) : null;

  return (
    <div className="person-picker">
      <div className="person-picker-control" onClick={() => setOpen(true)}>
        {multi && value.map((id) => {
          const p = matrix.resolveUser(id);
          return (
            <span key={id} className="person-chip" title={id}>
              <PersonAvatar hit={p} size={18} />
              <span className="person-chip-name">{p.name}</span>
              <button type="button" className="person-chip-x" aria-label={`Remove ${p.name}`}
                onClick={(e) => { e.stopPropagation(); remove(id); }}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </span>
          );
        })}
        {single ? (
          <span className="person-chip selected" title={single.userId}>
            <PersonAvatar hit={single} size={18} />
            <span className="person-chip-name">{single.name}</span>
            <button type="button" className="person-chip-x" aria-label="Clear"
              onClick={(e) => { e.stopPropagation(); onChange([]); }}>
              <span className="material-symbols-outlined">close</span>
            </button>
          </span>
        ) : (
          <input
            type="text"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus={autoFocus}
            value={query}
            placeholder={multi && value.length ? '' : placeholder}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), 150); }}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {open && (hits.length > 0 || (query && MXID_RE.test(query.trim()))) && (
        <ul
          id={listId}
          className="person-picker-list"
          role="listbox"
          onMouseDown={() => { if (blurTimer.current) window.clearTimeout(blurTimer.current); }}
        >
          {hits.map((h, i) => (
            <li key={h.userId} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`person-option ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h.userId)}
              >
                <PersonAvatar hit={h} size={28} />
                <span className="person-option-text">
                  <span className="person-option-name">{h.name}</span>
                  <span className="person-option-id">{h.userId}</span>
                </span>
              </button>
            </li>
          ))}
          {hits.length === 0 && MXID_RE.test(query.trim()) && (
            <li role="option" aria-selected="true">
              <button type="button" className="person-option active" onClick={() => pick(query.trim())}>
                <span className="material-symbols-outlined" style={{ fontSize: 24, color: 'var(--muted)' }}>person_add</span>
                <span className="person-option-text">
                  <span className="person-option-name">Use {query.trim()}</span>
                  <span className="person-option-id">Exact Matrix ID</span>
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function PersonAvatar({ hit, size }: { hit: PersonHit; size: number }) {
  const [broken, setBroken] = useState(false);
  const hue = hashHue(hit.name || hit.userId);
  if (hit.avatarUrl && !broken) {
    return <img className="person-avatar" src={hit.avatarUrl} alt="" width={size} height={size}
      onError={() => setBroken(true)} style={{ width: size, height: size }} />;
  }
  return (
    <span className="person-avatar" style={{ width: size, height: size, background: `hsl(${hue} 55% 50%)`, fontSize: size * 0.45 }}>
      {initials(hit.name || hit.userId)}
    </span>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function initials(name: string): string {
  const cleaned = name.replace(/^@/, '').replace(/<[^>]+>/g, '').trim();
  const parts = cleaned.split(/[\s_:.-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
