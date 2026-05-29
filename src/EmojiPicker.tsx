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

// Skin-tone preference (0 = default/no tone, 1-5 = light→dark), persisted so it
// sticks across picker opens. Swatches use the raised-hand emoji in each tone.
const TONE_KEY = 'wukkiemail:emoji-tone';
const TONE_SWATCHES = ['✋', '✋\u{1F3FB}', '✋\u{1F3FC}', '✋\u{1F3FD}', '✋\u{1F3FE}', '✋\u{1F3FF}'];
const loadTone = (): number => {
  const n = parseInt(localStorage.getItem(TONE_KEY) || '0', 10);
  return n >= 0 && n <= 5 ? n : 0;
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
  const [tone, setTone] = useState<number>(loadTone);
  const rootRef = useRef<HTMLDivElement>(null);

  // Apply the chosen skin tone to an emoji that supports it; base char otherwise.
  const toned = (e: EmojiEntry): string =>
    (tone && e.skins?.find((s) => s.tone === tone)?.char) || e.char;
  const chooseTone = (t: number) => { setTone(t); try { localStorage.setItem(TONE_KEY, String(t)); } catch { /* ignore */ } };

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
    const ch = toned(e);
    pushRecent({ char: ch, shortcode: e.shortcodes[0] });
    setRecent(loadRecent());
    onPick({ char: ch });
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
        <div className="emoji-tones" role="group" aria-label="Skin tone">
          {TONE_SWATCHES.map((sw, i) => (
            <button
              key={i}
              type="button"
              className={`emoji-tone ${tone === i ? 'active' : ''}`}
              title={i === 0 ? 'Default skin tone' : `Skin tone ${i}`}
              onClick={() => chooseTone(i)}
            >{sw}</button>
          ))}
        </div>
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
                <button key={e.char} type="button" className="emoji-btn" title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onClick={() => pickUnicode(e)}>{toned(e)}</button>
              ))}
            </div>
          </section>
        ) : (
          grouped?.map(({ group, items }) => (
            <section key={group} className="emoji-section">
              <h4>{GROUP_LABELS[group]}</h4>
              <div className="emoji-grid">
                {items.map((e) => (
                  <button key={e.char} type="button" className="emoji-btn" title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onClick={() => pickUnicode(e)}>{toned(e)}</button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
