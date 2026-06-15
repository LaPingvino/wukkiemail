// Theme: a light/dark/system mode, plus two orthogonal colour axes —
//   • accent (--accent-base / role hues), and
//   • style (data-style): how much that accent washes into surfaces.
// All stored in localStorage and applied to <html> as data-theme / data-accent /
// data-style attributes the CSS reads. System mode removes data-theme so the OS
// preference (the prefers-color-scheme media query) wins; light/dark force it.
// The picker presents accent×style as a handful of "approach groups" (Classic,
// Tinted, Strong, Palettes) plus a live custom builder — see THEME_GROUPS below.

export type ThemeMode = 'light' | 'dark' | 'system' | 'daynight';
export type Accent =
  | 'teal' | 'blue' | 'indigo' | 'pink' | 'amber' | 'green'
  | 'ocean' | 'sunset' | 'forest' | 'plum' | 'slate'
  | 'custom'; // user-built theme — colours come from CUSTOM_KEY, applied inline

// A hand-built theme: a base hue plus optional secondary/tertiary role hues, and
// an optional explicit `night` colour for Strong. When only `base` is set,
// secondary/tertiary derive from it (monochrome) and Strong's night is derived by
// the chosen algorithm; set `night` to pin the dark-time colour yourself. Stored
// as JSON under CUSTOM_KEY.
export interface CustomTheme { base: string; secondary?: string; tertiary?: string; night?: string }
// How strongly the accent tints the surfaces: classic = none (white/grey),
// tinted = a subtle wash, strong = bold colour across the whole UI. Drives the
// data-style attribute.
export type ThemeStyle = 'classic' | 'tinted' | 'strong';
// How Strong derives its day vs night look from one colour:
//  - anchored: keep the colour's lightness, flip only the text (colour identity stays)
//  - invert:   day = light surface, night = dark surface (the colour is hue-only)
// Ignored when a custom theme pins an explicit `night` colour (both ends given).
export type StrongAlgo = 'anchored' | 'invert';

const MODE_KEY = 'wm:theme-mode';
const ACCENT_KEY = 'wm:accent';
const STYLE_KEY = 'wm:theme-style';
const STRONG_ALGO_KEY = 'wm:strong-algo'; // 'anchored' | 'invert'
const CUSTOM_KEY = 'wm:custom'; // JSON CustomTheme for the 'custom' accent
const LOC_KEY = 'wm:geo'; // cached {lat,lon} so day/night doesn't re-prompt

// A spread of pleasant mid-tone hues for the custom builder's palette grid —
// roughly the Material 600/700 family across the spectrum. The native colour
// input + hex field cover anything not here.
export const PALETTE_GRID = [
  '#d32f2f', '#e53935', '#c2185b', '#d81b60', '#7b1fa2', '#512da8',
  '#303f9f', '#1976d2', '#0288d1', '#0097a7', '#00796b', '#388e3c',
  '#689f38', '#afb42b', '#f9a825', '#ffa000', '#f57c00', '#e64a19',
  '#5d4037', '#455a64',
];

// ── Sunrise/sunset (SunCalc core, trimmed to the two times we need) ──────────
const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

function toDays(date: number): number { return date / DAY_MS - 0.5 + J1970 - J2000; }
function fromJulian(j: number): number { return (j + 0.5 - J1970) * DAY_MS; }
function solarMeanAnomaly(d: number): number { return RAD * (357.5291 + 0.98560028 * d); }
function eclipticLongitude(M: number): number {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}
function declination(L: number): number { return Math.asin(Math.sin(OBLIQUITY) * Math.sin(L)); }
function solarTransitJ(ds: number, M: number, L: number): number {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

// Returns {sunrise, sunset} epoch ms, or null at the poles (no rise/set today).
function sunTimes(nowMs: number, lat: number, lon: number): { sunrise: number; sunset: number } | null {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(nowMs);
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + (0 + lw) / (2 * Math.PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const Jnoon = solarTransitJ(ds, M, L);
  const h0 = -0.833 * RAD; // standard sunrise/sunset altitude (incl. refraction)
  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH > 1 || cosH < -1) return null; // polar day/night
  const w = Math.acos(cosH);
  const a = 0.0009 + (w + lw) / (2 * Math.PI) + n;
  const Jset = solarTransitJ(a, M, L);
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
}

function getCachedLocation(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(LOC_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.lat === 'number' && typeof v?.lon === 'number') return v;
  } catch { /* ignore */ }
  return null;
}

// Local-clock fallback when we have no location (or it's polar): night before 7
// or from 19:00.
function localHourIsNight(): boolean {
  const h = new Date().getHours();
  return h < 7 || h >= 19;
}

// Is it currently night, for day/night mode?
export function isNightNow(): boolean {
  const loc = getCachedLocation();
  if (!loc) return localHourIsNight();
  const t = sunTimes(Date.now(), loc.lat, loc.lon);
  if (!t) return localHourIsNight();
  const now = Date.now();
  return now < t.sunrise || now >= t.sunset;
}

// Ask for location once (on opting into day/night); cache it and re-apply.
export function requestLocation(): void {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      try { localStorage.setItem(LOC_KEY, JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude })); } catch { /* ignore */ }
      applyTheme();
    },
    () => { /* denied/unavailable — day/night falls back to local clock */ },
    { maximumAge: 6 * 60 * 60 * 1000, timeout: 10_000 },
  );
}

// Re-apply day/night periodically so it flips around sunrise/sunset.
let watcherStarted = false;
export function startThemeWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  setInterval(() => { if (getThemeMode() === 'daynight') applyTheme(); }, 5 * 60 * 1000);
  // In System mode the CSS reacts to the OS theme on its own, but Strong's palette
  // is computed in JS — so re-derive it when the OS preference flips.
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemeMode() === 'system') applyTheme();
    });
  }
  // Background tabs throttle/suspend setInterval, so the 5-min day/night poll can
  // miss a sunrise/sunset while the tab is hidden — leaving Strong's auto
  // black/white text (and the light/dark surfaces) stale until reload. Re-derive
  // whenever the tab regains focus/visibility so it catches up immediately.
  const recheck = () => { const m = getThemeMode(); if (m === 'daynight' || m === 'system') applyTheme(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
  window.addEventListener('focus', recheck);
}

export const ACCENTS: { key: Accent; label: string; color: string }[] = [
  { key: 'teal', label: 'Teal', color: '#0d9488' },
  { key: 'blue', label: 'Blue', color: '#1a73e8' },
  { key: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { key: 'pink', label: 'Pink', color: '#d81b60' },
  { key: 'amber', label: 'Amber', color: '#c25f08' },
  { key: 'green', label: 'Green', color: '#157f3c' },
];

// Richer role-based palettes (primary / secondary / tertiary). Stored in the
// same data-accent slot as the simple accents; `colors` is just for the picker
// preview (primary first). The actual role hues live in the CSS rule for each
// key — keep the two in sync.
export const PALETTES: { key: Accent; label: string; colors: [string, string, string] }[] = [
  { key: 'ocean', label: 'Ocean', colors: ['#1565c0', '#0097a7', '#26a69a'] },
  { key: 'sunset', label: 'Sunset', colors: ['#e4572e', '#c2185b', '#f2a541'] },
  { key: 'forest', label: 'Forest', colors: ['#2e7d32', '#00897b', '#7cb342'] },
  { key: 'plum', label: 'Plum', colors: ['#6a1b9a', '#ab47bc', '#ec407a'] },
  { key: 'slate', label: 'Slate', colors: ['#455a64', '#5c6bc0', '#00acc1'] },
];

// Every selectable accent key (accents + palettes + custom) — validates stored prefs.
const ALL_THEME_KEYS: Accent[] = [...ACCENTS.map((a) => a.key), ...PALETTES.map((p) => p.key), 'custom'];

// The picker's "approach groups": each bundles a style with the accents it
// offers, so a single click sets both axes. `swatches[].colors` is just for the
// preview dots (primary first). Order = display order in Settings.
export interface ThemeSwatch { accent: Accent; label: string; colors: string[] }
export interface ThemeGroup { id: string; label: string; hint: string; style: ThemeStyle; swatches: ThemeSwatch[] }
const ACCENT_SWATCHES: ThemeSwatch[] = ACCENTS.map((a) => ({ accent: a.key, label: a.label, colors: [a.color] }));
export const THEME_GROUPS: ThemeGroup[] = [
  { id: 'classic', label: 'Classic', hint: 'White surfaces, colour on controls', style: 'classic', swatches: ACCENT_SWATCHES },
  { id: 'tinted', label: 'Tinted', hint: 'Accent washes through every surface', style: 'tinted', swatches: ACCENT_SWATCHES },
  { id: 'strong', label: 'Strong', hint: 'The colour itself everywhere; black or white text auto-picked', style: 'strong', swatches: ACCENT_SWATCHES },
  { id: 'palettes', label: 'Palettes', hint: 'Coordinated multi-colour schemes', style: 'tinted', swatches: PALETTES.map((p) => ({ accent: p.key, label: p.label, colors: p.colors })) },
];

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system' || v === 'daynight') return v;
  } catch { /* storage blocked */ }
  return 'system';
}

export function getAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY) as Accent | null;
    if (v && ALL_THEME_KEYS.includes(v)) return v;
  } catch { /* storage blocked */ }
  return 'teal';
}

export function getStyle(): ThemeStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v === 'classic' || v === 'tinted' || v === 'strong') return v;
    if (v === 'inbox') return 'strong'; // migrate the old 'inbox' style name
  } catch { /* storage blocked */ }
  return 'tinted';
}

const DEFAULT_CUSTOM: CustomTheme = { base: '#1a73e8' };

export function getCustom(): CustomTheme {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.base === 'string') {
        return {
          base: v.base,
          secondary: typeof v.secondary === 'string' ? v.secondary : undefined,
          tertiary: typeof v.tertiary === 'string' ? v.tertiary : undefined,
          night: typeof v.night === 'string' ? v.night : undefined,
        };
      }
    }
  } catch { /* storage blocked / bad json */ }
  return DEFAULT_CUSTOM;
}

export function getStrongAlgo(): StrongAlgo {
  try {
    const v = localStorage.getItem(STRONG_ALGO_KEY);
    if (v === 'anchored' || v === 'invert') return v;
  } catch { /* storage blocked */ }
  return 'anchored';
}

export function setStrongAlgo(algo: StrongAlgo): void {
  try { localStorage.setItem(STRONG_ALGO_KEY, algo); } catch { /* ignore */ }
  applyTheme();
}

export function applyTheme(): void {
  const root = document.documentElement;
  const mode = getThemeMode();
  if (mode === 'system') root.removeAttribute('data-theme');
  else if (mode === 'daynight') root.setAttribute('data-theme', isNightNow() ? 'dark' : 'light');
  else root.setAttribute('data-theme', mode);
  const accent = getAccent();
  const style = getStyle();
  root.setAttribute('data-accent', accent);
  root.setAttribute('data-style', style);

  const setBase = () => {
    // Custom themes drive the role base vars inline (presets do it via CSS rules
    // keyed on data-accent). An absent secondary/tertiary falls back to
    // --accent-base, i.e. a monochrome scheme from the one base colour.
    if (accent === 'custom') {
      const c = getCustom();
      root.style.setProperty('--accent-base', c.base);
      if (c.secondary) root.style.setProperty('--secondary-base', c.secondary); else root.style.removeProperty('--secondary-base');
      if (c.tertiary) root.style.setProperty('--tertiary-base', c.tertiary); else root.style.removeProperty('--tertiary-base');
    } else {
      root.style.removeProperty('--accent-base');
      root.style.removeProperty('--secondary-base');
      root.style.removeProperty('--tertiary-base');
    }
  };

  if (style === 'strong') {
    // Bold: build the whole palette from the colour in JS and apply it inline,
    // overriding the CSS tint-based surfaces. (Black/white text by luminance can't
    // be done in plain CSS.) The base-hue vars aren't needed here.
    for (const k of ['--accent-base', '--secondary-base', '--tertiary-base']) root.style.removeProperty(k);
    const dark = isDarkNow();
    let base: string;
    let algo = getStrongAlgo();
    if (accent === 'custom') {
      const c = getCustom();
      if (c.night) {
        // Manual day/night pair: use the explicit colour for each end, as-is
        // (anchored keeps the chosen colour as the surface). Algorithm n/a.
        base = dark ? c.night : c.base;
        algo = 'anchored';
      } else {
        base = c.base; // single colour → derive the other end via the algorithm
      }
    } else {
      base = hexForAccent(accent);
    }
    const tokens = deriveStrong(base, dark, algo);
    for (const k of STRONG_KEYS) root.style.setProperty(k, tokens[k]);
  } else {
    // Classic/Tinted: clear any Strong inline tokens so the CSS takes over again.
    for (const k of STRONG_KEYS) root.style.removeProperty(k);
    setBase();
  }
}

export function setThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  applyTheme();
}

// Set both axes at once — the picker selects an (accent, style) pair from a group.
export function setTheme(accent: Accent, style: ThemeStyle): void {
  try {
    localStorage.setItem(ACCENT_KEY, accent);
    localStorage.setItem(STYLE_KEY, style);
  } catch { /* ignore */ }
  applyTheme();
}

export function setAccent(accent: Accent): void {
  try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* ignore */ }
  applyTheme();
}

// Apply a hand-built theme (accent becomes 'custom'). Live: called on every edit
// in the builder. Empty secondary/tertiary are dropped so they derive from base.
export function setCustomTheme(custom: CustomTheme, style: ThemeStyle): void {
  const clean: CustomTheme = { base: custom.base };
  if (custom.secondary) clean.secondary = custom.secondary;
  if (custom.tertiary) clean.tertiary = custom.tertiary;
  if (custom.night) clean.night = custom.night;
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(clean));
    localStorage.setItem(ACCENT_KEY, 'custom');
    localStorage.setItem(STYLE_KEY, style);
  } catch { /* ignore */ }
  applyTheme();
}

// Derive harmonious secondary/tertiary role hues from one base colour, by small
// analogous hue rotations (keeps saturation/lightness). Used by the builder's
// "Auto" multi-hue button so one pick yields a coordinated three-hue scheme.
export function deriveRoles(base: string): { secondary: string; tertiary: string } {
  const [h, s, l] = hexToHsl(base);
  return {
    secondary: hslToHex((h + 30) % 360, s, l),
    tertiary: hslToHex((h + 60) % 360, s, l),
  };
}

function hexToHsl(hex: string): [number, number, number] {
  let v = hex.replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbOf(hex: string): [number, number, number] {
  let v = hex.replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
function relLum(hex: string): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const l1 = relLum(a); const l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function mixHex(a: string, b: string, fa: number): string {
  const [ar, ag, ab] = rgbOf(a); const [br, bg, bb] = rgbOf(b);
  const to = (x: number, y: number) => Math.round(x * fa + y * (1 - fa)).toString(16).padStart(2, '0');
  return `#${to(ar, br)}${to(ag, bg)}${to(ab, bb)}`;
}

// ── Strong (bold) theme derivation ───────────────────────────────────
// The Strong style makes the surfaces the accent COLOUR itself — a tight tonal
// ramp around it — and picks black or white text from the colour's luminance,
// softening the surface lightness only as much as needed to clear contrast (we
// keep it near the base; we move it only if neither black nor white reads at the
// base's own lightness). Roles collapse to that one colour (bold monochrome):
// buttons invert to a text-coloured block, accent text/links use the on-colour.
// Returns a flat map of the tokens, applied inline; the contrast test imports
// this so it checks the real output. Mode only biases the polarity preference.
const INK = '#121316';
const AA = 4.6; // aim a touch above 4.5 so layered tones keep margin
export type StrongTokens = Record<string, string>;
export function deriveStrong(base: string, dark: boolean, algo: StrongAlgo = 'anchored'): StrongTokens {
  const [h, s0, l0] = hexToHsl(base);
  // Achromatic bases (black / white / grey) have no hue — keep them grey rather
  // than fabricating one. Only coloured bases get the saturation floor that makes
  // Strong read as bold; otherwise #000/#fff would turn into a red/pink theme.
  const s = s0 < 0.06 ? 0 : Math.min(0.85, Math.max(s0, 0.45));
  const surfAt = (l: number) => hslToHex(h, s, Math.min(0.97, Math.max(0.04, l)));
  // The ramp spans SPREAD lightness; the tone CLOSEST to the text colour is the
  // hardest, so anchor on that one. reach() slides the ramp AWAY from the text
  // colour (darker for white text, lighter for ink) from a start lightness until
  // that worst tone clears AA — "soften only as much as needed".
  const SPREAD = 0.12;
  const clampL = (l: number) => Math.min(0.97, Math.max(0.04, l));
  const reach = (text: string, startL: number) => {
    const danger = text === '#ffffff' ? +SPREAD : -SPREAD;
    const step = text === '#ffffff' ? -0.02 : 0.02;
    let l = startL;
    // Walk the whole 0..1 range in the slide direction (clamped for the check), so
    // an extreme base — pure black slides UP toward ink, pure white slides DOWN
    // toward white — actually gets explored. Break only once fully past the range.
    for (let i = 0; i < 70; i += 1) {
      const lc = clampL(l);
      if (contrast(text, surfAt(lc + danger)) >= AA) return { ok: true, l: lc };
      l += step; if (l > 1.05 || l < -0.05) break;
    }
    const lc = clampL(l);
    return { ok: contrast(text, surfAt(lc + danger)) >= AA, l: lc };
  };
  let onSurface: string; let ls: number;
  if (algo === 'invert') {
    // Conventional light/dark, tinted by the hue: day = light surface + ink text,
    // night = dark surface + white text. The base sets only hue/saturation, so
    // #fff and #000 become each other's day/night (both neutral grey).
    onSurface = dark ? '#ffffff' : INK;
    ls = reach(onSurface, dark ? 0.20 : 0.88).l;
  } else {
    // anchored: keep the colour's own lightness; flip only the text, nudging the
    // surface just enough for contrast — the colour's identity stays put.
    const pw = reach('#ffffff', l0); const pi = reach(INK, l0);
    if (dark && pw.ok) { onSurface = '#ffffff'; ls = pw.l; }
    else if (!dark && pi.ok) { onSurface = INK; ls = pi.l; }
    else if (pw.ok) { onSurface = '#ffffff'; ls = pw.l; }
    else if (pi.ok) { onSurface = INK; ls = pi.l; }
    else { const w = contrast('#ffffff', surfAt(l0)) >= contrast(INK, surfAt(l0)); onSurface = w ? '#ffffff' : INK; ls = w ? 0.20 : 0.88; }
  }

  // sgn points TOWARD the text colour; raised tones lean that way, recessed away.
  const sgn = onSurface === '#ffffff' ? +1 : -1;
  const surface = surfAt(ls);
  const bg = surfAt(ls - sgn * 0.05);          // app background, recessed (away from text)
  const container = surfAt(ls + sgn * 0.06);   // raised (hover/active), toward text
  const variant = surfAt(ls + sgn * 0.10);     // the worst tone reach() anchored on
  const onVar = mixHex(onSurface, surface, 0.78); // muted: mostly the on-colour, lightly dimmed
  const outline = mixHex(onSurface, surface, 0.45);
  return {
    '--md-sys-color-surface': surface,
    '--md-sys-color-surface-variant': variant,
    '--md-sys-color-surface-container': container,
    '--md-sys-color-surface-container-low': bg,
    '--md-sys-color-on-surface': onSurface,
    '--md-sys-color-on-surface-variant': onVar,
    '--md-sys-color-outline-variant': outline,
    '--md-sys-color-primary': onSurface,          // buttons invert: a block in the text colour…
    '--md-sys-color-on-primary': surface,         // …labelled in the surface colour
    '--md-sys-color-primary-container': container,
    '--md-sys-color-on-primary-container': onSurface,
    '--md-sys-color-secondary': onSurface,
    '--md-sys-color-secondary-container': variant,
    '--md-sys-color-on-secondary-container': onSurface,
    '--md-sys-color-tertiary': onSurface,
    '--md-sys-color-tertiary-container': container,
    '--md-sys-color-on-tertiary-container': onSurface,
    '--accent-text': onSurface,
    '--link-color': onSurface,
  };
}
// The full set of vars Strong drives inline, so non-Strong styles can clear them.
export const STRONG_KEYS = Object.keys(deriveStrong('#888888', false));

// Resolve a preset/palette accent key to its primary hex (Strong builds from it).
function hexForAccent(key: Accent): string {
  const a = ACCENTS.find((x) => x.key === key); if (a) return a.color;
  const p = PALETTES.find((x) => x.key === key); if (p) return p.colors[0];
  return '#1a73e8';
}
// Is the resolved appearance dark right now (for Strong's polarity bias)?
function isDarkNow(): boolean {
  const m = getThemeMode();
  if (m === 'dark') return true;
  if (m === 'light') return false;
  if (m === 'daynight') return isNightNow();
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}
