// Theme: a light/dark/system mode, plus two orthogonal colour axes —
//   • accent (--accent-base / role hues), and
//   • style (data-style): how much that accent washes into surfaces.
// All stored in localStorage and applied to <html> as data-theme / data-accent /
// data-style attributes the CSS reads. System mode removes data-theme so the OS
// preference (the prefers-color-scheme media query) wins; light/dark force it.
// The picker presents accent×style as a handful of "approach groups" (Classic,
// Tinted, Inbox, Palettes) — see THEME_GROUPS below.

export type ThemeMode = 'light' | 'dark' | 'system' | 'daynight';
export type Accent =
  | 'teal' | 'blue' | 'indigo' | 'pink' | 'amber' | 'green'
  | 'ocean' | 'sunset' | 'forest' | 'plum' | 'slate'
  | 'custom'; // user-built theme — colours come from CUSTOM_KEY, applied inline

// A hand-built theme: a base hue plus optional secondary/tertiary role hues.
// When only `base` is set, secondary/tertiary derive from it (monochrome); set
// them for a multi-hue custom scheme. Stored as JSON under CUSTOM_KEY.
export interface CustomTheme { base: string; secondary?: string; tertiary?: string }
// How strongly the accent tints the surfaces: classic = none (white/grey),
// tinted = the accent washes through, inbox = white content under a bold accent
// app bar. Drives the data-style attribute.
export type ThemeStyle = 'classic' | 'tinted' | 'inbox';

const MODE_KEY = 'wm:theme-mode';
const ACCENT_KEY = 'wm:accent';
const STYLE_KEY = 'wm:theme-style';
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
}

export const ACCENTS: { key: Accent; label: string; color: string }[] = [
  { key: 'teal', label: 'Teal', color: '#0d9488' },
  { key: 'blue', label: 'Blue', color: '#1a73e8' },
  { key: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { key: 'pink', label: 'Pink', color: '#d81b60' },
  { key: 'amber', label: 'Amber', color: '#e8710a' },
  { key: 'green', label: 'Green', color: '#16a34a' },
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
  { id: 'inbox', label: 'Inbox', hint: 'White content under a bold colour bar', style: 'inbox', swatches: ACCENT_SWATCHES },
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
    if (v === 'classic' || v === 'tinted' || v === 'inbox') return v;
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
        };
      }
    }
  } catch { /* storage blocked / bad json */ }
  return DEFAULT_CUSTOM;
}

export function applyTheme(): void {
  const root = document.documentElement;
  const mode = getThemeMode();
  if (mode === 'system') root.removeAttribute('data-theme');
  else if (mode === 'daynight') root.setAttribute('data-theme', isNightNow() ? 'dark' : 'light');
  else root.setAttribute('data-theme', mode);
  const accent = getAccent();
  root.setAttribute('data-accent', accent);
  root.setAttribute('data-style', getStyle());
  // Custom themes drive the role base vars inline (the presets do it via CSS
  // rules keyed on data-accent). Clear the inline vars for presets so their CSS
  // wins; for custom, an absent secondary/tertiary falls back to --accent-base
  // in :root, i.e. a monochrome scheme derived from the one base colour.
  if (accent === 'custom') {
    const c = getCustom();
    root.style.setProperty('--accent-base', c.base);
    if (c.secondary) root.style.setProperty('--secondary-base', c.secondary);
    else root.style.removeProperty('--secondary-base');
    if (c.tertiary) root.style.setProperty('--tertiary-base', c.tertiary);
    else root.style.removeProperty('--tertiary-base');
  } else {
    root.style.removeProperty('--accent-base');
    root.style.removeProperty('--secondary-base');
    root.style.removeProperty('--tertiary-base');
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
