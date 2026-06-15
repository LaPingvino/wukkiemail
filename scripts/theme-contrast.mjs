// Theme contrast guard. Re-derives every theme's resolved colours the same way
// styles.css does (accent/role hues + per-style tint of neutral surfaces, with
// the dark-mode role lightening), then checks WCAG contrast for the key
// foreground/background pairs across ALL combinations:
//
//   mode (light/dark) × style (classic/tinted/strong) × hue (every preset
//   accent + palette + a spread of arbitrary "custom" hues).
//
// Run: `npm run test:theme`. Exits non-zero (and prints the offenders) if any
// pair drops below its threshold, so a tint tweak or a new palette that tanks
// readability fails loudly instead of shipping.
//
// Values (accent hues, neutrals, tints, on-colours) are PARSED from styles.css
// so they track the source; only the structural derivation formulas live here
// (kept in sync with the comments in styles.css :root / dark / style blocks).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveStrong } from '../src/theme.ts'; // Strong is JS-derived; test the real output

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');

// ── CSS parsing helpers ──────────────────────────────────────────────
function blockBody(selector) {
  const i = css.indexOf(selector + ' {');
  if (i < 0) throw new Error(`styles.css: selector not found: ${selector}`);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j += 1) {
    if (css[j] === '{') depth += 1;
    else if (css[j] === '}') { depth -= 1; if (depth === 0) return css.slice(open + 1, j); }
  }
  throw new Error(`styles.css: unbalanced braces after ${selector}`);
}
function props(body) {
  const out = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}
const pct = (v) => parseFloat(v) / 100; // "14%" -> 0.14

// ── colour maths (color-mix in srgb = plain componentwise lerp) ──────
function parseHex(hex) {
  let v = hex.trim().replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
}
const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };
// color-mix(in srgb, A fa%, B) -> A weighted fa, B weighted (1-fa).
function mix(a, b, fa) {
  return { r: a.r * fa + b.r * (1 - fa), g: a.g * fa + b.g * (1 - fa), b: a.b * fa + b.b * (1 - fa) };
}
function luminance({ r, g, b }) {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = luminance(a); const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ── parse the real values out of styles.css ──────────────────────────
const rootP = props(blockBody(':root'));
const darkP = props(blockBody(':root[data-theme="dark"]'));
const classicP = props(blockBody(':root[data-style="classic"]'));

// Parse the derivation percentages out of the CSS formulas so the test tracks
// them rather than hard-coding (keeps it honest if a mix ratio is tuned).
const num = (re, label) => { const m = css.match(re); if (!m) throw new Error(`styles.css: can't parse ${label}`); return parseFloat(m[1]) / 100; };
const FILL = num(/--md-sys-color-primary-container:\s*color-mix\(in srgb, var\(--md-sys-color-primary\) (\d+)%/, 'container fill %');
const ON_PRIM = num(/--md-sys-color-on-primary-container:\s*color-mix\(in srgb, var\(--md-sys-color-primary\) (\d+)%/, 'on-primary-container %');
const ON_SEC = num(/--md-sys-color-on-secondary-container:\s*color-mix\(in srgb, var\(--md-sys-color-secondary\) (\d+)%/, 'on-secondary-container %');
const ON_TER = num(/--md-sys-color-on-tertiary-container:\s*color-mix\(in srgb, var\(--md-sys-color-tertiary\) (\d+)%/, 'on-tertiary-container %');
const LINK = num(/--link-color:\s*color-mix\(in srgb, var\(--md-sys-color-tertiary\) (\d+)%/, 'link blend %');
const ACC_TEXT = num(/--accent-text:\s*color-mix\(in srgb, var\(--md-sys-color-primary\) (\d+)%/, 'accent-text blend %');
const DK_LIGHTEN = 1 - num(/--md-sys-color-primary:\s*color-mix\(in srgb, var\(--accent-base\), white (\d+)%\)/, 'dark role lighten %');
const DK_ONPRIM = 1 - num(/--md-sys-color-on-primary:\s*color-mix\(in srgb, var\(--accent-base\), black (\d+)%\)/, 'dark on-primary %');

// Accent / palette hues from every :root[data-accent="..."] rule.
const THEMES = [];
const accentRe = /:root\[data-accent="([\w-]+)"\]\s*\{([^}]*)\}/g;
let am;
while ((am = accentRe.exec(css))) {
  const p = props(am[2]);
  THEMES.push({
    key: am[1],
    accent: p['--accent-base'],
    secondary: p['--secondary-base'] || p['--accent-base'],
    tertiary: p['--tertiary-base'] || p['--accent-base'],
  });
}

// A spread of arbitrary custom base hues (mono — secondary/tertiary derive from
// base, as the builder does when multi-hue is off), to exercise the derivation
// for inputs no preset covers, including near-white / near-black edge bases.
for (let h = 0; h < 360; h += 30) THEMES.push({ key: `custom-h${h}`, ...hsl(h, 0.7, 0.45) });
THEMES.push({ key: 'custom-pale', ...hsl(210, 0.9, 0.82) });
THEMES.push({ key: 'custom-dark', ...hsl(210, 0.9, 0.18) });
// Achromatic bases (no hue) — Strong must keep these neutral grey, not invent a hue.
for (const c of ['#000000', '#ffffff', '#808080']) THEMES.push({ key: `custom-${c}`, accent: c, secondary: c, tertiary: c });
function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  const hex = `#${to(r)}${to(g)}${to(b)}`;
  return { accent: hex, secondary: hex, tertiary: hex };
}

// ── derive the resolved token colours for one combination ────────────
function tints(mode, style) {
  // classic/tinted only — strong is handled by deriveStrong, not the tint vars.
  const base = mode === 'dark' ? darkP : rootP;
  const src = style === 'classic' ? classicP : base;
  const t = (k) => pct((src[k] ?? base[k]));
  return { t0: t('--tint-0'), tVar: t('--tint-var'), t1: t('--tint-1'), tLow: t('--tint-low'), tOut: t('--tint-outline') };
}
function tokens(theme, mode, style) {
  if (style === 'strong' || style === 'strong-invert') {
    // Bold style is built in JS from the primary hue; check that real output for
    // both day/night algorithms (anchored = keep colour, invert = light/dark).
    const t = deriveStrong(theme.accent, mode === 'dark', style === 'strong-invert' ? 'invert' : 'anchored');
    const g = (k) => parseHex(t[k]);
    return {
      fg: g('--md-sys-color-on-surface'), muted: g('--md-sys-color-on-surface-variant'),
      bg: g('--md-sys-color-surface-container-low'), card: g('--md-sys-color-surface'),
      container: g('--md-sys-color-surface-container'),
      primary: g('--md-sys-color-primary'), onPrimary: g('--md-sys-color-on-primary'),
      primaryContainer: g('--md-sys-color-primary-container'), onPrimaryContainer: g('--md-sys-color-on-primary-container'),
      secondaryContainer: g('--md-sys-color-secondary-container'), onSecondaryContainer: g('--md-sys-color-on-secondary-container'),
      tertiaryContainer: g('--md-sys-color-tertiary-container'), onTertiaryContainer: g('--md-sys-color-on-tertiary-container'),
      linkColor: g('--link-color'), accentText: g('--accent-text'),
    };
  }
  const src = mode === 'dark' ? darkP : rootP;
  const surf0 = parseHex(src['--surf-0']); const surfVar = parseHex(src['--surf-var']);
  const surf1 = parseHex(src['--surf-1']); const surfLow = parseHex(src['--surf-low']);
  const outline0 = parseHex(src['--outline-0']);
  const onSurface = parseHex(src['--md-sys-color-on-surface']);
  const onSurfaceVar = parseHex(src['--md-sys-color-on-surface-variant']);
  const accent = parseHex(theme.accent); const sec = parseHex(theme.secondary); const ter = parseHex(theme.tertiary);
  const { t0, tVar, t1, tLow, tOut } = tints(mode, style);

  // Dark lightens the role hues; on-primary darkens (see styles.css dark block).
  const primary = mode === 'dark' ? mix(accent, WHITE, DK_LIGHTEN) : accent;
  const secondary = mode === 'dark' ? mix(sec, WHITE, DK_LIGHTEN) : sec;
  const tertiary = mode === 'dark' ? mix(ter, WHITE, DK_LIGHTEN) : ter;
  const onPrimary = mode === 'dark' ? mix(accent, BLACK, DK_ONPRIM) : WHITE;

  const surface = mix(accent, surf0, t0);
  const surfaceContainer = mix(accent, surf1, t1);
  const bg = mix(accent, surfLow, tLow);
  void mix(accent, surfVar, tVar); void mix(accent, outline0, tOut); // parsed for completeness

  return {
    fg: onSurface, muted: onSurfaceVar, bg, card: surface, container: surfaceContainer,
    primary, onPrimary,
    primaryContainer: mix(primary, surface, FILL), onPrimaryContainer: mix(primary, onSurface, ON_PRIM),
    secondaryContainer: mix(secondary, surface, FILL), onSecondaryContainer: mix(secondary, onSurface, ON_SEC),
    tertiaryContainer: mix(tertiary, surface, FILL), onTertiaryContainer: mix(tertiary, onSurface, ON_TER),
    linkColor: mix(tertiary, onSurface, LINK),
    accentText: mix(primary, onSurface, ACC_TEXT),
  };
}

// ── the pairs we require to be legible ───────────────────────────────
// Honest, usage-aware WCAG: 4.5 (AA normal text) for the reading surfaces that
// MUST stay legible regardless of theme; 3.0 (AA large-text / UI components) for
// accent-coloured UI — buttons, tonal chips, icons.
// `safe: true` = the hard floor we guarantee for ANY base hue, including a
// free-form custom pick: body text uses the fixed on-surface colour against a
// light/dark surface, so it stays readable no matter the hue. Everything else
// (muted/links/accent text/buttons/tonal chips) is held to the curated PRESETS —
// those are chosen to pass AA — but NOT enforced for arbitrary custom colours,
// since a neon-yellow or near-white custom base making its own accent text soft
// is the user's call, exactly like the button colour.
const PAIRS = [
  { name: 'body on bg', fg: 'fg', bg: 'bg', min: 4.5, safe: true },
  { name: 'body on card', fg: 'fg', bg: 'card', min: 4.5, safe: true },
  { name: 'body on container', fg: 'fg', bg: 'container', min: 4.5, safe: true },
  { name: 'muted on bg', fg: 'muted', bg: 'bg', min: 4.5 },
  { name: 'link on card', fg: 'linkColor', bg: 'card', min: 4.5 },
  { name: 'link on bg', fg: 'linkColor', bg: 'bg', min: 4.5 },
  { name: 'button text', fg: 'onPrimary', bg: 'primary', min: 3.0 },
  { name: 'primary-container text', fg: 'onPrimaryContainer', bg: 'primaryContainer', min: 3.0 },
  { name: 'chip/pill text (secondary)', fg: 'onSecondaryContainer', bg: 'secondaryContainer', min: 3.0 },
  { name: 'count chip text (tertiary)', fg: 'onTertiaryContainer', bg: 'tertiaryContainer', min: 3.0 },
  { name: 'accent text/icon on card', fg: 'accentText', bg: 'card', min: 4.5 },
  { name: 'accent text/icon on bg', fg: 'accentText', bg: 'bg', min: 4.5 },
];

const MODES = ['light', 'dark'];
const STYLES = ['classic', 'tinted', 'strong', 'strong-invert'];
const failures = [];
let checks = 0;
for (const theme of THEMES) {
  const custom = theme.key.startsWith('custom-');
  for (const mode of MODES) {
    for (const style of STYLES) {
      const tk = tokens(theme, mode, style);
      for (const p of PAIRS) {
        // Free-form custom picks: in tint-based styles only the derivation-safe
        // pairs are guaranteed (accent-on-accent is the user's call). Strong is
        // built with auto black/white text, so it's fully checked for any hue.
        if (custom && !p.safe && !style.startsWith('strong')) continue;
        checks += 1;
        const ratio = contrast(tk[p.fg], tk[p.bg]);
        if (ratio < p.min) {
          failures.push({ theme: theme.key, mode, style, pair: p.name, ratio: ratio.toFixed(2), min: p.min });
        }
      }
    }
  }
}

console.log(`theme-contrast: ${checks} checks across ${THEMES.length} hues × ${MODES.length} modes × ${STYLES.length} styles`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} contrast failures:\n`);
  for (const f of failures) {
    console.error(`  ${f.theme.padEnd(12)} ${f.mode.padEnd(5)} ${f.style.padEnd(7)} — ${f.pair}: ${f.ratio} (need ${f.min})`);
  }
  process.exit(1);
}
console.log('✓ all theme combinations meet their contrast thresholds');
