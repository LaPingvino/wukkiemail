// Parse Matrix permalinks into a structured navigation target so the app can
// open them in-app instead of bouncing the user to the matrix.to webpage.
//
// Handles both link forms a Matrix client encounters in message bodies:
//   - matrix.to:  https://matrix.to/#/<entity>[/<eventId>][?via=a&via=b]
//   - matrix: URI (MSC2312):  matrix:u/user:server  matrix:r/alias:server/e/eventId
//                             matrix:roomid/opaque:server[/e/eventId][?via=…]
//
// `entity` carries a sigil that tells us what it is: @user, !roomId, #alias.
// Everything is URI-component-encoded in the fragment, so each path segment is
// decoded individually. Returns null for anything that isn't a Matrix link, so
// callers can fall through to the browser's default (open in a new tab).

// `action` is the optional intent both link forms can carry: ?action=chat on a
// user means "start/open a DM" (vs. just viewing the profile); ?action=join on a
// room is an explicit join request.
export type LinkAction = 'chat' | 'join';

export type MatrixLinkTarget =
  | { kind: 'user'; userId: string; action?: LinkAction }
  | { kind: 'room'; roomId: string; eventId?: string; via: string[]; action?: LinkAction }
  | { kind: 'alias'; alias: string; eventId?: string; via: string[]; action?: LinkAction };

const decode = (s: string): string => {
  try { return decodeURIComponent(s); } catch { return s; }
};

const readAction = (q: URLSearchParams): LinkAction | undefined => {
  const a = q.get('action');
  return a === 'chat' || a === 'join' ? a : undefined;
};

export function parseMatrixToLink(href: string): MatrixLinkTarget | null {
  if (!href) return null;
  if (href.startsWith('matrix:')) return parseMatrixUri(href);

  // Authored markdown sometimes drops the scheme ("matrix.to/#/…"); add it so
  // the URL parser (and the matrix.to host check) still recognise the link.
  const normalized = /^(https?:)?\/\//.test(href) ? href
    : /^(www\.)?matrix\.to\//.test(href) ? `https://${href}`
    : href;

  let url: URL;
  try { url = new URL(normalized); } catch { return null; }
  if (url.hostname !== 'matrix.to' && !url.hostname.endsWith('.matrix.to')) return null;

  // matrix.to keeps everything in the fragment: "#/<entity>[/<eventId>]?via=…".
  const frag = url.hash.startsWith('#/') ? url.hash.slice(2) : '';
  if (!frag) return null;
  const qIdx = frag.indexOf('?');
  const path = qIdx >= 0 ? frag.slice(0, qIdx) : frag;
  const q = new URLSearchParams(qIdx >= 0 ? frag.slice(qIdx + 1) : '');
  const segs = path.split('/').filter(Boolean).map(decode);
  return fromSigil(segs[0], segs[1], q.getAll('via'), readAction(q));
}

function parseMatrixUri(href: string): MatrixLinkTarget | null {
  const rest = href.slice('matrix:'.length);
  const qIdx = rest.indexOf('?');
  const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const q = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : '');
  const via = q.getAll('via');
  const action = readAction(q);
  // path: <type>/<id>[/e/<eventId>] where type is u | r | roomid (no sigils).
  const segs = path.split('/');
  const type = segs[0];
  const id = segs[1] ? decode(segs[1]) : '';
  const eventId = segs[2] === 'e' && segs[3] ? `$${decode(segs[3])}` : undefined;
  if (!id) return null;
  if (type === 'u') return { kind: 'user', userId: `@${id}`, action };
  if (type === 'r') return { kind: 'alias', alias: `#${id}`, eventId, via, action };
  if (type === 'roomid') return { kind: 'room', roomId: `!${id}`, eventId, via, action };
  return null;
}

function fromSigil(entity: string | undefined, eventId: string | undefined, via: string[], action?: LinkAction): MatrixLinkTarget | null {
  if (!entity) return null;
  switch (entity[0]) {
    case '@': return { kind: 'user', userId: entity, action };
    case '!': return { kind: 'room', roomId: entity, eventId, via, action };
    case '#': return { kind: 'alias', alias: entity, eventId, via, action };
    default: return null;
  }
}
