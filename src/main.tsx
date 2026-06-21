import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { applyTheme, startThemeWatcher } from './theme';
import './material'; // side-effect: register Material Web custom elements
import './styles.css';

// Apply the saved theme/accent before first paint to avoid a flash, and keep
// day/night mode flipping around sunrise/sunset.
applyTheme();
startThemeWatcher();

// Ask the browser to keep our storage durable BEFORE we open any IndexedDB
// (matrix sync store + Rust crypto store). Without a persistence grant the
// browser treats storage as best-effort: it can evict it under pressure —
// which is why crypto/keys didn't survive a refresh — and on some setups the
// best-effort mode is also what surfaces as "Query failed: UnknownError".
// persist() is idempotent and safe to call eagerly; the grant is heuristic
// (Chrome auto-grants on engagement/installed PWA; Firefox may prompt).
async function requestPersistentStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted()) {
      // eslint-disable-next-line no-console
      console.info('[wukkiemail] storage already persistent');
      return;
    }
    const granted = await navigator.storage.persist();
    // eslint-disable-next-line no-console
    console.info(`[wukkiemail] persistent storage ${granted ? 'granted' : 'denied'}`);
    // Quota pressure is a common cause of IndexedDB "UnknownError"/eviction
    // (per matrix-js-sdk storage notes) — surface it for diagnosis.
    if (navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (typeof usage === 'number' && typeof quota === 'number') {
        // eslint-disable-next-line no-console
        console.info(`[wukkiemail] storage ~${Math.round(usage / 1e6)}MB used of ~${Math.round(quota / 1e6)}MB (${Math.round((usage / quota) * 100)}%)`);
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[wukkiemail] storage.persist() failed', e);
  }
}
void requestPersistentStorage();

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Tell the boot watchdog (inline in index.html) that React mounted successfully,
// so it clears its one-shot retry flag and a future failed boot can self-heal
// again. Done on the next frame, after the first paint commits into #root.
requestAnimationFrame(() => {
  try {
    sessionStorage.removeItem('wm:boot-retry');
  } catch {
    /* sessionStorage unavailable (private mode / disabled) — non-fatal */
  }
  // The prepaint set an inline background on <html>/<body> to kill the white flash;
  // clear it now so the app's themed CSS background takes over (and doesn't go stale
  // when the user changes theme). The bundled CSS is already applied, so no flash.
  try {
    document.documentElement.style.removeProperty('background');
    document.body.style.removeProperty('background');
  } catch {
    /* non-fatal */
  }
  persistPrepaintColors();
});

// Persist the theme's RESOLVED colours so the next reload's prepaint (inline in
// index.html, before the bundle loads) can paint with the exact palette — no need
// to duplicate the theme algorithm there. We read the computed values of the app's
// design-token vars via a probe element (custom properties don't resolve through
// getComputedStyle directly, but a real style that USES them does). Runs after the
// first paint, so styles.css (bundled) is applied. Best-effort.
function persistPrepaintColors(): void {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;';
    document.body.appendChild(probe);
    const read = (cssVar: string): string => {
      probe.style.backgroundColor = `var(${cssVar})`;
      return getComputedStyle(probe).backgroundColor || '';
    };
    const colors = {
      bg: read('--bg'),
      fg: read('--fg'),
      card: read('--card'),
      muted: read('--muted'),
      accent: read('--accent'),
      border: read('--border'),
    };
    document.body.removeChild(probe);
    if (colors.bg) localStorage.setItem('wm:prepaint-theme', JSON.stringify(colors));
  } catch {
    /* probe/localStorage unavailable — prepaint falls back to mode defaults */
  }
}

// Register the service worker on idle so it doesn't fight first paint.
// Production-only: dev server uses its own HMR which conflicts with SW.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // If a controller already governs this load, a later controllerchange means a
  // NEW version just activated — reload once to pick it up. This is the fix for
  // "I had to hard-refresh on mobile to get the update". On the very first
  // install there's no prior controller, so we don't reload under the user.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Nudge mobile browsers that otherwise sit on a cached worker to check
      // for an updated sw.js on each load.
      reg.update().catch(() => {});
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] sw register failed', e);
    });
  });
}
