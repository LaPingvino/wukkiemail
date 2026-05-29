import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './material'; // side-effect: register Material Web custom elements
import './styles.css';

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
    <App />
  </React.StrictMode>,
);

// Register the service worker on idle so it doesn't fight first paint.
// Production-only: dev server uses its own HMR which conflicts with SW.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] sw register failed', e);
    });
  });
}
