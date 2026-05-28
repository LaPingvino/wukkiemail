// Bridge detection — classify an mxid (or a Matrix room) into a flavor
// so the inbox UI can render bridged conversations naturally.
//
// We pattern-match the mxid localpart against the conventions used by
// the mautrix bridge family that Joop operates (see CLAUDE.md). Matches
// are intentionally loose; the worst case is mislabeling a room as
// "native matrix" instead of "whatsapp" — never a security issue.

import type { ItemFlavor } from './types';

interface BridgeRule {
  flavor: ItemFlavor;
  // localpart prefixes used by the bridge's appservice / puppet bot
  prefixes: string[];
}

const RULES: BridgeRule[] = [
  { flavor: 'whatsapp', prefixes: ['whatsappbot', 'whatsapp_', 'wabot'] },
  { flavor: 'meta',     prefixes: ['metabot', 'instagrambot', 'messengerbot', 'fbbot'] },
  { flavor: 'signal',   prefixes: ['signalbot', 'signal_'] },
  { flavor: 'irc',      prefixes: ['ircbot', 'heisenbridge', 'irc_'] },
];

export function flavorForMxid(mxid: string): ItemFlavor {
  const m = mxid.match(/^@([^:]+):/);
  if (!m) return 'matrix';
  const local = m[1].toLowerCase();
  for (const rule of RULES) {
    if (rule.prefixes.some((p) => local.startsWith(p))) return rule.flavor;
  }
  return 'matrix';
}

// Given the list of members of a room, pick a flavor: a bridge bot or
// bridge-puppet user "wins" over the human members.
export function flavorForRoomMembers(memberIds: string[]): ItemFlavor {
  for (const id of memberIds) {
    const f = flavorForMxid(id);
    if (f !== 'matrix') return f;
  }
  return 'matrix';
}
