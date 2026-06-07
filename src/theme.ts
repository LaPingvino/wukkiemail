// Theme: a light/dark/system mode plus an accent colour. Both are stored in
// localStorage and applied to <html> as data-theme / data-accent attributes,
// which the CSS reads. System mode removes data-theme so the OS preference (the
// prefers-color-scheme media query) wins; light/dark force it regardless of OS.
// The accent only sets a single base hue (--accent-base); the CSS derives
// primary + its container/on-colours from it via color-mix.

export type ThemeMode = 'light' | 'dark' | 'system';
export type Accent = 'teal' | 'blue' | 'indigo' | 'pink' | 'amber' | 'green';

const MODE_KEY = 'wm:theme-mode';
const ACCENT_KEY = 'wm:accent';

export const ACCENTS: { key: Accent; label: string; color: string }[] = [
  { key: 'teal', label: 'Teal', color: '#0d9488' },
  { key: 'blue', label: 'Blue', color: '#1a73e8' },
  { key: 'indigo', label: 'Indigo', color: '#4f46e5' },
  { key: 'pink', label: 'Pink', color: '#d81b60' },
  { key: 'amber', label: 'Amber', color: '#e8710a' },
  { key: 'green', label: 'Green', color: '#16a34a' },
];

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* storage blocked */ }
  return 'system';
}

export function getAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY) as Accent | null;
    if (v && ACCENTS.some((a) => a.key === v)) return v;
  } catch { /* storage blocked */ }
  return 'teal';
}

export function applyTheme(): void {
  const root = document.documentElement;
  const mode = getThemeMode();
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  root.setAttribute('data-accent', getAccent());
}

export function setThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
  applyTheme();
}

export function setAccent(accent: Accent): void {
  try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* ignore */ }
  applyTheme();
}
