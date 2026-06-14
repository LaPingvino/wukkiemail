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

export type MatrixLinkTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'room'; roomId: string; eventId?: string; via: string[] }
  | { kind: 'alias'; alias: string; eventId?: string; via: string[] };

const decode = (s: string): string => {
  try { return decodeURIComponent(s); } catch { return s; }
};

export function parseMatrixToLink(href: string): MatrixLinkTarget | null {
  if (!href) return null;
  if (href.startsWith('matrix:')) return parseMatrixUri(href);

  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.hostname !== 'matrix.to' && !url.hostname.endsWith('.matrix.to')) return null;

  // matrix.to keeps everything in the fragment: "#/<entity>[/<eventId>]?via=…".
  const frag = url.hash.startsWith('#/') ? url.hash.slice(2) : '';
  if (!frag) return null;
  const qIdx = frag.indexOf('?');
  const path = qIdx >= 0 ? frag.slice(0, qIdx) : frag;
  const via = new URLSearchParams(qIdx >= 0 ? frag.slice(qIdx + 1) : '').getAll('via');
  const segs = path.split('/').filter(Boolean).map(decode);
  return fromSigil(segs[0], segs[1], via);
}

function parseMatrixUri(href: string): MatrixLinkTarget | null {
  const rest = href.slice('matrix:'.length);
  const qIdx = rest.indexOf('?');
  const path = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
  const via = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : '').getAll('via');
  // path: <type>/<id>[/e/<eventId>] where type is u | r | roomid (no sigils).
  const segs = path.split('/');
  const type = segs[0];
  const id = segs[1] ? decode(segs[1]) : '';
  const eventId = segs[2] === 'e' && segs[3] ? `$${decode(segs[3])}` : undefined;
  if (!id) return null;
  if (type === 'u') return { kind: 'user', userId: `@${id}` };
  if (type === 'r') return { kind: 'alias', alias: `#${id}`, eventId, via };
  if (type === 'roomid') return { kind: 'room', roomId: `!${id}`, eventId, via };
  return null;
}

function fromSigil(entity: string | undefined, eventId: string | undefined, via: string[]): MatrixLinkTarget | null {
  if (!entity) return null;
  switch (entity[0]) {
    case '@': return { kind: 'user', userId: entity };
    case '!': return { kind: 'room', roomId: entity, eventId, via };
    case '#': return { kind: 'alias', alias: entity, eventId, via };
    default: return null;
  }
}
