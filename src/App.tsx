import { useEffect, useMemo, useState, useCallback } from 'react';
import type { ItemFlavor } from './sources/types';
import { loginWithPassword, saveCreds, clearCreds } from './auth/matrix';
import { MatrixSource } from './sources/matrix';
import { IssuePanel } from './IssuePanel';
import type { InboxItem } from './sources/types';

// Per-source state. Matrix-only for now; the multi-source design stays
// so an adapter for JMAP (or a mautrix-imap-style email bridge) can
// drop in later.
type SourceState =
  | { kind: 'none' }
  | { kind: 'connecting' }
  | { kind: 'syncing'; source: MatrixSource }
  | { kind: 'ready'; source: MatrixSource }
  | { kind: 'error'; error: string };

export function App() {
  const [matrix, setMatrix] = useState<SourceState>({ kind: 'none' });

  // Restore on boot.
  useEffect(() => {
    const m = MatrixSource.tryRestore();
    if (m) {
      setMatrix({ kind: 'syncing', source: m });
      m.start().then(
        () => setMatrix({ kind: 'ready', source: m }),
        (e: Error) => setMatrix({ kind: 'error', error: e.message }),
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

  const onSignOut = useCallback(() => {
    if (matrix.kind === 'syncing' || matrix.kind === 'ready') {
      void matrix.source.stop();
    }
    clearCreds();
    setMatrix({ kind: 'none' });
  }, [matrix]);

  // Show the inbox shell as soon as the source is created, so the user
  // sees progress even mid-sync.
  if (matrix.kind === 'ready' || matrix.kind === 'syncing') {
    return <Inbox matrix={matrix} onSignOut={onSignOut} />;
  }
  return <ConnectScreen matrix={matrix} onMatrixLogin={onMatrixLogin} onCancel={onSignOut} />;
}

function ConnectScreen({
  matrix,
  onMatrixLogin,
  onCancel,
}: {
  matrix: SourceState;
  onMatrixLogin: (mxid: string, password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [mxid, setMxid] = useState('');
  const [pw, setPw] = useState('');

  return (
    <div className="connect">
      <h2>WukkieMail</h2>
      <p style={{ color: 'var(--muted)', margin: 0 }}>
        A Matrix-first triage inbox. Bridge networks (WhatsApp, Signal, IRC,
        Messenger) appear as their own bundles. Issues from rooms with an
        eu.kiefte.issues schema get a side panel.
      </p>

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
              {matrix.kind === 'connecting' ? 'Signing in…' : 'Starting sync…'}
            </p>
            <md-outlined-button onClick={onCancel}>Cancel</md-outlined-button>
          </div>
        )}
      </section>

      <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0 }}>
        Mail support (JMAP and/or a Matrix email bridge) is on the roadmap.
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
  gmail: 'Mail',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  meta: 'Messenger',
  signal: 'Signal',
  irc: 'IRC',
  issue: 'Issues',
};

const BUNDLE_ORDER: BundleKey[] = [
  'all', 'matrix', 'whatsapp', 'meta', 'signal', 'irc', 'issue', 'gmail',
];

function Inbox({
  matrix,
  onSignOut,
}: {
  matrix: SourceState;
  onSignOut: () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<BundleKey>('all');
  const [query, setQuery] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<{ roomId: string; issueId: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const matrixSrc = matrix.kind === 'syncing' || matrix.kind === 'ready' ? matrix.source : null;

  useEffect(() => {
    let cancelled = false;
    if (!matrixSrc) {
      setItems([]); setLoading(false);
      return;
    }
    const refresh = () => {
      matrixSrc.listItems(null).then(
        (batch) => {
          if (cancelled) return;
          setItems(batch.slice().sort((a, b) => b.ts - a.ts));
          setLoading(false);
        },
        (e) => {
          // eslint-disable-next-line no-console
          console.warn('[wukkiemail] matrix listItems failed', e);
          if (!cancelled) setLoading(false);
        },
      );
    };
    refresh();
    let pending = false;
    const onChange = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; refresh(); });
    };
    const unsub = matrixSrc.subscribe(onChange);
    // Belt-and-suspenders: poll every 3s for 60s so any missed event still
    // pulls in items.
    const startedAt = Date.now();
    const poller = setInterval(() => {
      if (cancelled || Date.now() - startedAt > 60_000) {
        clearInterval(poller);
        return;
      }
      refresh();
    }, 3_000);
    return () => { cancelled = true; unsub(); clearInterval(poller); };
  }, [matrixSrc]);

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

  useEffect(() => { setCursor(0); }, [bundle, query]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) {
        if (e.key === 'Escape') (t as HTMLInputElement).blur();
        return;
      }
      const ae = document.activeElement;
      if (ae?.tagName?.toLowerCase().includes('text-field')) return;

      if (e.key === '/') {
        e.preventDefault();
        const field = document.querySelector('.toolbar md-outlined-text-field') as HTMLElement | null;
        field?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (selectedIssue) { setSelectedIssue(null); return; }
        if (query) { setQuery(''); return; }
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, visible.length - 1));
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        const it = visible[cursor];
        if (!it) return;
        if (it.flavor === 'issue') {
          const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
          if (m) { setSelectedIssue({ roomId: m[1], issueId: m[2] }); e.preventDefault(); }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, cursor, query, selectedIssue]);

  useEffect(() => {
    const el = document.querySelector(`.item[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <aside className="sidebar">
        <h1>WukkieMail</h1>
        <div className="accounts">
          {matrixSrc && <AccountChip flavor="matrix" label={matrixSrc.id} />}
        </div>
        {BUNDLE_ORDER.map((key) => {
          const total = counts.total.get(key) ?? 0;
          const unread = counts.unread.get(key) ?? 0;
          if (key !== 'all' && total === 0) return null;
          return (
            <div
              key={key}
              className={`bundle ${bundle === key ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
              onClick={() => { setBundle(key); setSidebarOpen(false); }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setBundle(key); setSidebarOpen(false); } }}
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
        <SourceStatus
          label="Matrix"
          loading={matrix.kind === 'connecting' || matrix.kind === 'syncing'}
          error={matrix.kind === 'error' ? matrix.error : null}
        />
        <button
          onClick={onSignOut}
          style={{
            marginTop: 24, width: '100%', padding: '8px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 8, color: 'var(--muted)',
          }}
        >
          Sign out
        </button>
      </aside>
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      <main className="main">
        <div className="toolbar">
          <md-icon-button
            className="hamburger"
            aria-label="Menu"
            onClick={() => setSidebarOpen((o) => !o)}
          >
            <md-icon>menu</md-icon>
          </md-icon-button>
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
          <div className="empty">
            <p>{bundle === 'all' ? 'No items yet.' : `No items in ${BUNDLE_LABELS[bundle]}.`}</p>
            {matrixSrc && (
              <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
                Matrix: sync={String(matrixSrc.describe().state)},
                rooms={matrixSrc.describe().rooms},
                spaces={matrixSrc.describe().spaces}
              </p>
            )}
          </div>
        ) : (
          <div className="item-list">
            {visible.slice(0, 200).map((it, i) => (
              <a
                key={it.id}
                data-idx={i}
                className={`item ${i === cursor ? 'cursor' : ''} ${it.unread ? 'unread' : ''}`}
                href={it.openPath}
                onClick={(e) => {
                  if (it.flavor === 'issue') {
                    e.preventDefault();
                    const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
                    if (m) setSelectedIssue({ roomId: m[1], issueId: m[2] });
                  } else {
                    // Matrix items: prevent navigation until we have a real
                    // detail view. For now, no-op.
                    e.preventDefault();
                  }
                }}
                style={{ color: 'inherit', textDecoration: 'none' }}
              >
                <Avatar name={it.from} flavor={it.flavor} />
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
      <BottomNav bundle={bundle} setBundle={setBundle} counts={counts} />
    </div>
  );
}

function BottomNav({
  bundle,
  setBundle,
  counts,
}: {
  bundle: BundleKey;
  setBundle: (k: BundleKey) => void;
  counts: { total: Map<BundleKey, number>; unread: Map<BundleKey, number> };
}) {
  const populated = BUNDLE_ORDER
    .filter((k) => k === 'all' || (counts.total.get(k) ?? 0) > 0)
    .slice(0, 5);
  return (
    <nav className="bottom-nav" aria-label="Inbox bundles">
      {populated.map((key) => {
        const unread = counts.unread.get(key) ?? 0;
        return (
          <button
            key={key}
            className={`tab ${bundle === key ? 'active' : ''}`}
            onClick={() => setBundle(key)}
            aria-label={BUNDLE_LABELS[key]}
            aria-current={bundle === key ? 'page' : undefined}
          >
            <span className={`src ${key === 'all' ? '' : key}`} />
            {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
            <span>{BUNDLE_LABELS[key]}</span>
          </button>
        );
      })}
    </nav>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  const cleaned = name.replace(/^@/, '').replace(/<[^>]+>/g, '').trim();
  const parts = cleaned.split(/[\s_:.-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Avatar({ name, flavor }: { name: string; flavor: string }) {
  const hue = hashHue(name);
  return (
    <div className="avatar" style={{ background: `hsl(${hue} 55% 50%)` }}>
      <span>{initials(name)}</span>
      <span className={`avatar-badge ${flavor}`} title={flavor} />
    </div>
  );
}

function AccountChip({ flavor, label }: { flavor: 'matrix'; label: string }) {
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
