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
import { IssuePanel } from './IssuePanel';
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
      <section style={sectionStyle}>
        <div style={sectionHead}>Matrix</div>
        {matrix.kind === 'none' || matrix.kind === 'error' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (mxid && pw) void onMatrixLogin(mxid, pw);
            }}
            style={{ display: 'grid', gap: 12 }}
          >
            <md-outlined-text-field
              label="Matrix ID"
              placeholder="@you:matrix.org"
              value={mxid}
              autocomplete="username"
              ref={fieldRef((v) => setMxid(v))}
            />
            <md-outlined-text-field
              label="Password"
              type="password"
              value={pw}
              autocomplete="current-password"
              ref={fieldRef((v) => setPw(v))}
            />
            <md-filled-button type="submit">Connect Matrix</md-filled-button>
            {matrix.kind === 'error' && <p style={errStyle}>{matrix.error}</p>}
          </form>
        ) : (
          <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
            <md-circular-progress indeterminate aria-label="Signing in" />
            <p style={{ margin: 0, color: 'var(--muted)' }}>
              {matrix.kind === 'connecting' ? 'Signing in…' : 'Syncing rooms…'}
            </p>
            <md-outlined-button onClick={onCancelMatrix}>Cancel</md-outlined-button>
          </div>
        )}
      </section>

      {/* Gmail block */}
      <section style={sectionStyle}>
        <div style={sectionHead}>Gmail</div>
        {gmail.kind === 'none' || gmail.kind === 'error' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <md-outlined-button onClick={onGmailLogin}>
              {gmailConfigured ? 'Connect Gmail' : 'Set up Gmail integration…'}
            </md-outlined-button>
            {!gmailConfigured && (
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
                This instance hasn't configured a Google OAuth client yet.{' '}
                <md-text-button onClick={onShowSetup}>Open setup guide</md-text-button>
              </p>
            )}
            {gmail.kind === 'error' && <p style={errStyle}>{gmail.error}</p>}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
            <md-circular-progress indeterminate aria-label="Connecting Gmail" />
            <p style={{ margin: 0, color: 'var(--muted)' }}>
              {gmail.kind === 'connecting' ? 'Redirecting…' : 'Loading threads…'}
            </p>
            <md-outlined-button onClick={onCancelGmail}>Cancel</md-outlined-button>
          </div>
        )}
      </section>

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
        Gmail uses the metadata scope only — clicking a thread opens it in mail.google.com for the body.
      </p>
    </div>
  );
}

// Wires a Material text field's input event to React state. Material Web
// components emit native 'input' events but expose .value as a property,
// so a ref-attached listener is the simplest bridge.
function fieldRef(setter: (v: string) => void) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    const handler = (ev: Event) => {
      setter((ev.target as HTMLInputElement & { value: string }).value);
    };
    el.addEventListener('input', handler);
  };
}

const sectionStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '16px 20px',
  display: 'grid',
  gap: 12,
};

const sectionHead: React.CSSProperties = {
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--muted)',
};

const errStyle: React.CSSProperties = { color: 'var(--md-sys-color-error)', margin: 0, fontSize: 13 };

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
  const [query, setQuery] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<{ roomId: string; issueId: string } | null>(null);

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
    const unsubGmail = gmailSrc?.subscribe(onChange);
    return () => { cancelled = true; unsubMatrix?.(); unsubGmail?.(); };
  }, [matrixSrc, gmailSrc]);

  // Bundles derive from items — only bundles that have at least one item show up.
  // Track total + unread separately so the bundle pill can show a bold
  // unread count when there's any, and a quieter total alongside.
  const counts = useMemo(() => {
    const total = new Map<BundleKey, number>();
    const unread = new Map<BundleKey, number>();
    const bump = (m: Map<BundleKey, number>, k: BundleKey) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const it of items) {
      bump(total, 'all');
      bump(total, it.flavor);
      if (it.unread) {
        bump(unread, 'all');
        bump(unread, it.flavor);
      }
    }
    return { total, unread };
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (bundle !== 'all' && it.flavor !== bundle) return false;
      if (!q) return true;
      return (
        it.subject.toLowerCase().includes(q) ||
        it.from.toLowerCase().includes(q) ||
        it.snippet.toLowerCase().includes(q) ||
        (it.fromAddress?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [items, bundle, query]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WukkieMail</h1>
        <div className="accounts">
          {matrixSrc && <AccountChip flavor="matrix" label={matrixSrc.id} />}
          {gmailSrc && <AccountChip flavor="gmail" label={gmailSrc.id.replace(/^gmail:/, '')} />}
        </div>
        {BUNDLE_ORDER.map((key) => {
          const total = counts.total.get(key) ?? 0;
          const unread = counts.unread.get(key) ?? 0;
          if (key !== 'all' && total === 0) return null;
          return (
            <div
              key={key}
              className={`bundle ${bundle === key ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
              onClick={() => setBundle(key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setBundle(key); }}
            >
              <span>
                {key !== 'all' && <span className={`src ${key}`} style={{ display: 'inline-block', width: 8, height: 8, marginRight: 8, borderRadius: 2, verticalAlign: 'middle' }} />}
                {BUNDLE_LABELS[key]}
              </span>
              <span className="count">
                {unread > 0 ? <strong>{unread}</strong> : null}
                {unread > 0 && total > unread && <span style={{ opacity: 0.5 }}> / {total}</span>}
                {unread === 0 && total}
              </span>
            </div>
          );
        })}
        {gmail.kind === 'none' && (
          <md-outlined-button
            onClick={onGmailLogin}
            style={{ marginTop: 16, width: '100%' }}
          >
            + Connect Gmail
          </md-outlined-button>
        )}
        <SourceStatus
          label="Matrix"
          loading={matrix.kind === 'connecting' || matrix.kind === 'syncing'}
          error={matrix.kind === 'error' ? matrix.error : null}
        />
        <SourceStatus
          label="Gmail"
          loading={gmail.kind === 'syncing' || (gmailSrc?.getStatus() === 'syncing')}
          error={gmail.kind === 'error' ? gmail.error : null}
        />
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
        <div className="toolbar">
          <md-outlined-text-field
            label="Search"
            placeholder="Filter inbox…"
            value={query}
            ref={fieldRef((v) => setQuery(v))}
            style={{ width: '100%', maxWidth: 600 }}
          />
          {query && (
            <md-text-button onClick={() => setQuery('')}>Clear</md-text-button>
          )}
        </div>
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
                onClick={(e) => {
                  // Issue items: intercept and open the inline panel
                  // instead of letting the link navigate into the SPA.
                  if (it.flavor === 'issue') {
                    e.preventDefault();
                    const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
                    if (m) setSelectedIssue({ roomId: m[1], issueId: m[2] });
                  }
                }}
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
      {selectedIssue && matrixSrc && (
        <IssuePanel
          matrix={matrixSrc}
          roomId={selectedIssue.roomId}
          issueId={selectedIssue.issueId}
          onClose={() => setSelectedIssue(null)}
        />
      )}
    </div>
  );
}

function AccountChip({ flavor, label }: { flavor: 'matrix' | 'gmail'; label: string }) {
  return (
    <div className="account-chip" title={label}>
      <span className={`src ${flavor}`} style={{ width: 8, height: 8, borderRadius: 50 }} />
      <span className="account-label">{label}</span>
    </div>
  );
}

function SourceStatus({ label, loading, error }: { label: string; loading: boolean; error: string | null }) {
  if (error) return <p style={{ color: 'var(--md-sys-color-error)', fontSize: 12, marginTop: 8 }}>{label}: {error}</p>;
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>
      <md-circular-progress indeterminate aria-label={`${label} syncing`} style={{ width: 14, height: 14 }} />
      <span>{label} syncing…</span>
    </div>
  );
  return null;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
