// Reusable compose helper for the shared filter language. Renders quick
// toggle chips that add/remove predicate tokens in a query string. Used by
// both the search box and the bundle editor, so the two speak the same
// language and the same controls drive both.

import type { ItemFlavor } from './sources/types';

const FLAVOR_LABEL: Record<string, string> = {
  matrix: 'Matrix', whatsapp: 'WhatsApp', meta: 'Meta',
  signal: 'Signal', irc: 'IRC', issue: 'Tasks', gmail: 'Mail',
};
// Stable display order; only those actually present are shown.
const FLAVOR_ORDER: ItemFlavor[] = ['matrix', 'whatsapp', 'meta', 'signal', 'irc', 'issue', 'gmail'];

export function QueryChips({
  query, onChange, flavors,
}: {
  query: string;
  onChange: (q: string) => void;
  flavors?: ItemFlavor[]; // which flavor chips to show — typically the ones detected in the inbox
}) {
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
  // Show flavor chips only for sources actually present (detected bridges +
  // Matrix + Tasks), so we don't offer e.g. a Meta filter the user never uses.
  const shownFlavors = (flavors && flavors.length > 0
    ? FLAVOR_ORDER.filter((f) => flavors.includes(f))
    : (['matrix', 'issue'] as ItemFlavor[]));
  return (
    <>
      <div className="section-filters" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
        {chip('is:unread', 'Unread')}
        {chip('is:dm', 'DMs')}
        {chip('is:mine', 'Assigned to me')}
        {chip('is:pinned', 'Pinned')}
        {chip('is:task', 'Tasks')}
      </div>
      {shownFlavors.length > 0 && (
        <div className="section-filters" style={{ flexWrap: 'wrap', overflow: 'visible', alignItems: 'center' }}>
          <span className="filter-group-label">Source</span>
          {shownFlavors.map((f) => chip(`flavor:${f}`, FLAVOR_LABEL[f] ?? f))}
        </div>
      )}
    </>
  );
}
