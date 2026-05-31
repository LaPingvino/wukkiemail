// Connect a JMAP mail account: a session URL + a bearer/API token. We
// verify by fetching the session resource, then persist and reload so the
// app picks up the new source alongside Matrix.

import { useState } from 'react';
import { JmapSource, saveJmapCreds, type JmapCreds } from './sources/jmap';

export function JmapLoginSheet({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [sessionUrl, setSessionUrl] = useState('');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!sessionUrl.trim() || !token.trim()) return;
    setBusy(true); setError(null);
    const creds: JmapCreds = { sessionUrl: sessionUrl.trim(), bearerToken: token.trim(), email: email.trim() || undefined };
    try {
      // Verify the credentials actually resolve a mail account before saving.
      const src = new JmapSource(creds);
      await src.start();
      saveJmapCreds(creds);
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Connect mail" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Connect mail (JMAP)</div>
        </header>
        <div className="sheet-body">
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
            JMAP is an open email protocol (e.g. Fastmail). Paste your JMAP
            session URL and an API token. Note: Gmail does not support JMAP.
          </p>
          <label className="sheet-label">
            <span>Session URL</span>
            <input type="url" autoFocus value={sessionUrl} onChange={(e) => setSessionUrl(e.target.value)}
              placeholder="https://api.fastmail.com/jmap/session" />
          </label>
          <label className="sheet-label">
            <span>API token</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && sessionUrl && token) void submit(); }}
              placeholder="bearer token" />
          </label>
          <label className="sheet-label">
            <span>Email (optional, for display)</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13, margin: 0 }}>{error}</p>}
          <button type="button" className="sheet-submit" onClick={() => void submit()} disabled={!sessionUrl.trim() || !token.trim() || busy} style={{ justifySelf: 'end' }}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
