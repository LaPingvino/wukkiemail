import { useEffect, useMemo, useState, useCallback } from 'react';
import type { ItemFlavor } from './sources/types';
import { loginWithPassword, saveCreds, clearCreds } from './auth/matrix';
import {
  beginLogin as beginGmailLogin,
  consumeReturnFragment as consumeGmailReturn,
  clearCreds as clearGmailCreds,
} from './auth/gmail';
import { MatrixSource } from './sources/matrix';
import { GmailSource } from './sources/gmail';
import { SetupScreen, gmailIsConfigured } from './Setup';
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
  const [showSetup, setShowSetup] = useState(
    typeof window !== 'undefined' && window.location.pathname === '/setup',
  );
  const gmailConfigured = gmailIsConfigured();

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

  if (showSetup) {
    return <SetupScreen onBack={() => {
      window.history.replaceState({}, '', '/');
      setShowSetup(false);
    }} />;
  }

  if (!anyReady) {
    return (
      <ConnectScreen
        matrix={matrix}
        gmail={gmail}
        gmailConfigured={gmailConfigured}
        onShowSetup={() => setShowSetup(true)}
        onMatrixLogin={onMatrixLogin}
        onGmailLogin={() => {
          if (!gmailConfigured) {
            setShowSetup(true);
            return;
          }
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
  gmailConfigured,
  onShowSetup,
  onMatrixLogin,
  onGmailLogin,
  onCancelMatrix,
  onCancelGmail,
}: {
  matrix: SourceState<MatrixSource>;
  gmail: SourceState<GmailSource>;
  gmailConfigured: boolean;
  onShowSetup: () => void;
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
            <button className="secondary" onClick={onGmailLogin}>
              {gmailConfigured ? 'Connect Gmail' : 'Set up Gmail integration…'}
            </button>
            {!gmailConfigured && (
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
                This instance hasn't configured a Google OAuth client yet.{' '}
                <button
                  onClick={onShowSetup}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0, cursor: 'pointer', font: 'inherit' }}
                >
                  Open setup guide
                </button>.
              </p>
            )}
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

type BundleKey = 'all' | ItemFlavor;

const BUNDLE_LABELS: Record<BundleKey, string> = {
  all: 'Inbox',
  gmail: 'Gmail',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  meta: 'Messenger',
  signal: 'Signal',
  irc: 'IRC',
  issue: 'Issues',
};

const BUNDLE_ORDER: BundleKey[] = [
  'all', 'gmail', 'matrix', 'whatsapp', 'meta', 'signal', 'irc', 'issue',
];

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
  const [bundle, setBundle] = useState<BundleKey>('all');

  const matrixSrc = matrix.kind === 'ready' ? matrix.source : null;
  const gmailSrc = gmail.kind === 'ready' ? gmail.source : null;

  useEffect(() => {
    let cancelled = false;
    const sources = [matrixSrc, gmailSrc].filter((s): s is NonNullable<typeof s> => s !== null);
    if (sources.length === 0) {
      setItems([]); setLoading(false);
      return;
    }
    const refresh = () => {
      Promise.all(sources.map((s) => s.listItems(null).catch(() => [] as InboxItem[]))).then(
        (batches) => {
          if (cancelled) return;
          const merged = batches.flat().sort((a, b) => b.ts - a.ts);
          setItems(merged);
          setLoading(false);
        },
      );
    };
    refresh();
    // Matrix source emits change events as rooms arrive — re-poll on each.
    // Debounced via a rAF batch so a flurry of sync events doesn't thrash.
    let pending = false;
    const onChange = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; refresh(); });
    };
    const unsubMatrix = matrixSrc?.subscribe(onChange);
    return () => { cancelled = true; unsubMatrix?.(); };
  }, [matrixSrc, gmailSrc]);

  // Bundles derive from items — only bundles that have at least one item show up.
  const counts = useMemo(() => {
    const m = new Map<BundleKey, number>();
    m.set('all', items.length);
    for (const it of items) m.set(it.flavor, (m.get(it.flavor) ?? 0) + 1);
    return m;
  }, [items]);

  const visible = useMemo(() => {
    if (bundle === 'all') return items;
    return items.filter((it) => it.flavor === bundle);
  }, [items, bundle]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WukkieMail</h1>
        {BUNDLE_ORDER.map((key) => {
          const count = counts.get(key) ?? 0;
          if (key !== 'all' && count === 0) return null;
          return (
            <div
              key={key}
              className={`bundle ${bundle === key ? 'active' : ''}`}
              onClick={() => setBundle(key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setBundle(key); }}
            >
              <span>
                {key !== 'all' && <span className={`src ${key}`} style={{ display: 'inline-block', width: 8, height: 8, marginRight: 8, borderRadius: 2, verticalAlign: 'middle' }} />}
                {BUNDLE_LABELS[key]}
              </span>
              <span className="count">{count}</span>
            </div>
          );
        })}
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
        ) : visible.length === 0 ? (
          <div className="empty">{bundle === 'all' ? 'No items.' : `No items in ${BUNDLE_LABELS[bundle]}.`}</div>
        ) : (
          <div className="item-list">
            {visible.slice(0, 200).map((it) => (
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
