import { useEffect, useState, useCallback } from 'react';
import { loginWithPassword, saveCreds, clearCreds } from './auth/matrix';
import {
  beginLogin as beginGmailLogin,
  consumeReturnFragment as consumeGmailReturn,
  clearCreds as clearGmailCreds,
} from './auth/gmail';
import { MatrixSource } from './sources/matrix';
import { GmailSource } from './sources/gmail';
import type { InboxItem } from './sources/types';

// Per-source state. Both progress independently so the user can add
// the other side mid-flight, cancel one without affecting the other,
// and triage what's loaded so far.
type SourceState<S> =
  | { kind: 'none' }
  | { kind: 'connecting' }
  | { kind: 'syncing'; source: S }
  | { kind: 'ready'; source: S }
  | { kind: 'error'; error: string };

export function App() {
  const [matrix, setMatrix] = useState<SourceState<MatrixSource>>({ kind: 'none' });
  const [gmail, setGmail] = useState<SourceState<GmailSource>>({ kind: 'none' });

  // Restore on boot.
  useEffect(() => {
    if (consumeGmailReturn()) window.history.replaceState({}, '', '/');

    const m = MatrixSource.tryRestore();
    if (m) {
      setMatrix({ kind: 'syncing', source: m });
      m.start().then(
        () => setMatrix({ kind: 'ready', source: m }),
        (e: Error) => setMatrix({ kind: 'error', error: e.message }),
      );
    }
    const g = GmailSource.tryRestore();
    if (g) {
      setGmail({ kind: 'syncing', source: g });
      g.start().then(
        () => setGmail({ kind: 'ready', source: g }),
        (e: Error) => setGmail({ kind: 'error', error: e.message }),
      );
    }
  }, []);

  const onMatrixLogin = useCallback(async (mxid: string, password: string) => {
    setMatrix({ kind: 'connecting' });
    try {
      const creds = await loginWithPassword(mxid, password);
      saveCreds(creds);
      const src = new MatrixSource(creds);
      setMatrix({ kind: 'syncing', source: src });
      await src.start();
      setMatrix({ kind: 'ready', source: src });
    } catch (e) {
      setMatrix({ kind: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const onCancelMatrix = useCallback(() => {
    if (matrix.kind === 'syncing' || matrix.kind === 'ready') {
      void matrix.source.stop();
    }
    clearCreds();
    setMatrix({ kind: 'none' });
  }, [matrix]);

  const onCancelGmail = useCallback(() => {
    clearGmailCreds();
    setGmail({ kind: 'none' });
  }, []);

  // The inbox shows as soon as at least one source has data (or is past
  // its initial sync). Before that we show the connect screen, which is
  // always interactive — both buttons available regardless of the other
  // side's state.
  const anyReady = matrix.kind === 'ready' || gmail.kind === 'ready';

  if (!anyReady) {
    return (
      <ConnectScreen
        matrix={matrix}
        gmail={gmail}
        onMatrixLogin={onMatrixLogin}
        onGmailLogin={() => {
          try { beginGmailLogin(); }
          catch (e) { setGmail({ kind: 'error', error: e instanceof Error ? e.message : String(e) }); }
        }}
        onCancelMatrix={onCancelMatrix}
        onCancelGmail={onCancelGmail}
      />
    );
  }

  return (
    <Inbox
      matrix={matrix}
      gmail={gmail}
      onGmailLogin={() => {
        try { beginGmailLogin(); }
        catch (e) { setGmail({ kind: 'error', error: e instanceof Error ? e.message : String(e) }); }
      }}
      onSignOutAll={() => {
        onCancelMatrix();
        onCancelGmail();
      }}
    />
  );
}

function ConnectScreen({
  matrix,
  gmail,
  onMatrixLogin,
  onGmailLogin,
  onCancelMatrix,
  onCancelGmail,
}: {
  matrix: SourceState<MatrixSource>;
  gmail: SourceState<GmailSource>;
  onMatrixLogin: (mxid: string, password: string) => Promise<void>;
  onGmailLogin: () => void;
  onCancelMatrix: () => void;
  onCancelGmail: () => void;
}) {
  const [mxid, setMxid] = useState('');
  const [pw, setPw] = useState('');

  return (
    <div className="connect">
      <h2>WukkieMail</h2>
      <p style={{ color: 'var(--muted)', margin: 0 }}>
        Connect Gmail, Matrix, or both — features adapt to what you add.
      </p>

      {/* Matrix block */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Matrix</legend>
        {matrix.kind === 'none' || matrix.kind === 'error' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (mxid && pw) void onMatrixLogin(mxid, pw);
            }}
            style={{ display: 'grid', gap: 8 }}
          >
            <input
              type="text"
              placeholder="@you:matrix.org"
              value={mxid}
              onChange={(e) => setMxid(e.target.value)}
              autoComplete="username"
              style={inputStyle}
            />
            <input
              type="password"
              placeholder="Password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="current-password"
              style={inputStyle}
            />
            <button type="submit">Connect Matrix</button>
            {matrix.kind === 'error' && (
              <p style={errStyle}>{matrix.error}</p>
            )}
          </form>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <p style={{ margin: 0, color: 'var(--muted)' }}>
              {matrix.kind === 'connecting' ? 'Signing in…' : 'Syncing rooms…'}
            </p>
            <button className="secondary" onClick={onCancelMatrix}>Cancel</button>
          </div>
        )}
      </fieldset>

      {/* Gmail block */}
      <fieldset style={fieldsetStyle}>
        <legend style={legendStyle}>Gmail</legend>
        {gmail.kind === 'none' || gmail.kind === 'error' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <button className="secondary" onClick={onGmailLogin}>Connect Gmail</button>
            {gmail.kind === 'error' && <p style={errStyle}>{gmail.error}</p>}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <p style={{ margin: 0, color: 'var(--muted)' }}>
              {gmail.kind === 'connecting' ? 'Redirecting…' : 'Loading threads…'}
            </p>
            <button className="secondary" onClick={onCancelGmail}>Cancel</button>
          </div>
        )}
      </fieldset>

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
        Gmail uses the metadata scope only — clicking a thread opens it in mail.google.com for the body.
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg)',
  color: 'var(--fg)',
  font: 'inherit',
};

const fieldsetStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '12px 14px',
  display: 'grid',
  gap: 8,
};

const legendStyle: React.CSSProperties = {
  padding: '0 6px',
  fontSize: 13,
  color: 'var(--muted)',
};

const errStyle: React.CSSProperties = { color: '#e57373', margin: 0, fontSize: 13 };

function Inbox({
  matrix,
  gmail,
  onGmailLogin,
  onSignOutAll,
}: {
  matrix: SourceState<MatrixSource>;
  gmail: SourceState<GmailSource>;
  onGmailLogin: () => void;
  onSignOutAll: () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  const matrixSrc = matrix.kind === 'ready' ? matrix.source : null;
  const gmailSrc = gmail.kind === 'ready' ? gmail.source : null;

  useEffect(() => {
    let cancelled = false;
    const sources = [matrixSrc, gmailSrc].filter((s): s is NonNullable<typeof s> => s !== null);
    if (sources.length === 0) {
      setItems([]); setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(sources.map((s) => s.listItems(null).catch(() => [] as InboxItem[]))).then(
      (batches) => {
        if (cancelled) return;
        const merged = batches.flat().sort((a, b) => b.ts - a.ts);
        setItems(merged);
        setLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [matrixSrc, gmailSrc]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WukkieMail</h1>
        <div className="bundle active">
          <span>Inbox</span>
          <span className="count">{items.length}</span>
        </div>
        {gmail.kind === 'none' && (
          <button
            onClick={onGmailLogin}
            style={{
              marginTop: 16, width: '100%', padding: '8px',
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--fg)',
            }}
          >
            + Connect Gmail
          </button>
        )}
        {gmail.kind === 'syncing' && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 16 }}>Gmail loading…</p>
        )}
        {gmail.kind === 'error' && (
          <p style={{ color: '#e57373', fontSize: 12, marginTop: 16 }}>Gmail: {gmail.error}</p>
        )}
        {matrix.kind === 'syncing' && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>Matrix syncing…</p>
        )}
        {matrix.kind === 'error' && (
          <p style={{ color: '#e57373', fontSize: 12, marginTop: 8 }}>Matrix: {matrix.error}</p>
        )}
        <button
          onClick={onSignOutAll}
          style={{
            marginTop: 24, width: '100%', padding: '8px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 8, color: 'var(--muted)',
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="main">
        {loading ? (
          <div className="empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="empty">No items.</div>
        ) : (
          <div className="item-list">
            {items.slice(0, 200).map((it) => (
              <a
                key={it.id}
                className="item"
                href={it.openPath}
                target={it.flavor === 'gmail' ? '_blank' : '_self'}
                rel={it.flavor === 'gmail' ? 'noopener noreferrer' : undefined}
                style={{ color: 'inherit', textDecoration: 'none' }}
              >
                <div className={`src ${it.flavor}`} />
                <div className="from">{it.from}</div>
                <div className="subj">
                  <strong>{it.subject}</strong> — {it.snippet}
                </div>
                <div className="ts">{formatTs(it.ts)}</div>
              </a>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
