// Full Unicode emoji set, lazily loaded from emojibase-data (code-split so it
// never bloats the main bundle — only fetched when the picker / ":" autocomplete
// first needs it). Builds a normalised list with groups + shortcodes for the
// picker UI and a flat search, and feeds the full shortcode map back into
// emoji.ts so typed ":shortcode:" expansion covers more than the built-in table.
import { registerFullShortcodes } from './emoji';

export interface EmojiEntry {
  char: string;
  label: string;
  group: number;
  order: number;
  shortcodes: string[];
  tags: string[];
  // Single-person skin-tone variants (tone 1-5 -> toned char), when the emoji
  // supports them. Multi-person tone combos are skipped (base char only).
  skins?: { tone: number; char: string }[];
}

// emojibase group index -> display label. Group 2 (component, e.g. skin tones)
// is intentionally omitted from the picker grid.
export const GROUP_LABELS: Record<number, string> = {
  0: 'Smileys & Emotion',
  1: 'People & Body',
  3: 'Animals & Nature',
  4: 'Food & Drink',
  5: 'Travel & Places',
  6: 'Activities',
  7: 'Objects',
  8: 'Symbols',
  9: 'Flags',
};
export const GROUP_ORDER = [0, 1, 3, 4, 5, 6, 7, 8, 9];

let cache: EmojiEntry[] | null = null;
let loading: Promise<EmojiEntry[]> | null = null;

export function loadedEmojis(): EmojiEntry[] | null {
  return cache;
}

export async function loadEmojis(): Promise<EmojiEntry[]> {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    const [compactMod, shortcodesMod] = await Promise.all([
      import('emojibase-data/en/compact.json'),
      import('emojibase-data/en/shortcodes/emojibase.json'),
    ]);
    const compact = (compactMod.default ?? compactMod) as Array<{
      hexcode: string; label: string; unicode: string; group?: number; order?: number; tags?: string[];
      skins?: Array<{ unicode: string; tone: number | number[] }>;
    }>;
    const sc = (shortcodesMod.default ?? shortcodesMod) as Record<string, string | string[]>;

    const list: EmojiEntry[] = compact
      .filter((e) => typeof e.group === 'number' && e.group !== 2)
      .map((e) => {
        const raw = sc[e.hexcode];
        const shortcodes = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
        // Keep only single-person tone variants (tone is a lone number 1-5);
        // multi-person combos (tone is an array) fall back to the base char.
        const skins = e.skins
          ?.filter((s) => typeof s.tone === 'number')
          .map((s) => ({ tone: s.tone as number, char: s.unicode }));
        return {
          char: e.unicode,
          label: e.label,
          group: e.group as number,
          order: e.order ?? 0,
          shortcodes,
          tags: e.tags ?? [],
          ...(skins && skins.length ? { skins } : {}),
        };
      })
      .sort((a, b) => a.group - b.group || a.order - b.order);

    // Feed every shortcode -> char into emoji.ts so synchronous expansion of
    // typed ":shortcode:" isn't limited to the small built-in table.
    const map: Record<string, string> = {};
    for (const e of list) for (const code of e.shortcodes) if (!map[code]) map[code] = e.char;
    registerFullShortcodes(map);

    cache = list;
    return list;
  })();
  return loading;
}

// Rank emoji for a query against shortcodes, label, and tags. Exact/prefix
// shortcode matches rank highest. Returns at most `limit` entries.
export function searchEmojis(list: EmojiEntry[], query: string, limit = 40): EmojiEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return list.slice(0, limit);
  const scored: Array<{ e: EmojiEntry; score: number }> = [];
  for (const e of list) {
    let score = 0;
    for (const code of e.shortcodes) {
      if (code === q) { score = Math.max(score, 100); break; }
      if (code.startsWith(q)) score = Math.max(score, 80);
      else if (code.includes(q)) score = Math.max(score, 50);
    }
    if (!score) {
      if (e.label.toLowerCase().includes(q)) score = 30;
      else if (e.tags.some((t) => t.includes(q))) score = 20;
    }
    if (score) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
  return scored.slice(0, limit).map((s) => s.e);
}
