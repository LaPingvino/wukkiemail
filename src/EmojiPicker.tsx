// Emoji picker — full Unicode set (lazy-loaded from emojibase) plus custom
// (mxc) emoji from the room's im.ponies packs. Used by the composer (insert)
// and the reaction adder (react). Picking a unicode emoji yields its char;
// picking a custom emoji yields { custom: { shortcode, mxc } } so the caller
// can send it as a data-mx-emoticon image (or as an mxc reaction key).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CustomEmoji } from './sources/matrix';
import { loadEmojis, searchEmojis, GROUP_LABELS, GROUP_ORDER, type EmojiEntry } from './emojiData';

export type EmojiPick = { char: string } | { custom: CustomEmoji };

type RecentItem = { char?: string; mxc?: string; shortcode?: string };
const RECENT_KEY = 'wukkiemail:emoji-recent';
const loadRecent = (): RecentItem[] => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
};
const pushRecent = (item: RecentItem) => {
  const key = item.char ?? item.mxc;
  const next = [item, ...loadRecent().filter((r) => (r.char ?? r.mxc) !== key)].slice(0, 24);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
};

export function EmojiPicker({ onPick, onClose, customEmojis, mxcToHttp, title }: {
  onPick: (pick: EmojiPick) => void;
  onClose: () => void;
  customEmojis: CustomEmoji[];
  mxcToHttp: (mxc: string) => string | null;
  title?: string;
}) {
  const [emojis, setEmojis] = useState<EmojiEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>(loadRecent);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void loadEmojis().then(setEmojis); }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const customMatches = useMemo(
    () => (q ? customEmojis.filter((c) => c.shortcode.toLowerCase().includes(q)) : customEmojis),
    [customEmojis, q],
  );
  const filtered = useMemo(() => (emojis ? searchEmojis(emojis, query, q ? 60 : 9999) : []), [emojis, query, q]);

  const pickUnicode = (e: EmojiEntry) => {
    pushRecent({ char: e.char, shortcode: e.shortcodes[0] });
    setRecent(loadRecent());
    onPick({ char: e.char });
  };
  const pickCustom = (c: CustomEmoji) => {
    pushRecent({ mxc: c.mxc, shortcode: c.shortcode });
    setRecent(loadRecent());
    onPick({ custom: c });
  };

  // Group the unicode results into sections (only when not searching).
  const grouped = useMemo(() => {
    if (q) return null;
    const by = new Map<number, EmojiEntry[]>();
    for (const e of filtered) {
      const arr = by.get(e.group) ?? [];
      arr.push(e);
      by.set(e.group, arr);
    }
    return GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g)! }));
  }, [filtered, q]);

  return (
    <div className="emoji-picker" ref={rootRef} role="dialog" aria-label={title ?? 'Emoji picker'}>
      <div className="emoji-search">
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--muted)' }}>search</span>
        <input
          type="text"
          autoFocus
          placeholder="Search emoji…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="emoji-scroll">
        {!emojis && customMatches.length === 0 && <div className="emoji-loading">Loading emoji…</div>}

        {!q && recent.length > 0 && (
          <section className="emoji-section">
            <h4>Recent</h4>
            <div className="emoji-grid">
              {recent.map((r, i) =>
                r.char ? (
                  <button key={`r${i}`} type="button" className="emoji-btn" title={r.shortcode} onClick={() => onPick({ char: r.char! })}>{r.char}</button>
                ) : r.mxc ? (
                  <button key={`r${i}`} type="button" className="emoji-btn" title={r.shortcode}
                    onClick={() => onPick({ custom: { shortcode: r.shortcode ?? 'emoji', mxc: r.mxc! } })}>
                    <img src={mxcToHttp(r.mxc) ?? ''} alt={r.shortcode ?? ''} />
                  </button>
                ) : null,
              )}
            </div>
          </section>
        )}

        {customMatches.length > 0 && (
          <section className="emoji-section">
            <h4>Custom</h4>
            <div className="emoji-grid">
              {customMatches.map((c) => (
                <button key={c.shortcode + c.mxc} type="button" className="emoji-btn" title={`:${c.shortcode}:`} onClick={() => pickCustom(c)}>
                  <img src={mxcToHttp(c.mxc) ?? ''} alt={c.shortcode} loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        )}

        {q ? (
          <section className="emoji-section">
            {filtered.length === 0 && customMatches.length === 0 && <div className="emoji-loading">No matches.</div>}
            <div className="emoji-grid">
              {filtered.map((e) => (
                <button key={e.char} type="button" className="emoji-btn" title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onClick={() => pickUnicode(e)}>{e.char}</button>
              ))}
            </div>
          </section>
        ) : (
          grouped?.map(({ group, items }) => (
            <section key={group} className="emoji-section">
              <h4>{GROUP_LABELS[group]}</h4>
              <div className="emoji-grid">
                {items.map((e) => (
                  <button key={e.char} type="button" className="emoji-btn" title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onClick={() => pickUnicode(e)}>{e.char}</button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
