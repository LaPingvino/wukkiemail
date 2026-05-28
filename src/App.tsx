import { useEffect, useMemo, useState, useCallback } from 'react';
import type { BundleSpec, ItemFlavor } from './sources/types';
import type { MessageHit } from './search';
import { parseQuery, matchItem } from './filter';
import { loginWithPassword, saveCreds, clearCreds, listSlots, setActiveSlot, getActiveSlot } from './auth/matrix';
import { MatrixSource } from './sources/matrix';
import { IssuePanel } from './IssuePanel';
import { RoomPanel } from './RoomPanel';
import { NewTaskSheet } from './NewTaskSheet';
import { SettingsSheet } from './SettingsSheet';
import { EncryptionSetupSheet } from './EncryptionSetupSheet';
import { VerificationSheet } from './VerificationSheet';
import { DoneValuesSheet } from './DoneValuesSheet';
import { BundleSheet } from './BundleSheet';
import type { ManualBundle } from './sources/matrix';
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



// Does a task's user-field set reference me? User fields may hold a full
// mxid, a bare localpart, or a display name, so match loosely: equal to
// the mxid, equal to the localpart, or either containing the other.
function issueAssignedToSelf(userValues: string[] | undefined, selfMxid: string | null): boolean {
  if (!selfMxid || !userValues || userValues.length === 0) return false;
  const mxid = selfMxid.toLowerCase();
  const local = mxid.replace(/^@/, '').split(':')[0];
  return userValues.some((raw) => {
    const v = raw.toLowerCase().trim();
    if (!v) return false;
    return v === mxid || v === local || v === `@${local}` || v.includes(local) || mxid.includes(v);
  });
}

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
  const [loading, setLoading] = useState(true);
  // The bundled stream is the only view now; bundle scoping is always 'all'.
  const bundle: BundleKey = 'all';
  const [query, setQuery] = useState('');
  const [msgHits, setMsgHits] = useState<MessageHit[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<{ roomId: string; issueId: string } | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  // Read-state filter for messages: unread-only (default), read-only, or all.
  const [readFilter, setReadFilter] = useState<'unread' | 'read' | 'all'>('unread');
  const [snoozePopoverFor, setSnoozePopoverFor] = useState<string | null>(null);
  const [actionSheetFor, setActionSheetFor] = useState<string | null>(null);
  const [issueStatusFilter, setIssueStatusFilter] = useState<Set<string>>(new Set());
  // When on, hide tasks not assigned to me (matched on any schema user field).
  const [mineOnly, setMineOnly] = useState(false);
  // Bundled-stream view: which bundles are folded open (accordion).
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(new Set());
  // The config bundle (settings + accounts) at the top of the stream.
  const [configOpen, setConfigOpen] = useState(false);
  // User-authored bundles (saved filters), and the create/edit sheet.
  const [manualBundles, setManualBundles] = useState<ManualBundle[]>([]);
  const [bundleSheet, setBundleSheet] = useState<{ editing?: ManualBundle; initialQuery?: string } | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [doneValuesOpen, setDoneValuesOpen] = useState(false);
  const [encryptionOpen, setEncryptionOpen] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [slots] = useState<string[]>(() => listSlots());
  const activeSlot = getActiveSlot();
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [cryptoStatus, setCryptoStatus] = useState<'none' | 'setup' | 'unverified' | 'verified'>('none');
  const [hasEncRoom, setHasEncRoom] = useState(false);
  // Refresh ticker: bumped every 60s so snoozed items re-evaluate
  // around their due time without an explicit per-snooze timer.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRefreshTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const matrixSrc = matrix.kind === 'syncing' || matrix.kind === 'ready' ? matrix.source : null;

  useEffect(() => {
    if (!matrixSrc) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await matrixSrc.getCryptoStatus();
        if (!cancelled) setCryptoStatus(s);
        if (!cancelled) setHasEncRoom(matrixSrc.hasAnyEncryptedRoom());
      } catch { /* swallow */ }
    };
    void refresh();
    const unsub = matrixSrc.subscribe(() => void refresh());
    return () => { cancelled = true; unsub(); };
  }, [matrixSrc]);

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
      if (!cancelled) setManualBundles(matrixSrc.getManualBundles());
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
    const active = new Map<BundleKey, number>();
    const bump = (m: Map<BundleKey, number>, k: BundleKey) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const it of items) {
      // Active = something the user might still want to do: unread,
      // or a not-yet-done issue (issues have priority -3 once done).
      const isActive = it.unread || (it.flavor === 'issue' && it.priority > -3);
      bump(total, 'all');
      if (it.unread) bump(unread, 'all');
      if (isActive) bump(active, 'all');
      for (const b of it.bundles) {
        bump(total, b);
        if (it.unread) bump(unread, b);
        if (isActive) bump(active, b);
      }
    }
    return { total, unread, active };
  }, [items]);

  useEffect(() => { setCursor(0); }, [bundle, query]);

  // Full-text message search via the off-thread index. Debounced so we
  // don't query on every keystroke. Cleared when the search box empties.
  useEffect(() => {
    const q = query.trim();
    if (!matrixSrc || q.length < 2) { setMsgHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      matrixSrc.searchMessages(q, 50)
        .then((hits) => { if (!cancelled) setMsgHits(hits); })
        .catch(() => { if (!cancelled) setMsgHits([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, matrixSrc]);

  // Android back / browser back closes the topmost modal-ish layer
  // instead of leaving the SPA. Each open pushes a history state; popstate
  // dispatches based on priority: action sheet > new task > settings >
  // issue panel > room panel > sidebar drawer.
  const anyModalOpen = !!actionSheetFor || newTaskOpen || newDmOpen || newGroupOpen || settingsOpen || doneValuesOpen || encryptionOpen || addAccountOpen || !!bundleSheet || !!selectedIssue || !!selectedRoom;
  useEffect(() => {
    if (anyModalOpen) {
      history.pushState({ wukkieModal: true }, '');
      const onPop = () => {
        if (actionSheetFor) setActionSheetFor(null);
        else if (newTaskOpen) setNewTaskOpen(false);
        else if (newDmOpen) setNewDmOpen(false);
        else if (newGroupOpen) setNewGroupOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (doneValuesOpen) setDoneValuesOpen(false);
        else if (encryptionOpen) setEncryptionOpen(false);
        else if (addAccountOpen) setAddAccountOpen(false);
        else if (bundleSheet) setBundleSheet(null);
        else if (selectedIssue) setSelectedIssue(null);
        else if (selectedRoom) setSelectedRoom(null);
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

  const selfMxid = matrixSrc?.id ?? null;
  // Parse the search box through the shared filter system, so the box
  // understands is:unread / flavor:x / from: / status: / is:mine alongside
  // free text — the same predicates bundles will be built from.
  const parsedQuery = useMemo(() => parseQuery(query), [query]);
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
      if (!skipReadFilter && !q) {
        if (readFilter === 'unread' && !it.unread) return false;
        if (readFilter === 'read' && it.unread) return false;
        // 'all' applies no read-state filter
      }
      // NOTE: the task status + "Mine" filters are NOT applied here. They are
      // *display* filters applied per-section/per-bundle at render time (see
      // displayFilter), so toggling them narrows a bundle's contents without
      // making the bundle — and the chips that control it — disappear.
      if (!q) return true;
      return matchItem(parsedQuery, it, { selfMxid });
    });
  }, [items, bundle, query, parsedQuery, readFilter, selfMxid]);

  // Per-section/per-bundle display filter for tasks (status chips + Mine).
  // Applied at render so the controlling chips never vanish with their items.
  const displayFilter = (it: InboxItem): boolean => {
    if (it.flavor !== 'issue') return true;
    if (issueStatusFilter.size > 0 && !issueStatusFilter.has(it.statusValue ?? '')) return false;
    if (mineOnly && !issueAssignedToSelf(it.userValues, selfMxid)) return false;
    return true;
  };

  // Whether any task carries user-field values — gates the "Mine" filter
  // chip so it only shows when assignment is actually in play.
  const anyAssignableTasks = useMemo(
    () => items.some((it) => it.flavor === 'issue' && (it.userValues?.length ?? 0) > 0),
    [items],
  );

  // In a combined multi-account / multi-source inbox, show each row's
  // origin so it's clear which inbox an item came from. Only when more
  // than one distinct account is actually present (single-account =
  // redundant, so hidden).
  const showOrigin = useMemo(
    () => new Set(items.map((it) => it.accountId).filter(Boolean)).size > 1,
    [items],
  );

  // Status counts for the Tasks-header status chips. Computed across every
  // task visible in the current bundle (not just the Issues bundle) so the
  // chips work in the All view too. Counts ignore the status filter itself
  // so toggling a chip never makes the other chips disappear.
  const issueStatusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      if (it.flavor !== 'issue') continue;
      if (bundle !== 'all' && !it.bundles.includes(bundle)) continue;
      // Tasks with no kanban status bucket under '' so they get a "None"
      // chip — otherwise selecting any status chip would silently hide them.
      const key = it.statusValue ?? '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [items, bundle]);

  // Don't reset the filter when leaving the Issues bundle — the chips
  // live with the Tasks section header now and apply wherever tasks
  // show up (All view too). Clearing only happens when the user
  // explicitly deselects all chips.

  const hiddenReadCount = useMemo(() => {
    if (readFilter !== 'unread' || query) return 0;
    return items.filter((it) => !it.unread && (bundle === 'all' || it.bundles.includes(bundle))).length;
  }, [items, bundle, query, readFilter]);

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

  // Which bundle an item folds into when it isn't important enough to show
  // loose. Precedence: space (strongest grouping) → DM → flavor. (Manual
  // bundles will slot in ahead of these in a later step.)
  const primaryKey = (it: InboxItem): string => {
    const space = it.bundles.find((b) => b.startsWith('space:'));
    if (space) return space;
    if (it.bundles.includes('dm')) return 'dm';
    return `flavor:${it.flavor}`;
  };

  // The bundled stream for the All view: loose (important) items shown
  // directly; everything else grouped into fold-open bundles. Built on the
  // already-filtered `visible`, so search/read/status/mine still apply.
  // Manual bundles (saved filters) take precedence over auto-grouping and
  // always appear (even when empty) so they stay findable/editable.
  const bundled = useMemo(() => {
    const topLevel = matrixSrc?.getWeights().topLevel ?? 5;
    const manualParsed = manualBundles.map((b) => ({ b, f: parseQuery(b.query) }));
    const assign = (it: InboxItem): string => {
      for (const { b, f } of manualParsed) {
        if (matchItem(f, it, { selfMxid })) return `manual:${b.id}`;
      }
      return primaryKey(it);
    };
    const loose: InboxItem[] = [];
    const groups = new Map<string, InboxItem[]>();
    for (const it of visible) {
      if (it.priority >= topLevel || it.bundles.includes('pinned')) { loose.push(it); continue; }
      const k = assign(it);
      const arr = groups.get(k);
      if (arr) arr.push(it); else groups.set(k, [it]);
    }
    loose.sort((a, b) => (b.priority - a.priority) || (b.ts - a.ts));
    const sortItems = (xs: InboxItem[]) => xs.sort((a, b) => (b.priority - a.priority) || (b.ts - a.ts));
    // Manual bundles first, in user order, always present.
    const manualList = manualBundles.map((b) => {
      const gItems = sortItems(groups.get(`manual:${b.id}`) ?? []);
      groups.delete(`manual:${b.id}`);
      return { key: `manual:${b.id}`, label: b.label, flavor: 'matrix' as ItemFlavor, manual: b, items: gItems, unread: gItems.filter((g) => g.unread).length };
    });
    // Then the auto-bundles, sorted by activity.
    const autoList = [...groups.entries()].map(([key, gItems]) => ({
      key,
      label: bundleLabel(key as BundleKey, spaceBundles),
      flavor: (key.startsWith('flavor:') ? key.slice(7) : 'matrix') as ItemFlavor,
      manual: undefined as ManualBundle | undefined,
      items: sortItems(gItems),
      unread: gItems.filter((g) => g.unread).length,
    }));
    autoList.sort((a, b) => (b.unread - a.unread) || (b.items.length - a.items.length) || a.label.localeCompare(b.label));
    return { loose, groups: [...manualList, ...autoList] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, spaceBundles, matrixSrc, items, manualBundles, selfMxid]);

  // One inbox row. Shared by the flat list, the loose section, and the
  // contents of an opened bundle. `idx` drives keyboard-cursor highlight.
  const renderItem = (it: InboxItem, idx: number): React.ReactNode => (
    <a
      key={it.id}
      data-idx={idx}
      className={`item ${idx === cursor ? 'cursor' : ''} ${it.unread ? 'unread' : ''} ${it.priority <= -1 ? 'dim' : ''}`}
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
        {it.subject}
        {showOrigin && it.originLabel && (
          <span className="origin-tag" title={it.accountId}>{it.originLabel}</span>
        )}
      </div>
      <div className="subj">
        <strong>{it.from}</strong> — {it.snippet}
      </div>
      <div className="ts">
        {it.snoozedUntil ? `↻ ${formatTs(it.snoozedUntil)}` : formatTs(it.ts)}
      </div>
      {matrixSrc && (
        <button
          type="button"
          className="item-kebab"
          aria-label="Actions"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActionSheetFor(it.id); }}
        >
          <span className="material-symbols-outlined">more_vert</span>
        </button>
      )}
      {matrixSrc && (
        <ItemActions
          item={it}
          isPinned={it.bundles.includes('pinned')}
          snoozePopoverOpen={snoozePopoverFor === it.id}
          onTogglePin={async () => { await matrixSrc.setPinned(it.id, !it.bundles.includes('pinned')); }}
          onOpenSnoozePopover={() => setSnoozePopoverFor(snoozePopoverFor === it.id ? null : it.id)}
          onSnooze={async (untilMs) => { setSnoozePopoverFor(null); await matrixSrc.setSnoozed(it.id, untilMs); }}
          onDone={async () => {
            const m = it.id.match(/^matrix:([^:]+)$/);
            if (m) await matrixSrc.markRoomRead(m[1]);
            await matrixSrc.setManuallyUnread(it.id, false);
          }}
          onToggleUnread={async () => { await matrixSrc.setManuallyUnread(it.id, !it.unread); }}
        />
      )}
    </a>
  );

  const toggleStatus = (status: string) =>
    setIssueStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });

  // The per-section / per-bundle filter controls. `items` scopes the sweep
  // and (for the status chips inside a bundle) the available statuses.
  const renderFilterChips = (hasIssues: boolean, hasMessages: boolean, scope: InboxItem[]): React.ReactNode => (
    <div className="section-filters">
      {hasIssues && (
        <>
          <button
            type="button"
            className={`mini-chip ${issueStatusFilter.size === 0 ? 'active' : ''}`}
            onClick={() => setIssueStatusFilter(new Set())}
          >All</button>
          {[...issueStatusCounts.entries()].sort((a, b) => b[1] - a[1]).map(([status, count]) => (
            <button
              key={status || '∅none'}
              type="button"
              className={`mini-chip ${issueStatusFilter.has(status) ? 'active' : ''}`}
              onClick={() => toggleStatus(status)}
            >
              {status || 'None'}
              <span className="chip-badge">{count}</span>
            </button>
          ))}
          {anyAssignableTasks && (
            <button
              type="button"
              className={`mini-chip ${mineOnly ? 'active' : ''}`}
              title="Show only tasks assigned to me"
              onClick={() => setMineOnly((v) => !v)}
            >Mine</button>
          )}
        </>
      )}
      {hasMessages && (['unread', 'read', 'all'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`mini-chip ${readFilter === mode ? 'active' : ''}`}
          onClick={() => setReadFilter(mode)}
        >{mode === 'unread' ? 'Unread' : mode === 'read' ? 'Read' : 'All'}</button>
      ))}
      {hasIssues && scope.some((t) => t.flavor === 'issue' && t.priority > -1) && (
        <button
          type="button"
          className="section-sweep"
          title="Mark all tasks done"
          onClick={async () => {
            if (!matrixSrc) return;
            const open = scope.filter((t) => t.flavor === 'issue' && t.priority > -1);
            if (!confirm(`Mark all ${open.length} task${open.length === 1 ? '' : 's'} done?`)) return;
            for (const it of open) {
              const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
              if (m) await matrixSrc.markIssueDone(m[1], m[2]);
            }
          }}
        >
          <span className="material-symbols-outlined">done_all</span>
        </button>
      )}
      {hasMessages && scope.some((m) => m.flavor !== 'issue' && m.unread) && (
        <button
          type="button"
          className="section-sweep"
          title="Mark all read"
          onClick={async () => {
            if (!matrixSrc) return;
            const unread = scope.filter((m) => m.flavor !== 'issue' && m.unread);
            if (!confirm(`Mark all ${unread.length} message${unread.length === 1 ? '' : 's'} read?`)) return;
            for (const it of unread) {
              const m = it.id.match(/^matrix:([^:]+)$/);
              if (m) await matrixSrc.markRoomRead(m[1]);
              await matrixSrc.setManuallyUnread(it.id, false);
            }
          }}
        >
          <span className="material-symbols-outlined">mark_chat_read</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="app no-sidebar">
      <main className="main">
        <div className="toolbar">
          <div className="toolbar-inner">
            <span className="toolbar-brand" title="WukkieMail">
              <img src="/icons/wukkie.svg" alt="" width={24} height={24} />
            </span>
            <md-outlined-text-field
              label="Search"
              placeholder="Search — try is:unread or flavor:whatsapp"
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
        {loading ? (
          <div className="empty">Loading…</div>
        ) : visible.length === 0 && msgHits.length === 0 ? (
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
              let idx = 0;
              const isBundled = bundle === 'all' && !query.trim();

              if (isBundled) {
                // Config bundle at the very top — folds open to settings +
                // accounts (the sidebar's non-space controls live here now).
                rendered.push(
                  <div key="b-config" className={`bundle-row config-bundle ${configOpen ? 'open' : ''}`}>
                    <button type="button" className="bundle-head" onClick={() => setConfigOpen((o) => !o)}>
                      <span className="material-symbols-outlined bundle-chevron">
                        {configOpen ? 'expand_more' : 'chevron_right'}
                      </span>
                      <span className="material-symbols-outlined" style={{ color: 'var(--muted)' }}>settings</span>
                      <span className="bundle-label">Settings &amp; accounts</span>
                      {cryptoStatus !== 'verified' && hasEncRoom && (
                        <span className="bundle-count" style={{ color: 'var(--md-sys-color-primary)' }}>encryption ●</span>
                      )}
                    </button>
                    {configOpen && (
                      <div className="bundle-body config-body">
                        <div className="accounts">
                          {slots.map((slot) => (
                            <button
                              key={slot}
                              type="button"
                              className={`config-account ${slot === activeSlot ? 'active' : ''}`}
                              onClick={() => { if (slot !== activeSlot) { setActiveSlot(slot); window.location.reload(); } }}
                            >
                              <span className="src matrix" style={{ marginRight: 6 }} />
                              {slot}
                            </button>
                          ))}
                          <button type="button" className="config-btn" onClick={() => setAddAccountOpen(true)}>+ Add account</button>
                        </div>
                        {matrixSrc && hasEncRoom && cryptoStatus !== 'verified' && (
                          <button type="button" className="crypto-banner" onClick={() => setEncryptionOpen(true)} title="Set up encryption">
                            <span className="material-symbols-outlined">lock_open</span>
                            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                              <strong>Set up encryption</strong>
                              <div style={{ fontSize: 11, opacity: 0.8 }}>Cross-signing + recovery key for encrypted history.</div>
                            </div>
                          </button>
                        )}
                        <button type="button" className="config-btn" onClick={() => setSettingsOpen(true)}>Priority tuning…</button>
                        <button type="button" className="config-btn" onClick={() => setDoneValuesOpen(true)}>Task "done" statuses…</button>
                        {matrixSrc && notifPerm !== 'unsupported' && notifPerm !== 'denied' && (
                          <button
                            type="button"
                            className="config-btn"
                            disabled={notifPerm === 'granted'}
                            onClick={async () => { if (matrixSrc) setNotifPerm(await matrixSrc.requestNotificationPermission()); }}
                          >
                            {notifPerm === 'granted' ? 'Notifications enabled' : 'Enable notifications'}
                          </button>
                        )}
                        <button type="button" className="config-btn" onClick={onSignOut}>Sign out</button>
                      </div>
                    )}
                  </div>,
                );
                // Loose (important) items shown directly at the top level.
                for (const it of bundled.loose) if (displayFilter(it)) rendered.push(renderItem(it, idx++));
                // Everything else folds into bundles, opened in place.
                for (const g of bundled.groups) {
                  const open = expandedBundles.has(g.key);
                  rendered.push(
                    <div key={`b-${g.key}`} className={`bundle-row ${open ? 'open' : ''}`}>
                      <button
                        type="button"
                        className="bundle-head"
                        onClick={() => setExpandedBundles((prev) => {
                          const n = new Set(prev);
                          if (n.has(g.key)) n.delete(g.key); else n.add(g.key);
                          return n;
                        })}
                      >
                        <span className="material-symbols-outlined bundle-chevron">
                          {open ? 'expand_more' : 'chevron_right'}
                        </span>
                        {g.manual
                          ? <span className="material-symbols-outlined" style={{ color: 'var(--muted)', fontSize: 18 }}>bookmark</span>
                          : <span className={`src ${g.flavor}`} />}
                        <span className="bundle-label">{g.label}</span>
                        <span className="bundle-count">
                          {g.unread > 0 ? `${g.unread} unread · ` : ''}{g.items.length}
                        </span>
                        {g.manual && (
                          <span
                            className="section-sweep"
                            role="button"
                            aria-label="Edit bundle"
                            title="Edit bundle"
                            onClick={(e) => { e.stopPropagation(); setBundleSheet({ editing: g.manual }); }}
                          >
                            <span className="material-symbols-outlined">edit</span>
                          </span>
                        )}
                      </button>
                      {open && (
                        <div className="bundle-body">
                          {renderFilterChips(
                            g.items.some((x) => x.flavor === 'issue'),
                            g.items.some((x) => x.flavor !== 'issue'),
                            g.items,
                          )}
                          {g.items.filter(displayFilter).slice(0, 200).map((it) => renderItem(it, idx++))}
                          {g.items.length === 0 && (
                            <div className="empty" style={{ height: 'auto', padding: 16, fontSize: 13 }}>
                              <p>Nothing matches this bundle right now.</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>,
                  );
                }
                // New-bundle entry at the end of the stream.
                rendered.push(
                  <button
                    key="new-bundle"
                    type="button"
                    className="config-btn"
                    style={{ marginTop: 4 }}
                    onClick={() => setBundleSheet({ initialQuery: query.trim() || undefined })}
                  >
                    + New bundle{query.trim() ? ' from this search' : ''}
                  </button>,
                );
                if (bundled.loose.length === 0 && bundled.groups.length === 0) {
                  rendered.push(
                    <div key="empty-inline" className="empty" style={{ height: 'auto', padding: 24 }}>
                      <p>Nothing to triage. 🎉</p>
                    </div>,
                  );
                }
                return rendered;
              }

              // Flat mode: a focused bundle view or an active search. Keep the
              // Tasks / Messages section headers with their inline chips.
              const shown = visible.slice(0, 200);
              const tasks = shown.filter((x) => x.flavor === 'issue');
              const messages = shown.filter((x) => x.flavor !== 'issue');
              const ordered = [...tasks, ...messages];
              const showHeaders = !!matrixSrc;
              let lastGroup: 'issue' | 'message' | null = null;
              ordered.forEach((it) => {
                const group = it.flavor === 'issue' ? 'issue' : 'message';
                if (showHeaders && group !== lastGroup) {
                  rendered.push(
                    <div key={`h-${group}`} className="section-header">
                      <span className="section-header-label">
                        {group === 'issue' ? 'Tasks' : 'Messages'}
                      </span>
                      {group === 'issue'
                        ? renderFilterChips(true, false, tasks)
                        : renderFilterChips(false, true, messages)}
                    </div>,
                  );
                  lastGroup = group;
                }
                if (displayFilter(it)) rendered.push(renderItem(it, idx++));
              });
              return rendered;
            })()}
            {hiddenReadCount > 0 && (
              <button
                type="button"
                className="show-read"
                onClick={() => setReadFilter('all')}
              >
                Show {hiddenReadCount} read item{hiddenReadCount === 1 ? '' : 's'}
              </button>
            )}
            {readFilter !== 'unread' && !query && (
              <button
                type="button"
                className="show-read"
                onClick={() => setReadFilter('unread')}
              >
                Show unread only
              </button>
            )}
            {query.trim().length >= 2 && msgHits.length > 0 && (
              <>
                <div className="section-header">
                  <span className="section-header-label">In messages</span>
                </div>
                {msgHits.map((hit) => (
                  <a
                    key={hit.id}
                    className="item msg-hit"
                    href={`/m/${encodeURIComponent(hit.roomId)}`}
                    onClick={(e) => { e.preventDefault(); setSelectedRoom(hit.roomId); }}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    <Avatar name={hit.sender} flavor="matrix" />
                    <div className="from">{hit.roomName}</div>
                    <div className="subj">{hit.body}</div>
                    <div className="ts">{formatTs(hit.ts)}</div>
                  </a>
                ))}
              </>
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
          onOpenChat={() => { const r = selectedIssue.roomId; setSelectedIssue(null); setSelectedRoom(r); }}
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
      {encryptionOpen && matrixSrc && (
        <EncryptionSetupSheet matrix={matrixSrc} onClose={() => setEncryptionOpen(false)} />
      )}
      {doneValuesOpen && matrixSrc && (
        <DoneValuesSheet matrix={matrixSrc} onClose={() => setDoneValuesOpen(false)} />
      )}
      {matrixSrc && <VerificationSheet matrix={matrixSrc} />}
      {bundleSheet && matrixSrc && (
        <BundleSheet
          items={items}
          selfMxid={selfMxid}
          initial={bundleSheet.editing}
          initialQuery={bundleSheet.initialQuery}
          onSave={async (b) => {
            const others = manualBundles.filter((x) => x.id !== b.id);
            const next = bundleSheet.editing ? manualBundles.map((x) => (x.id === b.id ? b : x)) : [...others, b];
            setManualBundles(next);
            setBundleSheet(null);
            await matrixSrc.setManualBundles(next);
          }}
          onDelete={async (id) => {
            const next = manualBundles.filter((x) => x.id !== id);
            setManualBundles(next);
            setBundleSheet(null);
            await matrixSrc.setManualBundles(next);
          }}
          onClose={() => setBundleSheet(null)}
        />
      )}
      {addAccountOpen && (
        <AddAccountSheet
          onClose={() => setAddAccountOpen(false)}
          onAdded={(slot) => {
            setActiveSlot(slot);
            window.location.reload();
          }}
        />
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
      {newDmOpen && matrixSrc && (
        <NewDmSheet
          matrix={matrixSrc}
          onClose={() => setNewDmOpen(false)}
          onCreated={(roomId) => { setNewDmOpen(false); setSelectedRoom(roomId); }}
        />
      )}
      {newGroupOpen && matrixSrc && (
        <NewGroupSheet
          matrix={matrixSrc}
          onClose={() => setNewGroupOpen(false)}
          onCreated={(roomId) => { setNewGroupOpen(false); setSelectedRoom(roomId); }}
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
        <div className="fab-stack">
          {fabMenuOpen && (
            <div className="fab-menu">
              <button type="button" onClick={() => { setFabMenuOpen(false); setNewTaskOpen(true); }}>
                <span className="material-symbols-outlined">check_box</span>
                New task
              </button>
              <button type="button" onClick={() => { setFabMenuOpen(false); setNewDmOpen(true); }}>
                <span className="material-symbols-outlined">person_add</span>
                New DM
              </button>
              <button type="button" onClick={() => { setFabMenuOpen(false); setNewGroupOpen(true); }}>
                <span className="material-symbols-outlined">group_add</span>
                New group
              </button>
            </div>
          )}
          <button
            type="button"
            className="fab"
            aria-label={fabMenuOpen ? 'Close menu' : 'New…'}
            onClick={() => setFabMenuOpen((o) => !o)}
          >
            <span className="material-symbols-outlined">{fabMenuOpen ? 'close' : 'add'}</span>
          </button>
        </div>
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

function NewDmSheet({ matrix, onClose, onCreated }: { matrix: import('./sources/matrix').MatrixSource; onClose: () => void; onCreated: (roomId: string) => void }) {
  const [mxid, setMxid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!mxid) return;
    setBusy(true); setError(null);
    try { onCreated(await matrix.createDirectMessage(mxid.trim())); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>New DM</div>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Matrix ID</span>
            <input type="text" autoFocus value={mxid}
              onChange={(e) => setMxid(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && mxid) void submit(); }}
              placeholder="@friend:server" />
          </label>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13 }}>{error}</p>}
          <button type="button" className="sheet-submit" onClick={() => void submit()} disabled={!mxid || busy} style={{ justifySelf: 'end' }}>
            {busy ? 'Creating…' : 'Start chat'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewGroupSheet({ matrix, onClose, onCreated }: { matrix: import('./sources/matrix').MatrixSource; onClose: () => void; onCreated: (roomId: string) => void }) {
  const [name, setName] = useState('');
  const [invitesText, setInvitesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    const invites = invitesText.split(/[,\s\n]+/).map((s) => s.trim()).filter(Boolean);
    try { onCreated(await matrix.createGroup(name.trim(), invites)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>New group</div>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Name</span>
            <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Team Foo" />
          </label>
          <label className="sheet-label">
            <span>Invite (optional)</span>
            <textarea
              rows={3}
              value={invitesText}
              onChange={(e) => setInvitesText(e.target.value)}
              placeholder="@user1:server, @user2:server"
              style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--fg)', font: 'inherit', fontSize: 14 }}
            />
          </label>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13 }}>{error}</p>}
          <button type="button" className="sheet-submit" onClick={() => void submit()} disabled={!name.trim() || busy} style={{ justifySelf: 'end' }}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddAccountSheet({
  onClose, onAdded,
}: {
  onClose: () => void;
  onAdded: (slot: string) => void;
}) {
  const [mxid, setMxid] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!mxid || !pw) return;
    setBusy(true);
    setError(null);
    try {
      const creds = await loginWithPassword(mxid, pw);
      saveCreds(creds);
      onAdded(creds.userId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Add account</div>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Matrix ID</span>
            <input type="text" autoFocus value={mxid} onChange={(e) => setMxid(e.target.value)} placeholder="@you:matrix.org" />
          </label>
          <label className="sheet-label">
            <span>Password</span>
            <input
              type="password" value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && mxid && pw) void submit(); }}
            />
          </label>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13, margin: 0 }}>{error}</p>}
          <button
            type="button" className="sheet-submit"
            onClick={() => void submit()}
            disabled={!mxid || !pw || busy}
            style={{ justifySelf: 'end' }}
          >
            {busy ? 'Signing in…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
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
