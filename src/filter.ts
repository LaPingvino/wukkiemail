// Shared filter core — one system behind search, top-level filtering, and
// bundles (auto + manual). The insight (Joop): a bundle is just a named
// filter; "search" is a transient filter; a manually-added bundle is a
// saved filter. So anything bundles need, search gets for free, and vice
// versa. Build the predicate once, reuse everywhere.
//
// A Filter is a parsed query: free-text terms plus typed predicates. The
// query language is deliberately small and Gmail-ish:
//
//   is:unread is:read is:pinned is:snoozed is:done is:open is:dm is:mine
//   flavor:whatsapp   from:bob   status:"in progress"   in:space:!room:hs
//   plus any bare words → free-text match on subject/from/snippet/address
//
// Within a predicate group it's OR (flavor:a flavor:b → a or b); across
// groups and free-text terms it's AND. Empty filter matches everything.

import type { InboxItem } from './sources/types';

export interface FilterContext {
  selfMxid?: string | null;
}

export interface Filter {
  text: string[];     // free-text terms (AND)
  is: string[];       // status flags (AND): unread|read|pinned|snoozed|done|open|dm|mine
  flavor: string[];   // flavor:x (OR)
  from: string[];     // from:substr (OR)
  status: string[];   // status:x issue kanban value (OR)
  assigned: string[]; // assigned:me | assigned:@user:hs (OR) — any issue user field
  inBundle: string[]; // in:<bundleKey> matched against item.bundles (OR)
  raw: string;
}

export const EMPTY_FILTER: Filter = { text: [], is: [], flavor: [], from: [], status: [], assigned: [], inBundle: [], raw: '' };

// Split on whitespace but keep "double quoted" phrases together (so
// status:"in progress" and "exact phrase" work).
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /[^\s"]+|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : m[0]);
  return out;
}

export function parseQuery(raw: string): Filter {
  const f: Filter = { text: [], is: [], flavor: [], from: [], status: [], assigned: [], inBundle: [], raw };
  for (const tokRaw of tokenize(raw.trim())) {
    // Strip surrounding quotes a key:"value" token may still carry.
    const tok = tokRaw;
    const colon = tok.indexOf(':');
    if (colon > 0) {
      const key = tok.slice(0, colon).toLowerCase();
      const val = tok.slice(colon + 1).replace(/^"|"$/g, '').toLowerCase();
      if (!val && key !== 'is') { f.text.push(tok.toLowerCase()); continue; }
      switch (key) {
        case 'is': f.is.push(val); continue;
        case 'flavor': case 'kind': f.flavor.push(val); continue;
        case 'from': case 'sender': f.from.push(val); continue;
        case 'status': case 'state': f.status.push(val); continue;
        case 'assigned': case 'assignee': case 'to': f.assigned.push(val); continue;
        case 'in': case 'bundle': f.inBundle.push(val); continue;
        default: break; // unknown key → treat whole token as text
      }
    }
    f.text.push(tok.toLowerCase());
  }
  return f;
}

export function isEmptyFilter(f: Filter): boolean {
  return f.text.length === 0 && f.is.length === 0 && f.flavor.length === 0
    && f.from.length === 0 && f.status.length === 0 && f.assigned.length === 0 && f.inBundle.length === 0;
}

// Does any of `values` reference `who`? `who` is a full mxid, bare localpart,
// or display name; matching is loose (either side may contain the other).
function referencesUser(values: string[] | undefined, who: string): boolean {
  if (!values || !who) return false;
  const w = who.toLowerCase().trim();
  const wLocal = w.replace(/^@/, '').split(':')[0];
  return values.some((raw) => {
    const v = raw.toLowerCase().trim();
    if (!v) return false;
    return v === w || v === wLocal || v.includes(wLocal) || w.includes(v);
  });
}

// Loose self-match for user fields / senders: full mxid, bare localpart,
// or display name; either side may contain the other.
function referencesSelf(values: string[] | undefined, selfMxid: string | null | undefined): boolean {
  if (!selfMxid || !values || values.length === 0) return false;
  const mxid = selfMxid.toLowerCase();
  const local = mxid.replace(/^@/, '').split(':')[0];
  return values.some((raw) => {
    const v = raw.toLowerCase().trim();
    if (!v) return false;
    return v === mxid || v === local || v === `@${local}` || v.includes(local) || mxid.includes(v);
  });
}

function matchIs(flag: string, it: InboxItem, ctx: FilterContext): boolean {
  switch (flag) {
    case 'unread': return it.unread;
    case 'read': return !it.unread;
    case 'pinned': return it.bundles.includes('pinned');
    case 'snoozed': return it.bundles.includes('snoozed');
    case 'dm': return it.bundles.includes('dm');
    case 'task': case 'issue': return it.flavor === 'issue';
    case 'done': return it.flavor === 'issue' && it.priority <= -1;
    case 'open': case 'active': return it.flavor === 'issue' ? it.priority > -1 : it.unread;
    case 'mine': return referencesSelf(it.userValues, ctx.selfMxid);
    default: return true; // unknown flag → don't exclude
  }
}

export function matchItem(f: Filter, it: InboxItem, ctx: FilterContext = {}): boolean {
  if (isEmptyFilter(f)) return true;
  // is: flags — all must hold
  for (const flag of f.is) if (!matchIs(flag, it, ctx)) return false;
  // flavor: — any
  if (f.flavor.length && !f.flavor.includes(it.flavor)) return false;
  // status: — any (case-insensitive)
  if (f.status.length) {
    const sv = (it.statusValue ?? '').toLowerCase();
    if (!f.status.includes(sv)) return false;
  }
  // assigned: — any issue user field references the given person ("me" = self)
  if (f.assigned.length) {
    const ok = f.assigned.some((who) =>
      who === 'me' ? referencesSelf(it.userValues, ctx.selfMxid) : referencesUser(it.userValues, who));
    if (!ok) return false;
  }
  // in: bundle — any
  if (f.inBundle.length && !f.inBundle.some((b) => it.bundles.includes(b))) return false;
  // from: — any substring on sender name/address
  if (f.from.length) {
    const hay = `${it.from} ${it.fromAddress ?? ''}`.toLowerCase();
    if (!f.from.some((s) => hay.includes(s))) return false;
  }
  // free text — all terms, across the visible fields plus issue field values
  // (status + user fields) so you can search on issue contents too.
  if (f.text.length) {
    const fields = it.flavor === 'issue'
      ? ` ${it.statusValue ?? ''} ${(it.userValues ?? []).join(' ')}`
      : '';
    const hay = `${it.subject} ${it.from} ${it.snippet} ${it.fromAddress ?? ''}${fields}`.toLowerCase();
    if (!f.text.every((t) => hay.includes(t))) return false;
  }
  return true;
}

// A bundle is a named filter. Auto-bundles are derived from what's present
// (flavors, spaces, dm); manual bundles are user-authored and persisted.
export interface Bundle {
  id: string;
  label: string;
  query: string;   // parsed via parseQuery → its filter
  manual?: boolean;
}
