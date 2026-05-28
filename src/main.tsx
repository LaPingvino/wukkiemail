import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './material'; // side-effect: register Material Web custom elements
import './styles.css';

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
