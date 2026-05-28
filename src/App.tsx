import { useEffect, useMemo, useState, useCallback } from 'react';
import type { BundleSpec, ItemFlavor } from './sources/types';
import type { SavedView } from './sources/matrix';
import { loginWithPassword, saveCreds, clearCreds } from './auth/matrix';
import { MatrixSource } from './sources/matrix';
import { IssuePanel } from './IssuePanel';
import { RoomPanel } from './RoomPanel';
import { NewTaskSheet } from './NewTaskSheet';
import { SettingsSheet } from './SettingsSheet';
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

  // Restore on boot. Flip to 'ready' optimistically as soon as the
  // MatrixSource exists so the inbox shell renders instantly on reload.
  // The Inbox effect listens for change events from the source, so as
  // rooms hydrate from IndexedDB and the delta /sync lands they appear
  // without a separate transition.
  useEffect(() => {
    const m = MatrixSource.tryRestore();
    if (m) {
      setMatrix({ kind: 'ready', source: m });
      m.start().catch((e: Error) => setMatrix({ kind: 'error', error: e.message }));
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

// Bundles are now keyed by string. Standard keys: 'all', 'dm',
// 'flavor:<flavor>', 'space:<roomId>'. Source-provided space bundles
// arrive via matrixSrc.listBundles().
type BundleKey = string;

const FLAVOR_LABELS: Record<ItemFlavor, string> = {
  gmail: 'Mail',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  meta: 'Messenger',
  signal: 'Signal',
  irc: 'IRC',
  issue: 'Issues',
};

const FLAVOR_ORDER: ItemFlavor[] = ['matrix', 'whatsapp', 'meta', 'signal', 'irc', 'issue', 'gmail'];

function flavorBundleKey(f: ItemFlavor): BundleKey { return `flavor:${f}`; }

function bundleLabel(key: BundleKey, spaceBundles: BundleSpec[]): string {
  if (key === 'all') return 'Inbox';
  if (key === 'dm') return 'DMs';
  if (key.startsWith('flavor:')) {
    const f = key.slice(7) as ItemFlavor;
    return FLAVOR_LABELS[f] ?? f;
  }
  if (key.startsWith('space:')) {
    return spaceBundles.find((b) => b.id === key)?.label ?? 'Space';
  }
  return key;
}


function Inbox({
  matrix,
  onSignOut,
}: {
  matrix: SourceState;
  onSignOut: () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [spaceBundles, setSpaceBundles] = useState<BundleSpec[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<BundleKey>('all');
  const [query, setQuery] = useState('');
  const [selectedIssue, setSelectedIssue] = useState<{ roomId: string; issueId: string } | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showRead, setShowRead] = useState(false);
  const [snoozePopoverFor, setSnoozePopoverFor] = useState<string | null>(null);
  const [actionSheetFor, setActionSheetFor] = useState<string | null>(null);
  const [issueStatusFilter, setIssueStatusFilter] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  // Refresh ticker: bumped every 60s so snoozed items re-evaluate
  // around their due time without an explicit per-snooze timer.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRefreshTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

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
          // Sort by priority desc, then ts desc — important first, ties
          // broken by recency. Read items still appear in their natural
          // position; the showRead filter below hides them by default.
          setItems(batch.slice().sort((a, b) => (b.priority - a.priority) || (b.ts - a.ts)));
          setLoading(false);
        },
        (e) => {
          // eslint-disable-next-line no-console
          console.warn('[wukkiemail] matrix listItems failed', e);
          if (!cancelled) setLoading(false);
        },
      );
      matrixSrc.listBundles().then((bs) => { if (!cancelled) setSpaceBundles(bs); });
      if (!cancelled) setSavedViews(matrixSrc.getSavedViews());
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
  }, [matrixSrc, refreshTick]);

  const counts = useMemo(() => {
    const total = new Map<BundleKey, number>();
    const unread = new Map<BundleKey, number>();
    const bump = (m: Map<BundleKey, number>, k: BundleKey) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const it of items) {
      bump(total, 'all');
      if (it.unread) bump(unread, 'all');
      for (const b of it.bundles) {
        bump(total, b);
        if (it.unread) bump(unread, b);
      }
    }
    return { total, unread };
  }, [items]);

  useEffect(() => { setCursor(0); }, [bundle, query]);

  // Android back / browser back closes the topmost modal-ish layer
  // instead of leaving the SPA. Each open pushes a history state; popstate
  // dispatches based on priority: action sheet > new task > settings >
  // issue panel > room panel > sidebar drawer.
  const anyModalOpen = !!actionSheetFor || newTaskOpen || settingsOpen || !!selectedIssue || !!selectedRoom || sidebarOpen;
  useEffect(() => {
    if (anyModalOpen) {
      history.pushState({ wukkieModal: true }, '');
      const onPop = () => {
        if (actionSheetFor) setActionSheetFor(null);
        else if (newTaskOpen) setNewTaskOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (selectedIssue) setSelectedIssue(null);
        else if (selectedRoom) setSelectedRoom(null);
        else if (sidebarOpen) setSidebarOpen(false);
      };
      window.addEventListener('popstate', onPop);
      return () => {
        window.removeEventListener('popstate', onPop);
        // If we close the modal ourselves (X button, scrim click), pop the
        // history entry we added so the back stack stays consistent.
        if (history.state?.wukkieModal) history.back();
      };
    }
    return;
    // We deliberately depend only on the boolean — re-running on every
    // state change of the individual modals would push extra entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyModalOpen]);

  // Tab title gets a (N) prefix when there are unread items, so the
  // user can see backlog from another tab without switching. Restore
  // on unmount in case the inbox component goes away (sign-out).
  useEffect(() => {
    const allUnread = counts.unread.get('all') ?? 0;
    const base = 'WukkieMail';
    document.title = allUnread > 0 ? `(${allUnread}) ${base}` : base;
    setFaviconDot(allUnread > 0);
    return () => { document.title = 'WukkieMail'; setFaviconDot(false); };
  }, [counts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      const isSnoozed = it.bundles.includes('snoozed');
      if (bundle === 'snoozed') {
        if (!isSnoozed) return false;
      } else {
        // Hide snoozed in any non-snoozed view (except when searching).
        if (isSnoozed && !q) return false;
        if (bundle !== 'all' && !it.bundles.includes(bundle)) return false;
      }
      // Don't apply the hide-read filter when:
      //   - viewing the Snoozed bundle (everything there is interesting)
      //   - viewing the Issues bundle (todos aren't 'read' in the same sense)
      //   - the item is an issue and we're in the All view (would otherwise hide
      //     all your tasks because Matrix has no read receipt for state events)
      const skipReadFilter = bundle === 'snoozed' || bundle === 'flavor:issue' || it.flavor === 'issue';
      if (!showRead && !it.unread && !q && !skipReadFilter) return false;
      // Status sub-filter only applies when viewing the Issues bundle.
      if (bundle === 'flavor:issue' && issueStatusFilter && it.statusValue !== issueStatusFilter) return false;
      if (!q) return true;
      return (
        it.subject.toLowerCase().includes(q) ||
        it.from.toLowerCase().includes(q) ||
        it.snippet.toLowerCase().includes(q) ||
        (it.fromAddress?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [items, bundle, query, showRead, issueStatusFilter]);

  // Status counts for the Issues sub-filter.
  const issueStatusCounts = useMemo(() => {
    if (bundle !== 'flavor:issue') return null;
    const counts = new Map<string, number>();
    for (const it of items) {
      if (it.flavor !== 'issue' || !it.statusValue) continue;
      counts.set(it.statusValue, (counts.get(it.statusValue) ?? 0) + 1);
    }
    return counts;
  }, [items, bundle]);

  // Reset status filter when leaving the Issues bundle.
  useEffect(() => { if (bundle !== 'flavor:issue') setIssueStatusFilter(null); }, [bundle]);

  const hiddenReadCount = useMemo(() => {
    if (showRead || query) return 0;
    return items.filter((it) => !it.unread && (bundle === 'all' || it.bundles.includes(bundle))).length;
  }, [items, bundle, query, showRead]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Robust focus check across shadow DOM. Material text fields nest
      // the real <input> in their shadow root, so the bare event target
      // and document.activeElement aren't reliable on their own.
      let node: Element | null = (e.target as Element | null) ?? document.activeElement;
      while (node) {
        const tag = node.tagName?.toLowerCase() ?? '';
        if (tag === 'input' || tag === 'textarea' || (node as HTMLElement).isContentEditable) {
          if (e.key === 'Escape') (node as HTMLInputElement).blur();
          return;
        }
        if (tag.includes('text-field')) return;
        const root = (node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (root?.activeElement) { node = root.activeElement; continue; }
        break;
      }

      if (e.key === '/') {
        e.preventDefault();
        const field = document.querySelector('.toolbar md-outlined-text-field') as HTMLElement | null;
        field?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (selectedIssue) { setSelectedIssue(null); return; }
        if (selectedRoom) { setSelectedRoom(null); return; }
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
        e.preventDefault();
        if (it.flavor === 'issue') {
          const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
          if (m) setSelectedIssue({ roomId: m[1], issueId: m[2] });
        } else {
          const m = it.id.match(/^matrix:(.+)$/);
          if (m) setSelectedRoom(m[1]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, cursor, query, selectedIssue, selectedRoom]);

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
        <BundleRow id="all" label="Inbox" total={counts.total.get('all') ?? 0} unread={counts.unread.get('all') ?? 0} active={bundle === 'all'} onSelect={(k) => { setBundle(k); setSidebarOpen(false); }} />
        {(counts.total.get('dm') ?? 0) > 0 && (
          <BundleRow id="dm" label="DMs" flavor="matrix" total={counts.total.get('dm') ?? 0} unread={counts.unread.get('dm') ?? 0} active={bundle === 'dm'} onSelect={(k) => { setBundle(k); setSidebarOpen(false); }} />
        )}
        {FLAVOR_ORDER.map((f) => {
          const key = flavorBundleKey(f);
          const total = counts.total.get(key) ?? 0;
          if (total === 0) return null;
          return (
            <BundleRow key={key} id={key} label={FLAVOR_LABELS[f]} flavor={f} total={total} unread={counts.unread.get(key) ?? 0} active={bundle === key} onSelect={(k) => { setBundle(k); setSidebarOpen(false); }} />
          );
        })}
        {spaceBundles.length > 0 && (
          <>
            <div style={{ margin: '12px 16px 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--muted)' }}>Spaces</div>
            {spaceBundles
              .filter((b) => (counts.total.get(b.id) ?? 0) > 0)
              .map((b) => (
                <BundleRow key={b.id} id={b.id} label={b.label} flavor="matrix" total={counts.total.get(b.id) ?? 0} unread={counts.unread.get(b.id) ?? 0} active={bundle === b.id} onSelect={(k) => { setBundle(k); setSidebarOpen(false); }} />
              ))}
          </>
        )}
        <SourceStatus
          label="Matrix"
          loading={matrix.kind === 'connecting' || matrix.kind === 'syncing'}
          error={matrix.kind === 'error' ? matrix.error : null}
        />
        <button
          onClick={() => { setSettingsOpen(true); setSidebarOpen(false); }}
          style={{
            marginTop: 16, width: '100%', padding: '8px',
            background: 'transparent', border: '1px solid var(--border)',
            borderRadius: 8, color: 'var(--muted)',
          }}
        >
          Priority tuning…
        </button>
        {matrixSrc && notifPerm !== 'unsupported' && notifPerm !== 'denied' && (
          <button
            onClick={async () => {
              if (!matrixSrc) return;
              const p = await matrixSrc.requestNotificationPermission();
              setNotifPerm(p);
            }}
            style={{
              marginTop: 8, width: '100%', padding: '8px',
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--muted)',
            }}
            disabled={notifPerm === 'granted'}
          >
            {notifPerm === 'granted' ? 'Notifications enabled' : 'Enable notifications'}
          </button>
        )}
        <button
          onClick={onSignOut}
          style={{
            marginTop: 8, width: '100%', padding: '8px',
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
          <div className="toolbar-inner">
            <button
              type="button"
              className="hamburger"
              aria-label="Menu"
              onClick={() => setSidebarOpen((o) => !o)}
            >
              <span className="material-symbols-outlined">menu</span>
            </button>
            <md-outlined-text-field
              label="Search"
              placeholder="Filter inbox…"
              value={query}
              ref={fieldRef((v) => setQuery(v))}
              style={{ flex: 1 }}
            />
            {query && (
              <button
                type="button"
                className="hamburger"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>
        </div>
        <BundleChips
          bundle={bundle} setBundle={setBundle}
          counts={counts} spaceBundles={spaceBundles}
          savedViews={savedViews}
          applyView={(v) => {
            setBundle(v.bundle);
            setQuery(v.query ?? '');
            setIssueStatusFilter(v.issueStatus ?? null);
            setShowRead(!!v.showRead);
          }}
          saveCurrentView={async () => {
            if (!matrixSrc) return;
            const name = prompt('Name this view');
            if (!name?.trim()) return;
            const view: SavedView = {
              id: crypto.randomUUID(),
              name: name.trim(),
              bundle,
              query: query || undefined,
              issueStatus: issueStatusFilter ?? undefined,
              showRead: showRead || undefined,
            };
            const next = [...savedViews, view];
            setSavedViews(next);
            await matrixSrc.setSavedViews(next);
          }}
          deleteView={async (id) => {
            if (!matrixSrc) return;
            const next = savedViews.filter((v) => v.id !== id);
            setSavedViews(next);
            await matrixSrc.setSavedViews(next);
          }}
        />
        {bundle === 'flavor:issue' && issueStatusCounts && issueStatusCounts.size > 0 && (
          <div className="chip-bar" style={{ top: 112 }}>
            <div className="chip-bar-inner">
              <button
                type="button"
                className={`chip ${issueStatusFilter === null ? 'active' : ''}`}
                onClick={() => setIssueStatusFilter(null)}
              >
                <span>All statuses</span>
              </button>
              {[...issueStatusCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <button
                    key={status}
                    type="button"
                    className={`chip ${issueStatusFilter === status ? 'active' : ''}`}
                    onClick={() => setIssueStatusFilter(status)}
                  >
                    <span>{status}</span>
                    <span className="chip-badge">{count}</span>
                  </button>
                ))}
            </div>
          </div>
        )}
        {bundle !== 'all' && visible.length > 0 && matrixSrc && (
          <div className="sweep-bar">
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              {visible.length} item{visible.length === 1 ? '' : 's'} in {bundleLabel(bundle, spaceBundles)}
            </span>
            <button
              type="button"
              className="sweep-btn"
              onClick={async () => {
                if (!matrixSrc) return;
                if (!confirm(`Mark all ${visible.length} items in ${bundleLabel(bundle, spaceBundles)} as done?`)) return;
                for (const it of visible) {
                  const m = it.id.match(/^matrix:([^:]+)$/);
                  if (m) await matrixSrc.markRoomRead(m[1]);
                  await matrixSrc.setManuallyUnread(it.id, false);
                }
              }}
            >
              <span className="material-symbols-outlined">cleaning_services</span>
              Sweep
            </button>
          </div>
        )}
        {loading ? (
          <div className="empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty">
            <p>{bundle === 'all' ? 'No items yet.' : `No items in ${bundleLabel(bundle, spaceBundles)}.`}</p>
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
            {(() => {
              const rendered: React.ReactNode[] = [];
              const shown = visible.slice(0, 200);
              // In the All view, group tasks above messages so each gets
              // a single header. Inside each group, retain the existing
              // (priority, ts) order so the user's tuning still ranks them.
              const isAll = bundle === 'all';
              const tasks = isAll ? shown.filter((x) => x.flavor === 'issue') : [];
              const messages = isAll ? shown.filter((x) => x.flavor !== 'issue') : shown;
              const ordered = isAll ? [...tasks, ...messages] : shown;
              const hasBothGroups = isAll && tasks.length > 0 && messages.length > 0;
              let lastGroup: 'issue' | 'message' | null = null;
              ordered.forEach((it, i) => {
                const group = it.flavor === 'issue' ? 'issue' : 'message';
                if (hasBothGroups && group !== lastGroup) {
                  rendered.push(
                    <div key={`h-${group}`} className="section-header">
                      {group === 'issue' ? 'Tasks' : 'Messages'}
                    </div>,
                  );
                  lastGroup = group;
                }
                const dim = it.priority <= -1;
                rendered.push(
                  <a
                    key={it.id}
                    data-idx={i}
                    className={`item ${i === cursor ? 'cursor' : ''} ${it.unread ? 'unread' : ''} ${dim ? 'dim' : ''}`}
                    href={it.openPath}
                    onClick={(e) => {
                      e.preventDefault();
                      if (it.flavor === 'issue') {
                        const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
                        if (m) setSelectedIssue({ roomId: m[1], issueId: m[2] });
                      } else {
                        const m = it.id.match(/^matrix:(.+)$/);
                        if (m) setSelectedRoom(m[1]);
                      }
                    }}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    <Avatar name={it.from} flavor={it.flavor} presence={it.senderPresence} url={it.avatarUrl} />
                    <div className="from">
                      {it.bundles.includes('pinned') && <span title="Pinned" style={{ marginRight: 4 }}>📌</span>}
                      {it.from}
                    </div>
                    <div className="subj">
                      <strong>{it.subject}</strong> — {it.snippet}
                    </div>
                    <div className="ts">
                      {it.snoozedUntil ? `↻ ${formatTs(it.snoozedUntil)}` : formatTs(it.ts)}
                    </div>
                    {matrixSrc && (
                      <button
                        type="button"
                        className="item-kebab"
                        aria-label="Actions"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setActionSheetFor(it.id);
                        }}
                      >
                        <span className="material-symbols-outlined">more_vert</span>
                      </button>
                    )}
                    {matrixSrc && (
                      <ItemActions
                        item={it}
                        isPinned={it.bundles.includes('pinned')}
                        snoozePopoverOpen={snoozePopoverFor === it.id}
                        onTogglePin={async () => {
                          await matrixSrc.setPinned(it.id, !it.bundles.includes('pinned'));
                        }}
                        onOpenSnoozePopover={() => setSnoozePopoverFor(snoozePopoverFor === it.id ? null : it.id)}
                        onSnooze={async (untilMs) => {
                          setSnoozePopoverFor(null);
                          await matrixSrc.setSnoozed(it.id, untilMs);
                        }}
                        onDone={async () => {
                          const m = it.id.match(/^matrix:([^:]+)$/);
                          if (m) await matrixSrc.markRoomRead(m[1]);
                          await matrixSrc.setManuallyUnread(it.id, false);
                        }}
                        onToggleUnread={async () => {
                          await matrixSrc.setManuallyUnread(it.id, !it.unread);
                        }}
                      />
                    )}
                  </a>,
                );
              });
              return rendered;
            })()}
            {hiddenReadCount > 0 && (
              <button
                type="button"
                className="show-read"
                onClick={() => setShowRead(true)}
              >
                Show {hiddenReadCount} read item{hiddenReadCount === 1 ? '' : 's'}
              </button>
            )}
            {showRead && !query && (
              <button
                type="button"
                className="show-read"
                onClick={() => setShowRead(false)}
              >
                Hide read items
              </button>
            )}
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
      {selectedRoom && matrixSrc && (
        <RoomPanel
          matrix={matrixSrc}
          roomId={selectedRoom}
          onClose={() => setSelectedRoom(null)}
        />
      )}
      {settingsOpen && matrixSrc && (
        <SettingsSheet matrix={matrixSrc} onClose={() => setSettingsOpen(false)} />
      )}
      {newTaskOpen && matrixSrc && (
        <NewTaskSheet
          matrix={matrixSrc}
          onClose={() => setNewTaskOpen(false)}
          onCreated={(roomId, issueId) => {
            setNewTaskOpen(false);
            setSelectedIssue({ roomId, issueId });
          }}
        />
      )}
      {matrixSrc && actionSheetFor && (() => {
        const target = items.find((x) => x.id === actionSheetFor);
        if (!target) return null;
        const isPinned = target.bundles.includes('pinned');
        const isSnoozed = target.bundles.includes('snoozed');
        return (
          <div className="sheet-scrim" onClick={() => setActionSheetFor(null)}>
            <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="action-sheet-title">{target.from} — {target.subject}</div>
              <button onClick={async () => { await matrixSrc.setPinned(target.id, !isPinned); setActionSheetFor(null); }}>
                <span className="material-symbols-outlined">{isPinned ? 'push_pin' : 'keep'}</span>
                {isPinned ? 'Unpin' : 'Pin'}
              </button>
              <button onClick={async () => { await matrixSrc.setSnoozed(target.id, nextHourOfDay(20)); setActionSheetFor(null); }}>
                <span className="material-symbols-outlined">schedule</span>
                Snooze until this evening
              </button>
              <button onClick={async () => { await matrixSrc.setSnoozed(target.id, nextDayAt(9)); setActionSheetFor(null); }}>
                <span className="material-symbols-outlined">schedule</span>
                Snooze until tomorrow 9am
              </button>
              <button onClick={async () => { await matrixSrc.setSnoozed(target.id, nextDayAt(9, 7)); setActionSheetFor(null); }}>
                <span className="material-symbols-outlined">schedule</span>
                Snooze for a week
              </button>
              {isSnoozed && (
                <button onClick={async () => { await matrixSrc.setSnoozed(target.id, null); setActionSheetFor(null); }}>
                  <span className="material-symbols-outlined">alarm_off</span>
                  Unsnooze
                </button>
              )}
              <button onClick={async () => { await matrixSrc.setManuallyUnread(target.id, !target.unread); setActionSheetFor(null); }}>
                <span className="material-symbols-outlined">{target.unread ? 'mark_email_read' : 'mark_email_unread'}</span>
                {target.unread ? 'Mark read' : 'Mark unread'}
              </button>
              <button onClick={async () => {
                const m = target.id.match(/^matrix:([^:]+)$/);
                if (m) await matrixSrc.markRoomRead(m[1]);
                await matrixSrc.setManuallyUnread(target.id, false);
                setActionSheetFor(null);
              }}>
                <span className="material-symbols-outlined">done_all</span>
                Done
              </button>
            </div>
          </div>
        );
      })()}
      {matrixSrc && (
        <button
          type="button"
          className="fab"
          aria-label="New task"
          onClick={() => setNewTaskOpen(true)}
        >
          <span className="material-symbols-outlined">add</span>
        </button>
      )}
    </div>
  );
}

function ItemActions({
  item, isPinned, snoozePopoverOpen, onTogglePin, onOpenSnoozePopover, onSnooze, onDone, onToggleUnread,
}: {
  item: InboxItem;
  isPinned: boolean;
  snoozePopoverOpen: boolean;
  onTogglePin: () => void;
  onOpenSnoozePopover: () => void;
  onSnooze: (untilMs: number | null) => void;
  onDone: () => void;
  onToggleUnread: () => void;
}) {
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  return (
    <div className="item-actions" onClick={stop}>
      <button type="button" title={isPinned ? 'Unpin' : 'Pin'} onClick={(e) => { stop(e); onTogglePin(); }}>
        <span className="material-symbols-outlined">{isPinned ? 'push_pin' : 'keep'}</span>
      </button>
      <div style={{ position: 'relative' }}>
        <button type="button" title="Snooze" onClick={(e) => { stop(e); onOpenSnoozePopover(); }}>
          <span className="material-symbols-outlined">schedule</span>
        </button>
        {snoozePopoverOpen && (
          <div className="snooze-popover" onClick={stop}>
            <button type="button" onClick={(e) => { stop(e); onSnooze(Date.now() + 1 * 3600 * 1000); }}>1 hour</button>
            <button type="button" onClick={(e) => { stop(e); onSnooze(nextHourOfDay(20)); }}>This evening</button>
            <button type="button" onClick={(e) => { stop(e); onSnooze(nextDayAt(9)); }}>Tomorrow 9am</button>
            <button type="button" onClick={(e) => { stop(e); onSnooze(nextDayAt(9, 7)); }}>Next week</button>
            {item.bundles.includes('snoozed') && (
              <button type="button" onClick={(e) => { stop(e); onSnooze(null); }}>Unsnooze</button>
            )}
          </div>
        )}
      </div>
      <button type="button" title={item.unread ? 'Mark read' : 'Mark unread'} onClick={(e) => { stop(e); onToggleUnread(); }}>
        <span className="material-symbols-outlined">{item.unread ? 'mark_email_read' : 'mark_email_unread'}</span>
      </button>
      <button type="button" title="Done" onClick={(e) => { stop(e); onDone(); }}>
        <span className="material-symbols-outlined">done_all</span>
      </button>
    </div>
  );
}

function nextHourOfDay(hour: number): number {
  const d = new Date();
  if (d.getHours() >= hour) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
function nextDayAt(hour: number, addDays = 1): number {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function BundleChips({
  bundle, setBundle, counts, spaceBundles, savedViews, applyView, saveCurrentView, deleteView,
}: {
  bundle: BundleKey;
  setBundle: (k: BundleKey) => void;
  counts: { total: Map<BundleKey, number>; unread: Map<BundleKey, number> };
  spaceBundles: BundleSpec[];
  savedViews: SavedView[];
  applyView: (v: SavedView) => void;
  saveCurrentView: () => void;
  deleteView: (id: string) => void;
}) {
  // Inline horizontal chip bar for the main bundles. Always shows All;
  // then DMs and each populated flavor; then space bundles. Click to
  // filter. The drawer remains for full nav.
  const chips: { id: BundleKey; label: string; flavor: ItemFlavor | null }[] = [
    { id: 'all', label: 'Inbox', flavor: null },
  ];
  if ((counts.total.get('dm') ?? 0) > 0) chips.push({ id: 'dm', label: 'DMs', flavor: 'matrix' });
  if ((counts.total.get('snoozed') ?? 0) > 0) chips.push({ id: 'snoozed', label: 'Snoozed', flavor: null });
  for (const f of FLAVOR_ORDER) {
    const k = flavorBundleKey(f);
    if ((counts.total.get(k) ?? 0) > 0) chips.push({ id: k, label: FLAVOR_LABELS[f], flavor: f });
  }
  for (const b of spaceBundles) {
    if ((counts.total.get(b.id) ?? 0) > 0) chips.push({ id: b.id, label: b.label, flavor: 'matrix' });
  }
  return (
    <div className="chip-bar">
      <div className="chip-bar-inner">
        {chips.map(({ id, label, flavor }) => {
          const unread = counts.unread.get(id) ?? 0;
          return (
            <button
              key={id}
              type="button"
              className={`chip ${bundle === id ? 'active' : ''}`}
              onClick={() => setBundle(id)}
            >
              {flavor && <span className={`src ${flavor}`} />}
              <span>{label}</span>
              {unread > 0 && <span className="chip-badge">{unread > 99 ? '99+' : unread}</span>}
            </button>
          );
        })}
        {savedViews.map((v) => (
          <span key={v.id} className="chip saved" title={`Saved view: ${v.name}`}>
            <button type="button" className="saved-apply" onClick={() => applyView(v)}>
              <span className="material-symbols-outlined" style={{ fontSize: 14, marginRight: 4 }}>bookmark</span>
              {v.name}
            </button>
            <button type="button" className="saved-del" aria-label="Delete view" onClick={() => deleteView(v.id)}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
            </button>
          </span>
        ))}
        <button type="button" className="chip" onClick={saveCurrentView} title="Save current view">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
        </button>
      </div>
    </div>
  );
}

function BundleRow({
  id, label, flavor, total, unread, active, onSelect,
}: {
  id: BundleKey;
  label: string;
  flavor?: ItemFlavor;
  total: number;
  unread: number;
  active: boolean;
  onSelect: (k: BundleKey) => void;
}) {
  return (
    <div
      className={`bundle ${active ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
      onClick={() => onSelect(id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(id); }}
      title={label}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {flavor && <span className={`src ${flavor}`} style={{ display: 'inline-block', width: 8, height: 8, marginRight: 8, borderRadius: 2, verticalAlign: 'middle' }} />}
        {label}
      </span>
      <span className="count">
        {unread > 0 ? <strong>{unread}</strong> : null}
        {unread > 0 && total > unread && <span style={{ opacity: 0.5 }}> / {total}</span>}
        {unread === 0 && total}
      </span>
    </div>
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

function Avatar({ name, flavor, presence, url }: { name: string; flavor: string; presence?: 'online' | 'unavailable' | 'offline'; url?: string }) {
  const [broken, setBroken] = useState(false);
  const hue = hashHue(name);
  const showImage = url && !broken;
  return (
    <div className="avatar-wrap">
      <div className="avatar" style={{ background: showImage ? 'transparent' : `hsl(${hue} 55% 50%)` }}>
        {showImage
          ? <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
          : <span>{initials(name)}</span>}
      </div>
      <span className={`avatar-badge ${flavor}`} title={flavor} />
      {presence && <span className={`avatar-presence ${presence}`} title={presence} />}
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

// Swap favicon between plain wukkie.svg and a version with a red dot
// overlay. We inline a tiny SVG via data: URI so it doesn't need a
// separate fetched file and updates immediately on toggle.
function setFaviconDot(unread: boolean) {
  const link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
  if (!link) return;
  if (!unread) { link.href = '/icons/wukkie.svg'; return; }
  // Same shape as wukkie.svg, plus a small red disc top-right.
  const dotted = `<svg viewBox='0 0 18 18' xmlns='http://www.w3.org/2000/svg'>
    <defs>
      <mask id='c'>
        <rect x='0' y='0' width='18' height='18' fill='black'/>
        <polygon points='4.2,5.2 13.0,5.2 14.0,4.2 5.2,4.2' fill='white'/>
        <rect x='4.2' y='5.2' width='8.8' height='8.8' fill='white'/>
      </mask>
    </defs>
    <circle cx='9' cy='9' r='8.5' fill='#14b8a6' stroke='#0f766e' stroke-width='1'/>
    <rect x='0' y='0' width='18' height='18' fill='#fff' mask='url(#c)'/>
    <circle cx='14' cy='4' r='3' fill='#ef4444' stroke='#fff' stroke-width='0.6'/>
  </svg>`;
  link.href = `data:image/svg+xml;utf8,${encodeURIComponent(dotted)}`;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
