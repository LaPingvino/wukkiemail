// Reusable compose helper for the shared filter language. Renders quick
// toggle chips that add/remove predicate tokens in a query string. Used by
// both the search box and the bundle editor, so the two speak the same
// language and the same controls drive both.

import type { ItemFlavor } from './sources/types';

// Mail (flavor:gmail) is deliberately omitted — the only mail backend is
// JMAP (which Gmail doesn't implement) and it isn't wired up yet, so
// offering a Mail filter would surface an always-empty predicate.
const FLAVORS: { flavor: ItemFlavor; label: string }[] = [
  { flavor: 'matrix', label: 'Matrix' },
  { flavor: 'whatsapp', label: 'WhatsApp' },
  { flavor: 'meta', label: 'Meta' },
  { flavor: 'signal', label: 'Signal' },
  { flavor: 'irc', label: 'IRC' },
  { flavor: 'issue', label: 'Tasks' },
];

export function QueryChips({ query, onChange }: { query: string; onChange: (q: string) => void }) {
  const tokens = query.split(/\s+/).filter(Boolean);
  const has = (tok: string) => tokens.includes(tok);
  const toggle = (tok: string) => {
    if (has(tok)) onChange(tokens.filter((t) => t !== tok).join(' '));
    else onChange([...tokens, tok].join(' '));
  };
  const chip = (tok: string, text: string) => (
    <button
      key={tok}
      type="button"
      className={`mini-chip ${has(tok) ? 'active' : ''}`}
      onClick={() => toggle(tok)}
    >{text}</button>
  );
  return (
    <>
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
    </>
  );
}
