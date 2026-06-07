import { useEffect, useMemo, useState, useCallback, useRef, useTransition } from 'react';
import type { BundleSpec, ItemFlavor } from './sources/types';
import type { MessageHit } from './search';
import { parseQuery, matchItem, EMPTY_FILTER, isEmptyFilter } from './filter';
import { loginWithPassword, saveCreds, clearCreds, listSlots, setActiveSlot, getActiveSlot, isLiteStorage, setLiteStorage, isClassicSync, setClassicSync } from './auth/matrix';
import { MatrixSource } from './sources/matrix';
import { IssuePanel } from './IssuePanel';
import { RoomPanel } from './RoomPanel';
import { NewTaskSheet } from './NewTaskSheet';
import { PersonPicker } from './PersonPicker';
import { SettingsSheet } from './SettingsSheet';
import { EncryptionSetupSheet, EncryptionSetup } from './EncryptionSetupSheet';
import { DevicesSheet } from './DevicesSheet';
import { CallView } from './CallView';
import { WidgetPanel } from './WidgetPanel';
import { getCallTemplate, setCallTemplate, DEFAULT_CALL_TEMPLATE, getSfuServiceUrl, setSfuServiceUrl, getRingtoneEnabled, setRingtoneEnabled } from './call';
import { startRinging, stopRinging } from './ring';
import { VerificationSheet } from './VerificationSheet';
import { DoneValuesSheet } from './DoneValuesSheet';
import { BundleSheet } from './BundleSheet';
import { QueryChips } from './QueryChips';
import { JmapLoginSheet } from './JmapLoginSheet';
import { EmailView } from './EmailView';
import { ProfilePage } from './ProfilePage';
import { RoomSettings } from './RoomSettings';
import { MembersPage } from './MembersPage';
import { ComposeSheet } from './ComposeSheet';
import { JmapSource, loadJmapCreds, clearJmapCreds } from './sources/jmap';
import type { ManualBundle, SpaceNode, IncomingCall } from './sources/matrix';
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
  // Inline ref callbacks are re-run on EVERY render (React calls the old one
  // with null, then the new one with the node). The previous version added an
  // 'input' listener each time and never removed it, so handlers piled up
  // unboundedly — every keystroke ended up firing N stale handlers and queuing
  // N setStates, getting slower the longer the field lived. Track and remove the
  // listener on cleanup so there is always exactly one.
  let bound: { el: HTMLElement; handler: (ev: Event) => void } | null = null;
  return (el: HTMLElement | null) => {
    if (bound) {
      bound.el.removeEventListener('input', bound.handler);
      bound = null;
    }
    if (!el) return;
    const handler = (ev: Event) => {
      setter((ev.target as HTMLInputElement & { value: string }).value);
    };
    el.addEventListener('input', handler);
    bound = { el, handler };
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

// Stable inbox ordering within a priority class. Day-bucketed recency keeps
// "newer above older" at a coarse grain without the continuous-ts churn (every
// event reshuffling the list); the id tiebreak makes it fully deterministic so
// the order — and the virtual-bundle fold boundary built on top of it — holds
// steady between renders.
const DAY_MS = 86_400_000;
const stableItemCmp = (a: InboxItem, b: InboxItem): number =>
  (b.priority - a.priority)
  || (Math.floor(b.ts / DAY_MS) - Math.floor(a.ts / DAY_MS))
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// "Quiet" = read and not an invite — nothing is waiting on you. These are the
// rooms the virtual fold compresses and the read-sink pushes down.
const isQuietItem = (it: InboxItem): boolean => !it.unread && !it.invite;
// Minimum quiet rooms before they fold into a collapsed "quiet conversations"
// bundle (run-length hysteresis, mirroring the chat fold's "don't fold a single
// event" rule). Below this they stay visible as ordinary rows.
const QUIET_FOLD_MIN = 3;

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



// App-level inbox cache in localStorage. The SDK's only persistent store is
// IndexedDB, which on some browser profiles throws "Query failed:
// UnknownError" and forces MemoryStore (full re-sync every reload). Caching
// the computed item list here lets the inbox render instantly on reload
// regardless, while the SDK re-syncs in the background.
const itemsCacheKey = () => `wukkiemail.items.cache.v1.${getActiveSlot() ?? ''}`;
function loadCachedItems(): InboxItem[] {
  try {
    const raw = localStorage.getItem(itemsCacheKey());
    const arr = raw ? (JSON.parse(raw) as InboxItem[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveCachedItems(items: InboxItem[]): void {
  try { localStorage.setItem(itemsCacheKey(), JSON.stringify(items.slice(0, 300))); }
  catch { /* quota / serialization — non-fatal */ }
}

// A node in the bundled stream. Space bundles can nest (children); manual
// and flavor/dm bundles are leaves. count/unread include descendants.
interface BundleNode {
  key: string;
  label: string;
  flavor: ItemFlavor;
  manual?: ManualBundle;
  items: InboxItem[];   // items directly in this bundle (not in children)
  unread: number;       // incl. descendants
  count: number;        // incl. descendants
  children: BundleNode[];
  pinned?: boolean;     // bundle pinned as a unit → floats to the top intact
  virtual?: boolean;    // auto-synthesized (e.g. the "quiet conversations" fold), not a structural/manual bundle
  priority?: number;    // collective priority (max member) — drives unified ordering (phase 3); undefined for structural bundles
}

// One element of the interleaved inbox stream: an individual (loose) room OR a
// bundle. Loose rooms and bundles compete for position in one tier+priority sort
// (Approach A) instead of loose always rendering as a band above the bundles.
type StreamEl = { kind: 'room'; item: InboxItem } | { kind: 'bundle'; node: BundleNode };

// All items in a bundle, including nested spaces — bundle-level actions
// (mark all, snooze all) must reach descendants, not just direct items.
function collectBundleItems(node: BundleNode): InboxItem[] {
  const out = [...node.items];
  for (const c of node.children) out.push(...collectBundleItems(c));
  return out;
}

// Extract the Matrix room id from an inbox item id (`matrix:<roomId>`, with
// issue items as `matrix:<roomId>:issue:<issueId>`). Room ids may or may not
// contain a colon: pre-v12 ids are !localpart:homeserver, but room v12+ ids
// drop the server part (!hash, no colon). The old `/^matrix:([^:]+)$/` was
// $-anchored, so it matched ONLY the colon-less v12 ids and failed for every
// colon-containing id — markRoomRead was never called for older rooms (e.g.
// the libera.chat IRC bundle), so "mark all read" did nothing there. Stripping
// the prefix and any :issue: suffix handles both id shapes.
function itemRoomId(id: string): string | null {
  if (!id.startsWith('matrix:')) return null;
  const rest = id.slice('matrix:'.length);
  const i = rest.indexOf(':issue:');
  return i >= 0 ? rest.slice(0, i) : rest;
}

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
  if (key.startsWith('space:') || key.startsWith('mailbox:')) {
    return spaceBundles.find((b) => b.id === key)?.label ?? (key.startsWith('mailbox:') ? 'Mailbox' : 'Space');
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
  // Hydrate the inbox from the localStorage cache immediately, so a reload
  // shows the last-known items at once (the SDK then refreshes them).
  const [items, setItems] = useState<InboxItem[]>(loadCachedItems);
  const [spaceBundles, setSpaceBundles] = useState<BundleSpec[]>([]);
  const [mailBundles, setMailBundles] = useState<BundleSpec[]>([]);
  const [spaceTree, setSpaceTree] = useState<SpaceNode[]>([]);
  const [loading, setLoading] = useState(() => loadCachedItems().length === 0);
  // True while the SDK is still doing its initial sync. Drives a small
  // non-blocking banner at the bottom of the list (rather than a full-screen
  // notice that covers the cached items we already showed instantly).
  const [syncing, setSyncing] = useState(true);
  // The bundled stream is the only view now; bundle scoping is always 'all'.
  const bundle: BundleKey = 'all';
  // `query` drives all the heavy filtering. It is updated ONLY inside a
  // transition (setSearch below), and the search input is UNCONTROLLED (no
  // value={query}) — so a keystroke does zero blocking React work: the browser
  // owns the text natively, and the filtered-list re-render runs as an
  // interruptible transition that yields the main thread back to your typing.
  // Nothing in a render can stall the box. The clear/chip paths set the field's
  // value imperatively (the field is the source of truth for its text).
  const [query, setQuery] = useState('');
  const [, startSearch] = useTransition();
  // Update the search query off the typing hot path. Coalesces automatically:
  // fast keystrokes keep restarting the transition, so the list only settles
  // once typing slows — self-debouncing and fully interruptible.
  const setSearch = useCallback((v: string) => { startSearch(() => setQuery(v)); }, []);
  // Programmatic search changes (clear button, Escape, filter chips). The field
  // is uncontrolled, so we must push the text in imperatively, then update the
  // filter through the same transition.
  const applySearch = useCallback((v: string) => {
    const f = document.querySelector('.toolbar md-outlined-text-field') as (HTMLElement & { value: string }) | null;
    if (f) f.value = v;
    setSearch(v);
  }, [setSearch]);
  const [msgHits, setMsgHits] = useState<MessageHit[]>([]);
  const [selectedIssue, setSelectedIssue] = useState<{ roomId: string; issueId: string } | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  // Chat navigation history (browser-style). `navHistory` is the back-stack of
  // previously-opened chats; `forwardRoom` is the chat you most recently backed
  // away from, which the Next button then prioritises so Back/Next round-trip.
  const [navHistory, setNavHistory] = useState<string[]>([]);
  const [forwardRoom, setForwardRoom] = useState<string | null>(null);
  const prevSelectedRoomRef = useRef<string | null>(null);
  const backNavRef = useRef(false);
  // Track chat opens into the back-stack. Skip the push when we got here via the
  // Back button (it's a pop, not a new open); opening any OTHER chat clears the
  // forward target (a new branch).
  useEffect(() => {
    const prev = prevSelectedRoomRef.current;
    prevSelectedRoomRef.current = selectedRoom;
    if (backNavRef.current) { backNavRef.current = false; return; }
    if (selectedRoom && prev && prev !== selectedRoom) {
      setNavHistory((h) => (h[h.length - 1] === prev ? h : [...h, prev]));
      setForwardRoom((f) => (f === selectedRoom ? null : f));
    }
    if (!selectedRoom) { setNavHistory([]); setForwardRoom(null); }
  }, [selectedRoom]);
  const goBackChat = useCallback(() => {
    if (navHistory.length === 0) return;
    const prev = navHistory[navHistory.length - 1];
    backNavRef.current = true;
    setForwardRoom(selectedRoom);
    setNavHistory((h) => h.slice(0, -1));
    setSelectedRoom(prev);
  }, [navHistory, selectedRoom]);
  // Bumped when a room opens/closes so the inbox re-derives which rooms have an
  // unsent composer draft (drafts are written to localStorage by RoomPanel; the
  // same tab gets no storage event, so we recompute on this signal).
  const [draftTick, setDraftTick] = useState(0);
  // Thread overlay: a RoomPanel layered on top of the room, filtered to one
  // thread (root event). Closing returns to the room.
  const [openThread, setOpenThread] = useState<{ roomId: string; rootId: string } | null>(null);
  // Close the thread overlay if its room is no longer the open one.
  useEffect(() => {
    setOpenThread((t) => (t && t.roomId === selectedRoom ? t : null));
  }, [selectedRoom]);
  const [cursor, setCursor] = useState(0);
  // Read-state filter for messages: unread-only (default), read-only, or all.
  const [readFilter, setReadFilter] = useState<'unread' | 'read' | 'all'>('unread');
  const [snoozePopoverFor, setSnoozePopoverFor] = useState<string | null>(null);
  const [actionSheetFor, setActionSheetFor] = useState<string | null>(null);
  const [issueStatusFilter, setIssueStatusFilter] = useState<Set<string>>(new Set());
  // When on, hide tasks not assigned to me (matched on any schema user field).
  const [mineOnly, setMineOnly] = useState(false);
  // Per-bundle status/mine/read overrides, keyed by bundle node key. The global
  // issueStatusFilter/mineOnly/readFilter above stay scoped to the All-view
  // section headers; an opened bundle's chips tune only its own entry here, so
  // filtering one space no longer affects another (or the top view). Each field
  // defaults to the global value when a bundle has no override, so unset bundles
  // behave exactly as before.
  const [bundleFilters, setBundleFilters] = useState<Record<string, { status?: Set<string>; mine?: boolean; read?: 'unread' | 'read' | 'all' }>>({});
  // Bundled-stream view: which bundles are folded open (accordion).
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(new Set());
  // The config bundle (settings + accounts) at the top of the stream.
  const [configOpen, setConfigOpen] = useState(false);
  // Search compose helper (predicate chips under the search box).
  const [composerOpen, setComposerOpen] = useState(false);
  // Bundle-level bulk-action sheet (keyed by bundle key).
  const [bundleActionFor, setBundleActionFor] = useState<string | null>(null);
  const [bundleSnoozeFor, setBundleSnoozeFor] = useState<string | null>(null);
  // Optional JMAP mail source, multiplexed into the inbox alongside Matrix.
  const [jmapSrc] = useState<JmapSource | null>(() => JmapSource.tryRestore());
  const [jmapLoginOpen, setJmapLoginOpen] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<{ userId: string; roomId?: string } | null>(null);
  const [roomSettings, setRoomSettings] = useState<string | null>(null);
  const [membersRoom, setMembersRoom] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const jmapEmail = loadJmapCreds()?.email ?? loadJmapCreds()?.sessionUrl ?? null;
  // User-authored bundles (saved filters), and the create/edit sheet.
  const [manualBundles, setManualBundles] = useState<ManualBundle[]>([]);
  const [hiddenBundles, setHiddenBundles] = useState<string[]>([]);
  const [pinnedBundleKeys, setPinnedBundleKeys] = useState<string[]>([]);
  const [bundleSheet, setBundleSheet] = useState<{ editing?: ManualBundle; initialQuery?: string } | null>(null);
  // Manual bundles set to "Expanded" open by default. Seeded when bundles load;
  // the user can still collapse them for the session.
  useEffect(() => {
    const wantOpen = manualBundles.filter((b) => b.display === 'expanded').map((b) => `manual:${b.id}`);
    if (wantOpen.length) setExpandedBundles((prev) => new Set([...prev, ...wantOpen]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualBundles]);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newCallOpen, setNewCallOpen] = useState(false);
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [doneValuesOpen, setDoneValuesOpen] = useState(false);
  const [encryptionOpen, setEncryptionOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [callRoom, setCallRoom] = useState<{ roomId: string; name: string } | null>(null);
  const [widgetRoom, setWidgetRoom] = useState<{ roomId: string; name: string } | null>(null);
  const [incomingCalls, setIncomingCalls] = useState<IncomingCall[]>([]);
  const [ringtoneOn, setRingtoneOn] = useState(getRingtoneEnabled());
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [slots] = useState<string[]>(() => listSlots());
  const activeSlot = getActiveSlot();
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [cryptoStatus, setCryptoStatus] = useState<'none' | 'setup' | 'unverified' | 'verified'>('none');
  const [hasEncRoom, setHasEncRoom] = useState(false);
  const [cryptoPersistent, setCryptoPersistent] = useState(true);
  // Refresh ticker: bumped every 60s so snoozed items re-evaluate
  // around their due time without an explicit per-snooze timer.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRefreshTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const matrixSrc = matrix.kind === 'syncing' || matrix.kind === 'ready' ? matrix.source : null;
  const selfMxid = matrixSrc?.id ?? null;


  useEffect(() => {
    if (!matrixSrc) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await matrixSrc.getCryptoStatus();
        if (!cancelled) setCryptoStatus(s);
        if (!cancelled) setHasEncRoom(matrixSrc.hasAnyEncryptedRoom());
        if (!cancelled) setCryptoPersistent(matrixSrc.isCryptoPersistent());
      } catch { /* swallow */ }
    };
    void refresh();
    const unsub = matrixSrc.subscribe(() => void refresh());
    return () => { cancelled = true; unsub(); };
  }, [matrixSrc]);

  // Track incoming calls (active call in a joined room we haven't joined).
  useEffect(() => {
    if (!matrixSrc) { setIncomingCalls([]); return; }
    setIncomingCalls(matrixSrc.getIncomingCalls());
    const unsub = matrixSrc.subscribe(() => setIncomingCalls(matrixSrc.getIncomingCalls()));
    return unsub;
  }, [matrixSrc]);

  // Ring while there's an incoming call (if the ringtone is enabled).
  useEffect(() => {
    if (incomingCalls.length > 0 && ringtoneOn) startRinging();
    else stopRinging();
    return () => stopRinging();
  }, [incomingCalls.length, ringtoneOn]);

  useEffect(() => {
    let cancelled = false;
    if (!matrixSrc) {
      setItems([]); setLoading(false);
      return;
    }
    const refresh = () => {
      if (!cancelled) setSyncing(!matrixSrc.isInitialSyncComplete());
      // Merge Matrix items with JMAP mail items (if a mail account is
      // connected). JMAP items get the shared triage overlay so pin/snooze/
      // unread work across sources. Sort by priority desc, then ts desc.
      (async () => {
        const matrixItems = await matrixSrc.listItems(null);
        let all = matrixItems;
        if (jmapSrc) {
          try {
            const ji = matrixSrc.applyExternalTriage(await jmapSrc.listItems(null));
            all = [...matrixItems, ...ji];
            const mb = await jmapSrc.listBundles();
            if (!cancelled) setMailBundles(mb);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[wukkiemail] jmap listItems failed', e);
          }
        }
        if (cancelled) return;
        const sorted = all.slice().sort((a, b) => (b.priority - a.priority) || (b.ts - a.ts));
        // While the initial sync is still running the SDK store may briefly
        // report zero rooms (rehydrating from IndexedDB). Don't blow away the
        // cached list we're already showing — that's what made the inbox flash
        // empty (and get covered by the "Syncing…" notice) right after it had
        // loaded instantly from cache. Keep the cache until real data lands or
        // the sync completes; the bottom banner signals work-in-progress.
        if (sorted.length === 0 && !matrixSrc.isInitialSyncComplete()) {
          setLoading(false);
          return;
        }
        setItems(sorted);
        saveCachedItems(sorted);
        setLoading(false);
      })().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] listItems failed', e);
        if (!cancelled) setLoading(false);
      });
      matrixSrc.listBundles().then((bs) => { if (!cancelled) setSpaceBundles(bs); });
      if (!cancelled) setSpaceTree(matrixSrc.getSpaceTree());
      if (!cancelled) setManualBundles(matrixSrc.getManualBundles());
      if (!cancelled) setHiddenBundles(matrixSrc.getHiddenBundles());
      if (!cancelled) setPinnedBundleKeys(matrixSrc.getPinnedBundleKeys());
    };
    refresh();
    let pending = false;
    const onChange = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; refresh(); });
    };
    const unsub = matrixSrc.subscribe(onChange);
    // Start the JMAP source (idempotent enough — start() re-fetches session)
    // and refresh when it signals changes.
    let unsubJmap: (() => void) | undefined;
    if (jmapSrc) {
      jmapSrc.start().then(() => { if (!cancelled) refresh(); }).catch((e) => console.warn('[wukkiemail] jmap start failed', e));
      unsubJmap = jmapSrc.subscribe(onChange);
    }
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
    return () => { cancelled = true; unsub(); unsubJmap?.(); clearInterval(poller); };
  }, [matrixSrc, jmapSrc, refreshTick]);

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
  // Re-derive draft badges whenever a room opens or closes (a draft is most
  // likely written just before a room is left).
  useEffect(() => { setDraftTick((t) => t + 1); }, [selectedRoom]);

  // Full-text message search via the off-thread index, on the same filter
  // engine as everything else. Free-text + from: go to the worker (body /
  // sender); room-level predicates (is:/flavor:/status:/in:) post-filter the
  // hits against live items. Debounced; cleared when there's nothing to run.
  useEffect(() => {
    const f = parseQuery(query);
    if (!matrixSrc || (f.text.length === 0 && f.from.length === 0)) { setMsgHits([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      matrixSrc.searchMessages({ text: f.text, from: f.from }, 100)
        .then((hits) => {
          if (cancelled) return;
          const roomFilter = { ...EMPTY_FILTER, is: f.is, flavor: f.flavor, status: f.status, inBundle: f.inBundle };
          const itemByRoom = new Map(items.filter((i) => i.flavor !== 'issue').map((i) => [i.id, i]));
          const constrained = isEmptyFilter(roomFilter)
            ? hits
            : hits.filter((h) => {
              // jmap hits carry their item id (jmap:<emailId>) as roomId;
              // matrix hits carry a bare room id we prefix to the item id.
              const it = itemByRoom.get(h.roomId.startsWith('jmap:') ? h.roomId : `matrix:${h.roomId}`);
              return it ? matchItem(roomFilter, it, { selfMxid }) : false;
            });
          setMsgHits(constrained.slice(0, 50));
        })
        .catch(() => { if (!cancelled) setMsgHits([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, matrixSrc, items, selfMxid]);

  // Android back / browser back closes the topmost modal-ish layer
  // instead of leaving the SPA. Each open pushes a history state; popstate
  // dispatches based on priority: action sheet > new task > settings >
  // issue panel > room panel > sidebar drawer.
  // Note: the room/issue/email content panels are NOT in this cascade — they
  // live in the URL hash (see hash routing below) so a refresh restores them
  // and browser back/forward navigate them. This cascade is for sheets only.
  const anyModalOpen = !!actionSheetFor || !!bundleActionFor || newTaskOpen || newDmOpen || newGroupOpen || newCallOpen || settingsOpen || doneValuesOpen || encryptionOpen || devicesOpen || addAccountOpen || jmapLoginOpen || !!bundleSheet || composeOpen;
  useEffect(() => {
    if (anyModalOpen) {
      history.pushState({ wukkieModal: true }, '');
      const onPop = () => {
        if (actionSheetFor) setActionSheetFor(null);
        else if (bundleActionFor) setBundleActionFor(null);
        else if (newTaskOpen) setNewTaskOpen(false);
        else if (newDmOpen) setNewDmOpen(false);
        else if (newGroupOpen) setNewGroupOpen(false);
        else if (newCallOpen) setNewCallOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (doneValuesOpen) setDoneValuesOpen(false);
        else if (encryptionOpen) setEncryptionOpen(false);
        else if (devicesOpen) setDevicesOpen(false);
        else if (addAccountOpen) setAddAccountOpen(false);
        else if (jmapLoginOpen) setJmapLoginOpen(false);
        else if (bundleSheet) setBundleSheet(null);
        else if (composeOpen) setComposeOpen(false);
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

  // Back-button parity for the profile / room-settings panels. They open ON TOP
  // of a room (which lives in the hash), so unlike room/issue/email they don't
  // change the URL — we just push a history entry on open and pop it on close,
  // exactly like the sheet cascade above. Hardware back / Escape / the close
  // button all collapse to one path: pop the entry → onPop closes the panel,
  // leaving the room beneath intact (same hash, so no hashchange fires).
  const panelOverlayOpen = !!selectedProfile || !!roomSettings || !!membersRoom;
  useEffect(() => {
    if (panelOverlayOpen) {
      history.pushState({ wukkiePanel: true }, '');
      // Close ALL panel overlays unconditionally — one history entry covers the
      // whole profile/settings/members stack, and they replace each other within
      // it, so popping collapses straight back to the room beneath.
      const onPop = () => { setRoomSettings(null); setSelectedProfile(null); setMembersRoom(null); };
      window.addEventListener('popstate', onPop);
      return () => {
        window.removeEventListener('popstate', onPop);
        if (history.state?.wukkiePanel) history.back();
      };
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOverlayOpen]);

  // Hash routing for the content panels (chat / task / mail). Opening one
  // writes the URL hash; a refresh restores it (RoomPanel/EmailView read from
  // the local IndexedDB cache, so it comes back instantly), and browser
  // back/forward navigate between inbox and an open panel.
  const applyHash = useCallback(() => {
    const h = window.location.hash.replace(/^#/, '');
    let m: RegExpMatchArray | null;
    if ((m = h.match(/^\/m\/([^/]+)\/issue\/(.+)$/))) {
      setSelectedIssue({ roomId: decodeURIComponent(m[1]), issueId: decodeURIComponent(m[2]) });
      setSelectedRoom(null); setSelectedEmail(null);
    } else if ((m = h.match(/^\/m\/([^/]+)$/))) {
      setSelectedRoom(decodeURIComponent(m[1])); setSelectedIssue(null); setSelectedEmail(null);
    } else if ((m = h.match(/^\/mail\/(.+)$/))) {
      setSelectedEmail(decodeURIComponent(m[1])); setSelectedRoom(null); setSelectedIssue(null);
    } else {
      setSelectedRoom(null); setSelectedIssue(null); setSelectedEmail(null);
    }
  }, []);
  useEffect(() => {
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [applyHash]);
  // Reflect panel state into the hash (without piling history entries when it
  // already matches; clearing uses replaceState so closing doesn't add one).
  useEffect(() => {
    const desired = selectedIssue
      ? `#/m/${encodeURIComponent(selectedIssue.roomId)}/issue/${encodeURIComponent(selectedIssue.issueId)}`
      : selectedRoom ? `#/m/${encodeURIComponent(selectedRoom)}`
      : selectedEmail ? `#/mail/${encodeURIComponent(selectedEmail)}`
      : '';
    const current = window.location.hash;
    if (desired === current) return;
    if (desired) window.location.hash = desired;
    else if (current && current !== '#') history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [selectedRoom, selectedIssue, selectedEmail]);

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

  // Scoped filter access. scopeKey === undefined → the global All-view section
  // state; a bundle node key → that bundle's own override (default: no filter,
  // independent of the global one). Defined BEFORE the visible/visibleStream/
  // bundled memos that call them — those memos run during render, so a later
  // declaration would be in the temporal dead zone (runtime crash).
  const EMPTY_STATUS: Set<string> = new Set();
  const scopedStatus = (key?: string): Set<string> =>
    key ? (bundleFilters[key]?.status ?? EMPTY_STATUS) : issueStatusFilter;
  const scopedMine = (key?: string): boolean =>
    key ? (bundleFilters[key]?.mine ?? false) : mineOnly;
  const setScopedStatus = (key: string | undefined, next: Set<string>) => {
    if (!key) { setIssueStatusFilter(next); return; }
    setBundleFilters((m) => ({ ...m, [key]: { ...m[key], status: next } }));
  };
  const toggleScopedStatus = (key: string | undefined, status: string) => {
    const next = new Set(scopedStatus(key));
    if (next.has(status)) next.delete(status); else next.add(status);
    setScopedStatus(key, next);
  };
  const setScopedMine = (key: string | undefined, val: boolean) => {
    if (!key) { setMineOnly(val); return; }
    setBundleFilters((m) => ({ ...m, [key]: { ...m[key], mine: val } }));
  };
  const scopedRead = (key?: string): 'unread' | 'read' | 'all' =>
    (key ? bundleFilters[key]?.read : undefined) ?? readFilter;
  const setScopedRead = (key: string | undefined, mode: 'unread' | 'read' | 'all') => {
    if (!key) { setReadFilter(mode); return; }
    setBundleFilters((m) => ({ ...m, [key]: { ...m[key], read: mode } }));
  };
  // Mirror of the old visible-time read rule, now applied per scope. Snoozed
  // items and issues are never read-filtered; while searching, the default
  // Unread mode must not hide read matches (so a read room is still findable).
  const passesRead = (it: InboxItem, mode: 'unread' | 'read' | 'all', searching: boolean): boolean => {
    if (it.bundles.includes('snoozed') || it.flavor === 'issue') return true;
    if (mode === 'unread' && !it.unread && !searching) return false;
    if (mode === 'read' && it.unread) return false;
    return true;
  };

  // Parse the search box through the shared filter system, so the box
  // understands is:unread / flavor:x / from: / status: / is:mine alongside
  // free text — the same predicates bundles will be built from.
  const parsedQuery = useMemo(() => parseQuery(query), [query]);
  const visible = useMemo(() => {
    const q = query.trim();
    return items.filter((it) => {
      const isSnoozed = it.bundles.includes('snoozed');
      // Read filter for messages; never for snoozed items (they live in the
      // Snoozed bundle regardless) or issues (no read receipts).
      // IMPORTANT: while searching, the default Unread filter must NOT hide
      // read matches — otherwise you can't find a read/quiet room (e.g. a VC
      // room) by name. So Unread only restricts when NOT searching; an explicit
      // Read filter still narrows to read in either mode.
      if (!isSnoozed && it.flavor !== 'issue') {
        if (readFilter === 'unread' && !it.unread && !q) return false;
        if (readFilter === 'read' && it.unread) return false;
      }
      // NOTE: task status + "Mine" are *display* filters applied per-bundle at
      // render time (displayFilter), so toggling them never makes a bundle and
      // its chips vanish.
      if (!q) return true;
      return matchItem(parsedQuery, it, { selfMxid });
    });
  }, [items, query, parsedQuery, readFilter, selfMxid]);

  // Read-INCLUSIVE counterpart, used only by the bundled accordion so each
  // bundle can apply its own read filter (the memo narrows per node, defaulting
  // to the global readFilter). `visible` above stays global-read-filtered for
  // keyboard nav, the flat search view and the empty check, so their behavior
  // is unchanged. Search filtering is identical; only the read step differs.
  const visibleStream = useMemo(() => {
    const q = query.trim();
    return items.filter((it) => {
      if (!q) return true;
      return matchItem(parsedQuery, it, { selfMxid });
    });
  }, [items, query, parsedQuery, selfMxid]);

  // Per-section/per-bundle display filter for tasks (status chips + Mine).
  // Applied at render so the controlling chips never vanish with their items.
  const displayFilter = (it: InboxItem, scopeKey?: string): boolean => {
    if (it.flavor !== 'issue') return true;
    const status = scopedStatus(scopeKey);
    if (status.size > 0 && !status.has(it.statusValue ?? '')) return false;
    if (scopedMine(scopeKey) && !issueAssignedToSelf(it.userValues, selfMxid)) return false;
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
  const itemById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  // Rooms with an unsent composer draft, for the inbox draft badge. Recomputed
  // when items change or a room closes (draftTick). Room-level drafts only
  // (thread drafts aren't badged). localStorage reads are cheap.
  const draftRooms = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      const r = itemRoomId(it.id);
      if (!r) continue;
      try { if (localStorage.getItem(`wukkiemail:draft:${r}`)) s.add(r); } catch { /* ignore */ }
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, draftTick]);

  // Source flavors actually present in the inbox (detected bridges + Matrix
  // + Tasks, and Mail once JMAP is wired) — drives the composer's source
  // chips so we never offer a filter for a source the user doesn't have.
  const presentFlavors = useMemo(
    () => [...new Set(items.map((it) => it.flavor))],
    [items],
  );

  // (Status-chip counts are computed per scope inside renderFilterChips from
  // the items actually in that section/bundle, so they're correct everywhere
  // and ignore the active status filter.)

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

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        const field = document.querySelector('.toolbar md-outlined-text-field') as HTMLElement | null;
        field?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (shortcutsOpen) { setShortcutsOpen(false); return; }
        // Any overlay sheet (settings, FAB sheets, action menus, …) closes on
        // Escape. Each open sheet pushed a history entry (see the modal cascade
        // effect), so history.back() runs that same tested onPop cascade and
        // dismisses the topmost one — keyboard parity with scrim-click / back.
        if (anyModalOpen) { e.preventDefault(); history.back(); return; }
        // Profile / room-settings open on top of a room — close them first, via
        // history.back() so the pushed entry is popped (the cascade's onPop does
        // the setState), keeping the back stack consistent with hardware back.
        if (panelOverlayOpen) { e.preventDefault(); history.back(); return; }
        if (openThread) { setOpenThread(null); return; }
        if (selectedIssue) { setSelectedIssue(null); return; }
        if (selectedRoom) { setSelectedRoom(null); return; }
        if (selectedEmail) { setSelectedEmail(null); return; }
        if (query) { applySearch(''); return; }
      }
      // When a chat / task / email panel or any modal is open, IT owns the
      // keyboard (RoomPanel drives its own arrow nav). Don't also move the
      // inbox cursor underneath.
      if (selectedRoom || selectedIssue || selectedEmail || openThread || anyModalOpen || selectedProfile || roomSettings || membersRoom) return;
      // Navigate over the ACTUALLY-RENDERED rows (the bundled view reorders
      // items and hides collapsed bundles, so the global `visible` order does
      // not match what's on screen). Cap on the rendered count, and resolve the
      // cursored item from the highlighted DOM row so the action always targets
      // exactly what's highlighted.
      // Unified cursor over ALL navigable rows — bundle/config HEADERS and
      // entries alike (every one carries data-nav + data-idx in render order),
      // so j/k/↑/↓ walk them the same way. A header resolves to no item.
      const renderedCount = document.querySelectorAll('[data-nav]').length;
      const cursorEl = (): Element | null => document.querySelector(`[data-nav][data-idx="${cursor}"]`);
      const cursoredItem = (): InboxItem | undefined => {
        const id = cursorEl()?.getAttribute('data-item-id');
        return id ? itemById.get(id) : undefined;
      };
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, Math.max(renderedCount - 1, 0)));
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        // On a bundle/config header, Enter folds it open/closed.
        const bundleKey = cursorEl()?.getAttribute('data-bundle-key');
        if (bundleKey) {
          e.preventDefault();
          if (bundleKey === '__config__') setConfigOpen((o) => !o);
          else toggleBundle(bundleKey);
          return;
        }
        const it = cursoredItem();
        if (!it) return;
        e.preventDefault();
        if (it.flavor === 'issue') {
          const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
          if (m) setSelectedIssue({ roomId: m[1], issueId: m[2] });
        } else if (it.id.startsWith('jmap:')) {
          setSelectedEmail(it.id.slice('jmap:'.length));
        } else {
          const m = it.id.match(/^matrix:(.+)$/);
          if (m) setSelectedRoom(m[1]);
        }
        return;
      }
      // Keyboard triage on the cursored row (Google-Inbox style):
      //   e = archive/done (mark message read, or mark a task done)
      //   u = toggle unread   s = snooze to tomorrow   p = pin/unpin
      const cur = cursoredItem();
      if (!cur || !matrixSrc) return;
      const issueM = cur.id.match(/^matrix:(.+):issue:(.+)$/);
      if (e.key === 'e') {
        e.preventDefault();
        if (issueM) { void matrixSrc.markIssueDone(issueM[1], issueM[2]); }
        else { const r = itemRoomId(cur.id); if (r) void matrixSrc.markRoomRead(r); void matrixSrc.setManuallyUnread(cur.id, false); }
        return;
      }
      if (e.key === 'u') { e.preventDefault(); void matrixSrc.setManuallyUnread(cur.id, !cur.unread); return; }
      if (e.key === 's') { e.preventDefault(); void matrixSrc.setSnoozed(cur.id, nextDayAt(9)); return; }
      if (e.key === 'p') { e.preventDefault(); void matrixSrc.setPinned(cur.id, !cur.bundles.includes('pinned')); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, cursor, query, selectedIssue, selectedRoom, selectedEmail, openThread, matrixSrc, shortcutsOpen, itemById, anyModalOpen, expandedBundles, selectedProfile, roomSettings, membersRoom]);

  useEffect(() => {
    const el = document.querySelector(`[data-nav][data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // Which bundle an item folds into when it isn't important enough to show
  // loose. Precedence: space (strongest grouping) → DM → flavor. (Manual
  // bundles will slot in ahead of these in a later step.)
  const primaryKey = (it: InboxItem): string => {
    const space = it.bundles.find((b) => b.startsWith('space:'));
    if (space) return space;
    if (it.bundles.includes('dm')) return 'dm';
    // JMAP mail groups by its mailbox (Inbox/Sent/Archive/…), nested under a
    // synthetic "Mail" parent below. An email can be in several mailboxes; pick
    // the first the server listed (stable per email). Mail with no mailbox falls
    // through to the flavor bundle.
    const mailbox = it.bundles.find((b) => b.startsWith('mailbox:'));
    if (mailbox) return mailbox;
    return `flavor:${it.flavor}`;
  };

  // The bundled stream for the All view: loose (important) items shown
  // directly; everything else grouped into fold-open bundles. Built on the
  // already-filtered `visible`, so search/read/status/mine still apply.
  // Manual bundles (saved filters) take precedence over auto-grouping and
  // always appear (even when empty) so they stay findable/editable.
  const bundled = useMemo(() => {
    // During an active search we render flat mode from `visible`, not from the
    // bundle tree — so don't pay the (expensive) tree build, sorting and space
    // resolution on every keystroke. This was the main cause of search lag on
    // large accounts.
    if (query.trim()) return { stream: [] as StreamEl[], loose: [] as InboxItem[], groups: [] as BundleNode[] };
    const topLevel = matrixSrc?.getWeights().topLevel ?? 5;
    const hiddenSet = new Set(hiddenBundles);
    const manualParsed = manualBundles.map((b) => ({ b, f: parseQuery(b.query) }));
    // A manual (saved-filter) bundle matching this item — or null. Manual
    // bundles are an EXPLICIT grouping, so they capture their matches even when
    // the item is high-priority; otherwise high-priority matches leaked into
    // the loose stream and the bundle (and its inline "Top section") rendered
    // empty.
    const matchManual = (it: InboxItem): string | null => {
      for (const { b, f } of manualParsed) {
        if (matchItem(f, it, { selfMxid })) return `manual:${b.id}`;
      }
      return null;
    };
    // Auto-grouping for non-manual items: primary key, or "Other" if hidden.
    const assignAuto = (it: InboxItem): string => {
      const k = primaryKey(it);
      return hiddenSet.has(k) ? 'other' : k;
    };
    const loose: InboxItem[] = [];
    const groups = new Map<string, InboxItem[]>();
    const pushTo = (k: string, it: InboxItem) => { const a = groups.get(k); if (a) a.push(it); else groups.set(k, [it]); };
    for (const it of visibleStream) {
      // Snoozed items wait in their own bottom bundle until they wake;
      // pinned items collect in a Pinned bundle at the top.
      if (it.bundles.includes('snoozed')) { pushTo('snoozed', it); continue; }
      if (it.bundles.includes('pinned')) { pushTo('pinned', it); continue; }
      // Manual bundles win over the loose/priority heuristic so they actually
      // collect their items (a Top-section bundle must, to show anything).
      const manualKey = matchManual(it);
      if (manualKey) { pushTo(manualKey, it); continue; }
      // Rooms whose only "unread" was filtered noise (membership/reactions/UTD —
      // already counted as read) collect into one quiet "only updates" fold
      // instead of scattering through the auto bundles. A manual bundle still
      // claims them first (above); the global read filter hides them in the
      // Unread view, so they only surface when browsing All.
      if (it.onlyUpdates) { pushTo('virtual:updates', it); continue; }
      if (it.priority >= topLevel) { loose.push(it); continue; }
      pushTo(assignAuto(it), it);
    }
    // Loose items are top-level (global) scope, so they use the global read
    // filter. Per-bundle read overrides are applied per node below via readF.
    const looseRead = loose.filter((it) => passesRead(it, readFilter, false));
    // Stable intra-priority order: coarse day-bucketed recency, then a fixed id
    // tiebreak. The old `(b.ts - a.ts)` used continuous wall-clock time, so EVERY
    // incoming event reshuffled the list (and would move the virtual-bundle fold
    // boundary) under the user. Day buckets keep recency meaningful while holding
    // order steady between days; the id tiebreak makes it fully deterministic.
    looseRead.sort(stableItemCmp);
    const sortItems = (xs: InboxItem[]) => xs.sort(stableItemCmp);
    const unreadOf = (xs: InboxItem[]) => xs.filter((g) => g.unread).length;
    // Narrow a group's items by that bundle's effective read filter (its own
    // override, or the global readFilter when unset). By defaulting to the
    // global value this reproduces the old visible-time filtering exactly.
    const readF = (key: string, xs: InboxItem[]) => xs.filter((it) => passesRead(it, scopedRead(key), false));

    // ── Phase 3: bundles as elements with a collective priority + nested folds ──
    // Collective priority = the max priority across a bundle's items and
    // descendants, so a bundle is ranked by its hottest member ("treat as one
    // element"). Used as the within-tier order in the unified sort below.
    const nodePriority = (n: BundleNode): number => {
      let p = -Infinity;
      for (const it of n.items) if (it.priority > p) p = it.priority;
      for (const c of n.children) { const cp = nodePriority(c); if (cp > p) p = cp; }
      return p;
    };
    // Fold a bundle's OWN quiet (read) rooms into a nested "N quiet" child when
    // there are enough (run-length hysteresis) — a busy space/flavour then shows
    // its active rooms and tucks the quiet tail into one collapsible line. This is
    // the in-chat event-fold, one level down.
    const foldQuietWithin = (parentKey: string, items: InboxItem[]): { active: InboxItem[]; quietChild: BundleNode | null } => {
      const quiet = items.filter(isQuietItem);
      if (quiet.length < QUIET_FOLD_MIN) return { active: items, quietChild: null };
      return {
        active: items.filter((it) => !isQuietItem(it)),
        quietChild: {
          key: `virtual:quiet:${parentKey}`,
          label: `${quiet.length} quiet`,
          flavor: 'matrix',
          items: quiet,
          unread: 0,
          count: quiet.length,
          children: [],
          virtual: true,
        },
      };
    };

    // Manual bundles are always present (even empty) and claim matching items
    // first (see matchManual). Their display position is by tier+priority like
    // any bundle now — there's no meaningful user order to preserve (no reorder
    // UI, and editing one moves it to the end of the array anyway).
    const manualList: BundleNode[] = manualBundles.map((b) => {
      const gItems = sortItems(readF(`manual:${b.id}`, groups.get(`manual:${b.id}`) ?? []));
      groups.delete(`manual:${b.id}`);
      return { key: `manual:${b.id}`, label: b.label, flavor: 'matrix', manual: b, items: gItems, unread: unreadOf(gItems), count: gItems.length, children: [] };
    });

    // Spaces nest: build parent→children from the tree, skipping hidden
    // spaces (their direct rooms already went to Other; their children
    // re-parent to the nearest visible ancestor). A space shows when it or a
    // descendant has items.
    const labelOf = new Map(spaceTree.map((s) => [s.id, s.label]));
    const parentMap = new Map(spaceTree.map((s) => [s.id, s.parentId]));
    const allSpaceIds = new Set(spaceTree.map((s) => s.id));
    const isHidden = (id: string) => hiddenSet.has(`space:${id}`);
    const effectiveParent = (id: string): string | null => {
      let p = parentMap.get(id) ?? null;
      while (p && (!allSpaceIds.has(p) || isHidden(p))) p = parentMap.get(p) ?? null;
      return p;
    };
    const childrenOf = new Map<string, string[]>();
    const roots: string[] = [];
    for (const s of spaceTree) {
      if (isHidden(s.id)) continue;
      const ep = effectiveParent(s.id);
      if (ep) { const arr = childrenOf.get(ep) ?? []; arr.push(s.id); childrenOf.set(ep, arr); }
      else { roots.push(s.id); }
    }
    const buildSpace = (id: string): BundleNode => {
      const directAll = sortItems(readF(`space:${id}`, groups.get(`space:${id}`) ?? []));
      groups.delete(`space:${id}`);
      const { active: direct, quietChild } = foldQuietWithin(`space:${id}`, directAll);
      const spaceChildren = (childrenOf.get(id) ?? []).map(buildSpace).filter((n) => n.count > 0);
      spaceChildren.sort((a, b) => (b.unread - a.unread) || (b.count - a.count) || a.label.localeCompare(b.label));
      // Child spaces first, then this space's own quiet fold at the bottom.
      const children = quietChild ? [...spaceChildren, quietChild] : spaceChildren;
      const unread = unreadOf(direct) + children.reduce((s, c) => s + c.unread, 0);
      const count = direct.length + children.reduce((s, c) => s + c.count, 0);
      return { key: `space:${id}`, label: labelOf.get(id) ?? id, flavor: 'matrix', items: direct, unread, count, children };
    };
    const spaceNodes = roots.map(buildSpace).filter((n) => n.count > 0);

    // Synthetic Pinned (top) and Snoozed (bottom) bundles.
    const pinnedItems = sortItems(readF('pinned', groups.get('pinned') ?? []));
    groups.delete('pinned');
    const snoozedItems = sortItems(readF('snoozed', groups.get('snoozed') ?? []));
    groups.delete('snoozed');
    // The "Other" bundle: items whose auto-bundle the user hid.
    const otherItems = sortItems(readF('other', groups.get('other') ?? []));
    groups.delete('other');
    // The "only updates" fold: rooms counted as read because their whole unread
    // window was filtered noise. Read filter hides them in the Unread view.
    const updatesItems = sortItems(readF('virtual:updates', groups.get('virtual:updates') ?? []));
    groups.delete('virtual:updates');

    // Mail mailboxes nest under a synthetic "Mail" parent, mirroring how rooms
    // nest under spaces. Each mailbox:<id> group becomes a child; mail with no
    // mailbox (the flavor:gmail group) sits as the parent's direct items.
    const mailLabelOf = new Map(mailBundles.map((m) => [m.id, m.label]));
    const mailboxNodes: BundleNode[] = [];
    for (const [key, gItems] of [...groups.entries()]) {
      if (!key.startsWith('mailbox:')) continue;
      groups.delete(key);
      const xs = sortItems(readF(key, gItems));
      if (xs.length === 0) continue; // read filter emptied this mailbox
      mailboxNodes.push({ key, label: mailLabelOf.get(key) ?? 'Mailbox', flavor: 'gmail', items: xs, unread: unreadOf(xs), count: xs.length, children: [] });
    }
    mailboxNodes.sort((a, b) => (b.unread - a.unread) || (b.count - a.count) || a.label.localeCompare(b.label));
    let mailNode: BundleNode | null = null;
    if (mailboxNodes.length > 0) {
      const looseMail = sortItems(readF('flavor:gmail', groups.get('flavor:gmail') ?? []));
      groups.delete('flavor:gmail');
      const unread = unreadOf(looseMail) + mailboxNodes.reduce((s, c) => s + c.unread, 0);
      const count = looseMail.length + mailboxNodes.reduce((s, c) => s + c.count, 0);
      mailNode = { key: 'flavor:gmail', label: 'Mail', flavor: 'gmail', items: looseMail, unread, count, children: mailboxNodes };
    }

    // Remaining groups (dm, flavor:X, orphan spaces) render flat. Apply the
    // per-bundle read filter and drop any the filter emptied.
    const flatAuto: BundleNode[] = [...groups.entries()].map(([key, gItems]) => {
      const xs = sortItems(readF(key, gItems));
      const { active, quietChild } = foldQuietWithin(key, xs);
      return {
        key,
        label: bundleLabel(key as BundleKey, [...spaceBundles, ...mailBundles]),
        flavor: (key.startsWith('flavor:') ? key.slice(7) : 'matrix') as ItemFlavor,
        items: active,
        unread: unreadOf(xs),
        count: xs.length,
        children: quietChild ? [quietChild] : [],
      };
    }).filter((n) => n.count > 0);

    const autoTop = [...spaceNodes, ...(mailNode ? [mailNode] : []), ...flatAuto];
    autoTop.sort((a, b) => (b.unread - a.unread) || (b.count - a.count) || a.label.localeCompare(b.label));

    const mkNode = (key: string, label: string, xs: InboxItem[]): BundleNode =>
      ({ key, label, flavor: 'matrix', items: xs, unread: unreadOf(xs), count: xs.length, children: [] });
    // Pinned pinned to the very top; Snoozed + Other to the bottom.
    const pinnedNode = pinnedItems.length > 0 ? mkNode('pinned', 'Pinned', pinnedItems) : null;
    const snoozedNode = snoozedItems.length > 0 ? mkNode('snoozed', 'Snoozed', snoozedItems) : null;
    // "Other" is itself an auto-synthesized bundle — mark it virtual for
    // consistency with the quiet/updates folds. It KEEPS its dedicated icon and
    // its fixed bottom placement: it holds bundles the user explicitly hid, so
    // de-emphasising it is intentional — folding it into the priority sort would
    // resurface exactly what they chose to bury.
    const otherNode = (otherItems.length > 0 || hiddenBundles.length > 0) ? { ...mkNode('other', 'Other', otherItems), virtual: true } : null;

    // Bundle-level pin: a pinned bundle floats to the top as a unit (its
    // items stay inside it), as opposed to per-item pinning which dissolves
    // members into the synthetic Pinned bundle above. Only manual/auto/space
    // bundles can be bundle-pinned; the synthetic pinned/snoozed/other can't.
    // ── Read-sink + virtual "quiet conversations" fold (experimental, phase 1) ──
    // Top-level rooms no longer sit unconditionally above every bundle: the fully
    // -read tail of the loose list folds into one collapsible virtual bundle that
    // sinks with the other read bundles, so when the top is all read the unread
    // bundles rise to where you're looking. Small quiet tails (< QUIET_FOLD_MIN)
    // stay inline rather than fold (run-length hysteresis, like the chat fold).
    const looseActive = looseRead.filter((it) => !isQuietItem(it));
    const looseQuiet = looseRead.filter((it) => isQuietItem(it));
    const fold = looseQuiet.length >= QUIET_FOLD_MIN;
    const looseVisible = fold ? looseActive : looseRead;
    const quietNode: BundleNode | null = fold
      ? {
        key: 'virtual:quiet',
        label: `${looseQuiet.length} quiet conversation${looseQuiet.length === 1 ? '' : 's'}`,
        flavor: 'matrix',
        items: looseQuiet,
        unread: 0,
        count: looseQuiet.length,
        children: [],
        virtual: true,
        priority: looseQuiet[0]?.priority,
      }
      : null;

    const updatesNode: BundleNode | null = updatesItems.length > 0
      ? {
        key: 'virtual:updates',
        label: `${updatesItems.length} room${updatesItems.length === 1 ? '' : 's'} with only updates`,
        flavor: 'matrix',
        items: updatesItems,
        unread: 0,
        count: updatesItems.length,
        children: [],
        virtual: true,
      }
      : null;

    const pinnedKeySet = new Set(pinnedBundleKeys);
    const middle = [...manualList, ...autoTop, ...(quietNode ? [quietNode] : []), ...(updatesNode ? [updatesNode] : [])].map((n) =>
      (pinnedKeySet.has(n.key) ? { ...n, pinned: true } : n));
    const pinnedMiddle = middle.filter((n) => n.pinned);
    const restMiddle = middle.filter((n) => !n.pinned);
    // Unified order (Approach A): individual loose rooms and bundles compete in
    // ONE stream instead of loose always sitting as a band above the bundles.
    // Primary key is the tier (any unread → above fully-read) for read-sink +
    // stability (a room rarely crosses it); within a tier, collective priority
    // (a bundle's hottest member vs a room's own priority), so a hot bundle can
    // outrank a quiet loose room and vice versa. Deterministic id/key tiebreak.
    const elTier = (el: StreamEl): number =>
      el.kind === 'room' ? (el.item.unread || el.item.invite ? 0 : 1) : (el.node.unread > 0 ? 0 : 1);
    const elPriority = (el: StreamEl): number =>
      el.kind === 'room' ? el.item.priority : nodePriority(el.node);
    const elKey = (el: StreamEl): string => (el.kind === 'room' ? el.item.id : el.node.key);
    const middleEls: StreamEl[] = [
      ...looseVisible.map((item): StreamEl => ({ kind: 'room', item })),
      ...restMiddle.map((node): StreamEl => ({ kind: 'bundle', node })),
    ];
    middleEls.sort((a, b) =>
      (elTier(a) - elTier(b))
      || (elPriority(b) - elPriority(a))
      || (elKey(a) < elKey(b) ? -1 : elKey(a) > elKey(b) ? 1 : 0));
    // Full top-to-bottom order: pinned (top), interleaved middle, Other/Snoozed
    // (bottom). `stream` drives the render AND nav; `groups` is kept for the
    // inline-manual top-section loop and the empty check (order there is moot).
    const stream: StreamEl[] = [
      ...(pinnedNode ? [{ kind: 'bundle', node: pinnedNode } as StreamEl] : []),
      ...pinnedMiddle.map((node): StreamEl => ({ kind: 'bundle', node })),
      ...middleEls,
      ...(otherNode ? [{ kind: 'bundle', node: otherNode } as StreamEl] : []),
      ...(snoozedNode ? [{ kind: 'bundle', node: snoozedNode } as StreamEl] : []),
    ];
    return {
      stream,
      loose: looseVisible,
      groups: [
        ...(pinnedNode ? [pinnedNode] : []),
        ...pinnedMiddle,
        ...restMiddle,
        ...(otherNode ? [otherNode] : []),
        ...(snoozedNode ? [snoozedNode] : []),
      ] as BundleNode[],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleStream, readFilter, bundleFilters, spaceBundles, mailBundles, spaceTree, matrixSrc, items, manualBundles, hiddenBundles, pinnedBundleKeys, selfMxid, query]);

  // Message rooms in the exact order they appear in the stream (loose, then
  // each bundle's items, recursing into nested spaces; Snoozed excluded).
  // Drives the chat "Next" button so it steps through the visible inbox.
  const roomNavOrder = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const push = (it: InboxItem) => {
      const r = itemRoomId(it.id);
      if (r && !seen.has(r)) { seen.add(r); ids.push(r); }
    };
    const walk = (nodes: BundleNode[]) => {
      for (const g of nodes) {
        if (g.key === 'snoozed') continue;
        for (const it of g.items) push(it);
        walk(g.children);
      }
    };
    // Walk the interleaved stream so nav order == render order.
    for (const el of bundled.stream) {
      if (el.kind === 'room') push(el.item);
      else walk([el.node]);
    }
    return ids;
  }, [bundled]);

  // The "Next" triage order: every unread chat, in the SAME top-to-bottom order
  // you see on screen. This is `roomNavOrder` (loose rows first, then each bundle
  // in render order, recursing into nested spaces) narrowed to unread — so the
  // Next button walks the layout you're looking at instead of hopping to whatever
  // bundle happens to hold the most unread. It also keeps Next consistent with
  // its plain-stream fallback (roomNavOrder[i+1]), which always used this order.
  const nextUnreadOrder = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const pushUnread = (it: InboxItem) => {
      if (!it.unread) return;
      // Skip rooms that are unread but would open to an EMPTY window: their unread
      // is only non-rendering events (state/reactions/redactions/UTD), so they
      // aren't useful "next unread" targets. Invites count (Accept/Decline UI);
      // non-chat items (unreadHasText undefined) are left as-is.
      if (it.unreadHasText === false && !it.invite) return;
      const r = itemRoomId(it.id);
      if (r && !seen.has(r)) { seen.add(r); ids.push(r); }
    };
    const walk = (nodes: BundleNode[]) => {
      for (const g of nodes) {
        if (g.key === 'snoozed') continue;
        for (const it of g.items) pushUnread(it);
        walk(g.children); // a bundle's own unread precede its children's, in layout order
      }
    };
    // Walk the interleaved stream so Next-unread order == render order.
    for (const el of bundled.stream) {
      if (el.kind === 'room') pushUnread(el.item);
      else walk([el.node]);
    }
    return ids;
  }, [bundled]);

  // One inbox row. Shared by the flat list, the loose section, and the
  // contents of an opened bundle. `idx` drives keyboard-cursor highlight.
  // `level` is the 1-based ARIA tree depth (loose/top rows are level 1; rows
  // inside a bundle are level depth+2 — see renderBundleNode). Rows are tree
  // LEAVES, so no aria-expanded; aria-selected mirrors the keyboard cursor.
  const renderItem = (it: InboxItem, idx: number, level = 1): React.ReactNode => {
    // Compose a clean spoken name for the treeitem so a screenreader reads one
    // sentence ("Unread. Project chat. from Alice. see you tomorrow. 3m")
    // instead of the fragmented avatar/badge/span pieces in DOM order.
    const draftRoom = itemRoomId(it.id);
    const hasDraft = !!draftRoom && draftRooms.has(draftRoom);
    const tsSpoken = it.snoozedUntil ? `snoozed until ${formatTs(it.snoozedUntil)}` : formatTs(it.ts);
    const ariaLabel = [
      it.unread ? 'Unread' : null,
      it.invite ? 'Invite' : it.joinable ? 'Joinable room' : null,
      it.subject || null,
      it.from && it.from !== it.subject ? `from ${it.from}` : null,
      it.snippet || null,
      tsSpoken || null,
      it.bundles.includes('pinned') ? 'pinned' : null,
      hasDraft ? 'has unsent draft' : null,
    ].filter(Boolean).join('. ');
    return (
    <a
      key={it.id}
      data-idx={idx}
      data-item-id={it.id}
      data-nav
      role="treeitem"
      aria-level={level}
      aria-selected={idx === cursor}
      aria-label={ariaLabel}
      className={`item ${idx === cursor ? 'cursor' : ''} ${it.unread ? 'unread' : ''} ${it.priority <= -1 ? 'dim' : ''} ${it.invite ? 'invite' : ''}`}
      href={it.openPath}
      onClick={(e) => {
        e.preventDefault();
        const jm = it.id.match(/^jmap:(.+)$/);
        if (jm) { setSelectedEmail(jm[1]); return; }
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
        {it.invite && <span className="invite-badge">Invite</span>}
        {it.joinable && <span className="invite-badge joinable-badge">Join</span>}
        {it.bundles.includes('pinned') && <span title="Pinned" style={{ marginRight: 4 }}>📌</span>}
        {hasDraft && (
          <span className="draft-badge" title="You have an unsent draft here">
            <span aria-hidden="true" className="material-symbols-outlined">edit_note</span>Draft
          </span>
        )}
        {it.subject}
        {showOrigin && it.originLabel && (
          <span className="origin-tag" title={it.accountId}>{it.originLabel}</span>
        )}
      </div>
      <div className="subj">
        <strong className="who">{it.from}</strong>
        <span className="snip">{it.snippet}</span>
      </div>
      <div className="ts">
        {it.snoozedUntil ? `↻ ${formatTs(it.snoozedUntil)}` : formatTs(it.ts)}
      </div>
      {matrixSrc && it.invite ? (
        // Pending invite: Accept / Decline take the place of the normal
        // pin / snooze / mark-read actions.
        <div className="invite-actions">
          <button
            type="button"
            className="invite-accept"
            title="Accept invite"
            onClick={async (e) => {
              e.preventDefault(); e.stopPropagation();
              const r = itemRoomId(it.id);
              if (!r) return;
              try { await matrixSrc.acceptInvite(r); setSelectedRoom(r); }
              catch (err) { console.warn('[wukkiemail] acceptInvite failed', err); }
            }}
          >
            <span aria-hidden="true" className="material-symbols-outlined">check</span> Accept
          </button>
          <button
            type="button"
            className="invite-decline"
            aria-label="Decline invite"
            title="Decline invite"
            onClick={async (e) => {
              e.preventDefault(); e.stopPropagation();
              const r = itemRoomId(it.id);
              if (!r) return;
              try { await matrixSrc.rejectInvite(r); }
              catch (err) { console.warn('[wukkiemail] rejectInvite failed', err); }
            }}
          >
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </div>
      ) : matrixSrc && it.joinable ? (
        // A room in a space we're in but haven't joined — one Join button.
        <div className="invite-actions">
          <button
            type="button"
            className="invite-accept"
            title="Join room"
            onClick={async (e) => {
              e.preventDefault(); e.stopPropagation();
              const r = itemRoomId(it.id);
              if (!r) return;
              try { await matrixSrc.acceptInvite(r); setSelectedRoom(r); }
              catch (err) { console.warn('[wukkiemail] join failed', err); }
            }}
          >
            <span aria-hidden="true" className="material-symbols-outlined">add</span> Join
          </button>
        </div>
      ) : matrixSrc && (
        <>
          <button
            type="button"
            className="item-kebab"
            aria-label="Actions"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setActionSheetFor(it.id); }}
          >
            <span aria-hidden="true" className="material-symbols-outlined">more_vert</span>
          </button>
          <ItemActions
            item={it}
            isPinned={it.bundles.includes('pinned')}
            snoozePopoverOpen={snoozePopoverFor === it.id}
            onTogglePin={async () => { await matrixSrc.setPinned(it.id, !it.bundles.includes('pinned')); }}
            onOpenSnoozePopover={() => setSnoozePopoverFor(snoozePopoverFor === it.id ? null : it.id)}
            onSnooze={async (untilMs) => { setSnoozePopoverFor(null); await matrixSrc.setSnoozed(it.id, untilMs); }}
            onDone={async () => {
              // A task is "done" by setting its kanban status; a message is
              // "done" by marking the room read.
              const im = it.id.match(/^matrix:(.+):issue:(.+)$/);
              if (im) { await matrixSrc.markIssueDone(im[1], im[2]); return; }
              const r = itemRoomId(it.id);
              if (r) await matrixSrc.markRoomRead(r);
              await matrixSrc.setManuallyUnread(it.id, false);
            }}
            onToggleUnread={async () => { await matrixSrc.setManuallyUnread(it.id, !it.unread); }}
          />
        </>
      )}
    </a>
    );
  };

  // The per-section / per-bundle filter controls. `scope` provides the sweep
  // targets and the available task statuses (with counts). `scopeKey` selects
  // whose filter state the chips drive: undefined for the global All-view
  // section headers, or a bundle node key for that bundle's own state. Status
  // counts come straight from `scope` so they're correct per-bundle and ignore
  // the active status filter (so a chip never hides the others).
  const renderFilterChips = (hasIssues: boolean, hasMessages: boolean, scope: InboxItem[], scopeKey?: string): React.ReactNode => {
    const status = scopedStatus(scopeKey);
    const mine = scopedMine(scopeKey);
    const statusCounts = new Map<string, number>();
    if (hasIssues) for (const it of scope) {
      if (it.flavor !== 'issue') continue;
      const k = it.statusValue ?? '';
      statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
    }
    return (
    <div className="section-filters">
      {hasIssues && (
        <>
          <button
            type="button"
            className={`mini-chip ${status.size === 0 ? 'active' : ''}`}
            onClick={() => setScopedStatus(scopeKey, new Set())}
          >All</button>
          {[...statusCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s, count]) => (
            <button
              key={s || '∅none'}
              type="button"
              className={`mini-chip ${status.has(s) ? 'active' : ''}`}
              onClick={() => toggleScopedStatus(scopeKey, s)}
            >
              {s || 'None'}
              <span className="chip-badge">{count}</span>
            </button>
          ))}
          {anyAssignableTasks && (
            <button
              type="button"
              className={`mini-chip ${mine ? 'active' : ''}`}
              title="Show only tasks assigned to me"
              onClick={() => setScopedMine(scopeKey, !mine)}
            >Mine</button>
          )}
        </>
      )}
      {hasMessages && (['unread', 'read', 'all'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={`mini-chip ${scopedRead(scopeKey) === mode ? 'active' : ''}`}
          onClick={() => setScopedRead(scopeKey, mode)}
        >{mode === 'unread' ? 'Unread' : mode === 'read' ? 'Read' : 'All'}</button>
      ))}
      {hasIssues && scope.some((t) => t.flavor === 'issue' && t.priority > -1) && (
        <button
          type="button"
          className="section-sweep"
          aria-label="Mark all tasks done"
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
          <span aria-hidden="true" className="material-symbols-outlined">done_all</span>
        </button>
      )}
      {hasMessages && scope.some((m) => m.flavor !== 'issue' && m.unread) && (
        <button
          type="button"
          className="section-sweep"
          aria-label="Mark all read"
          title="Mark all read"
          onClick={async () => {
            if (!matrixSrc) return;
            const unread = scope.filter((m) => m.flavor !== 'issue' && m.unread);
            if (!confirm(`Mark all ${unread.length} message${unread.length === 1 ? '' : 's'} read?`)) return;
            for (const it of unread) {
              const r = itemRoomId(it.id);
              if (r) await matrixSrc.markRoomRead(r);
              await matrixSrc.setManuallyUnread(it.id, false);
            }
          }}
        >
          <span aria-hidden="true" className="material-symbols-outlined">mark_chat_read</span>
        </button>
      )}
    </div>
    );
  };

  // Hide / restore / convert auto bundles. Hiding routes a default bundle's
  // items into "Other"; converting turns it into an editable manual filter.
  const hideBundle = async (key: string) => {
    if (!matrixSrc) return;
    const next = [...new Set([...hiddenBundles, key])];
    setHiddenBundles(next); setBundleActionFor(null);
    await matrixSrc.setHiddenBundles(next);
  };
  const restoreBundle = async (key: string) => {
    if (!matrixSrc) return;
    const next = hiddenBundles.filter((k) => k !== key);
    setHiddenBundles(next);
    await matrixSrc.setHiddenBundles(next);
  };
  const queryForBundleKey = (key: string): string => {
    if (key === 'dm') return 'is:dm';
    if (key.startsWith('flavor:')) return key;       // flavor:x is a valid query
    if (key.startsWith('space:')) return `in:${key}`; // in:space:!room matches item.bundles
    if (key.startsWith('mailbox:')) return `in:${key}`; // in:mailbox:<id> matches item.bundles
    return '';
  };
  const convertToManual = async (key: string, label: string) => {
    if (!matrixSrc) return;
    const query = queryForBundleKey(key);
    if (!query) return;
    const b: ManualBundle = { id: crypto.randomUUID(), label, query };
    const nextBundles = [...manualBundles, b];
    const nextHidden = [...new Set([...hiddenBundles, key])];
    setManualBundles(nextBundles); setHiddenBundles(nextHidden); setBundleActionFor(null);
    await matrixSrc.setManualBundles(nextBundles);
    await matrixSrc.setHiddenBundles(nextHidden);
    setBundleSheet({ editing: b });
  };

  // Toggle a bundle open/closed (lazy-loading a space's rooms on open).
  // Shared by the bundle-row click and the keyboard cursor's Enter so both
  // behave identically.
  const toggleBundle = (key: string) => {
    const opening = !expandedBundles.has(key);
    setExpandedBundles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (opening && matrixSrc && key.startsWith('space:')) {
      void matrixSrc.syncSpaceRooms(key.slice('space:'.length));
    }
  };

  // Render one bundle row (recursively for nested spaces). `counter` carries
  // the running keyboard-cursor index across loose items + all open bundles —
  // the bundle HEADER takes the next index too, so ↑/↓ walk headers and entries
  // uniformly.
  const renderBundleNode = (g: BundleNode, depth: number, counter: { n: number }): React.ReactNode => {
    const open = expandedBundles.has(g.key);
    const headIdx = counter.n++;
    // Clean spoken name for the bundle treeitem (collapsed/expanded comes from
    // aria-expanded, so it's not repeated here).
    const headLabel = `${g.label}, ${g.unread > 0 ? `${g.unread} unread, ` : ''}${g.count} ${g.count === 1 ? 'item' : 'items'}${g.pinned ? ', pinned' : ''}`;
    const toggle = () => toggleBundle(g.key);
    return (
      <div key={`b-${g.key}`} className={`bundle-row ${open ? 'open' : ''}`} style={depth ? { marginLeft: depth * 14 } : undefined}>
        <div className="bundle-headline">
          <button type="button" data-idx={headIdx} data-nav data-bundle-key={g.key} className={`bundle-head ${headIdx === cursor ? 'cursor' : ''}`} onClick={toggle} role="treeitem" aria-level={depth + 1} aria-expanded={open} aria-selected={headIdx === cursor} aria-label={headLabel}>
            <span aria-hidden="true" className="material-symbols-outlined bundle-chevron">{open ? 'expand_more' : 'chevron_right'}</span>
            {(() => {
              const ic = g.key === 'pinned' ? 'push_pin'
                : g.key === 'snoozed' ? 'schedule'
                : g.key === 'other' ? 'inbox'
                : g.virtual ? 'unfold_more'
                : g.manual ? 'bookmark'
                : g.children.length > 0 ? 'folder' : null;
              return ic
                ? <span aria-hidden="true" className="material-symbols-outlined" style={{ color: 'var(--muted)', fontSize: 18 }}>{ic}</span>
                : <span className={`src ${g.flavor}`} aria-hidden="true" />;
            })()}
            <span className="bundle-label">{g.label}</span>
            {g.pinned && (
              <span aria-hidden="true" className="material-symbols-outlined" title="Pinned bundle"
                style={{ color: 'var(--accent)', fontSize: 16 }}>push_pin</span>
            )}
            <span className="bundle-count">{g.unread > 0 ? `${g.unread} unread · ` : ''}{g.count}</span>
          </button>
          {matrixSrc && (
            <BundleActions
              node={g}
              issuesOnly={(() => { const xs = collectBundleItems(g); return xs.length > 0 && xs.every((i) => i.flavor === 'issue'); })()}
              snoozeOpen={bundleSnoozeFor === g.key}
              onTogglePin={async () => { await matrixSrc.setPinnedBundle(g.key, !g.pinned); }}
              onOpenSnooze={() => setBundleSnoozeFor(bundleSnoozeFor === g.key ? null : g.key)}
              onSnooze={async (untilMs) => { setBundleSnoozeFor(null); await matrixSrc.setSnoozedBatch(collectBundleItems(g).map((i) => i.id), untilMs); }}
              onMarkDone={async () => {
                // Operate on ALL items in the bundle, including nested spaces —
                // g.items is only the direct children, so a space bundle's rooms
                // (which live in g.children) were being missed entirely.
                const all = collectBundleItems(g);
                const msgs = all.filter((i) => i.flavor !== 'issue');
                for (const it of msgs) { const r = itemRoomId(it.id); if (r) await matrixSrc.markRoomRead(r); }
                await matrixSrc.setManuallyUnreadBatch(msgs.map((i) => i.id), false);
                for (const it of all.filter((i) => i.flavor === 'issue')) {
                  const m = it.id.match(/^matrix:(.+):issue:(.+)$/);
                  if (m) await matrixSrc.markIssueDone(m[1], m[2]);
                }
              }}
              onMarkUnread={async () => { await matrixSrc.setManuallyUnreadBatch(collectBundleItems(g).filter((i) => i.flavor !== 'issue').map((i) => i.id), true); }}
              onMore={() => setBundleActionFor(g.key)}
            />
          )}
          {matrixSrc && (
            <button type="button" className="item-kebab" aria-label="Bundle actions"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setBundleActionFor(g.key); }}>
              <span aria-hidden="true" className="material-symbols-outlined">more_vert</span>
            </button>
          )}
        </div>
        {open && (
          <div className="bundle-body" role="group">
            {g.key === 'other' && hiddenBundles.length > 0 && (
              <div className="restore-row">
                <span className="filter-group-label">Hidden bundles</span>
                {hiddenBundles.map((k) => (
                  <button key={k} type="button" className="mini-chip" title="Restore this bundle" onClick={() => void restoreBundle(k)}>
                    <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 14 }}>undo</span>
                    {bundleLabel(k as BundleKey, [...spaceBundles, ...mailBundles])}
                  </button>
                ))}
              </div>
            )}
            {g.items.length > 0 && renderFilterChips(
              g.items.some((x) => x.flavor === 'issue'),
              g.items.some((x) => x.flavor !== 'issue'),
              g.items,
              g.key,
            )}
            {g.items.filter((it) => displayFilter(it, g.key)).slice(0, 200).map((it) => renderItem(it, counter.n++, depth + 2))}
            {g.children.map((child) => renderBundleNode(child, depth + 1, counter))}
            {g.items.length === 0 && g.children.length === 0 && g.key !== 'other' && (
              <div className="empty" style={{ height: 'auto', padding: 16, fontSize: 13 }}>
                <p>Nothing matches this bundle right now.</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

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
              ref={fieldRef((v) => setSearch(v))}
              style={{ flex: 1 }}
            />
            {query && (
              <button
                type="button"
                className="hamburger"
                aria-label="Clear search"
                onClick={() => applySearch('')}
              >
                <span aria-hidden="true" className="material-symbols-outlined">close</span>
              </button>
            )}
            <button
              type="button"
              className={`hamburger ${composerOpen ? 'on' : ''}`}
              aria-label="Filter helper"
              aria-pressed={composerOpen}
              title="Filter helper"
              onClick={() => setComposerOpen((o) => !o)}
            >
              <span aria-hidden="true" className="material-symbols-outlined">tune</span>
            </button>
          </div>
          {composerOpen && (
            <div className="compose-bar">
              <QueryChips
                query={query}
                flavors={presentFlavors}
                onChange={(q) => applySearch(q)}
              />
            </div>
          )}
        </div>
        {matrixSrc && incomingCalls.length > 0 && (
          <div className="incoming-calls" role="region" aria-label="Incoming calls">
            {incomingCalls.map((c) => (
              <div key={c.roomId} className="incoming-call">
                <span className="incoming-call-ring material-symbols-outlined" aria-hidden="true">call</span>
                <div className="incoming-call-text">
                  <div className="incoming-call-title">Incoming call</div>
                  <div className="incoming-call-room">{c.roomName}</div>
                </div>
                <button
                  type="button"
                  className="incoming-call-accept"
                  onClick={() => { matrixSrc.setActiveCallRoom(c.roomId); setCallRoom({ roomId: c.roomId, name: c.roomName }); }}
                >
                  <span aria-hidden="true" className="material-symbols-outlined">call</span> Accept
                </button>
                <button
                  type="button"
                  className="incoming-call-decline"
                  aria-label="Decline call"
                  onClick={() => matrixSrc.dismissIncomingCall(c.roomId)}
                >
                  <span aria-hidden="true" className="material-symbols-outlined">call_end</span>
                </button>
              </div>
            ))}
          </div>
        )}
        {loading ? (
          <div className="empty">Loading…</div>
        ) : visible.length === 0 && msgHits.length === 0 ? (
          <div className="empty">
            {/* Show "Syncing" only while the SDK genuinely hasn't finished its
                initial sync AND has no rooms cached yet — so a reload doesn't
                flash "No items yet", but a fully-synced empty inbox still reads
                as empty (not stuck on "Syncing"). */}
            {syncing && matrixSrc && matrixSrc.describe().rooms === 0
              ? <p>Syncing your conversations…</p>
              : <p>{bundle === 'all' ? 'No items yet.' : `No items in ${bundleLabel(bundle, [...spaceBundles, ...mailBundles])}.`}</p>}
          </div>
        ) : (
          <div className="item-list" role="tree" aria-label="Inbox" aria-multiselectable="false">
            {(() => {
              const rendered: React.ReactNode[] = [];
              let idx = 0;
              const isBundled = bundle === 'all' && !query.trim();

              if (isBundled) {
                // Config bundle at the very top — folds open to settings +
                // accounts (the sidebar's non-space controls live here now).
                rendered.push(
                  <div key="b-config" className={`bundle-row config-bundle ${configOpen ? 'open' : ''}`}>
                    <button type="button" data-idx={0} data-nav data-bundle-key="__config__" className={`bundle-head ${cursor === 0 ? 'cursor' : ''}`} onClick={() => setConfigOpen((o) => !o)} role="treeitem" aria-level={1} aria-expanded={configOpen} aria-selected={cursor === 0}
                      aria-label={`Settings and accounts${cryptoStatus !== 'verified' && hasEncRoom ? ', encryption needs attention' : ''}`}>
                      <span aria-hidden="true" className="material-symbols-outlined bundle-chevron">
                        {configOpen ? 'expand_more' : 'chevron_right'}
                      </span>
                      <span aria-hidden="true" className="material-symbols-outlined" style={{ color: 'var(--muted)' }}>settings</span>
                      <span className="bundle-label">Settings &amp; accounts</span>
                      {cryptoStatus !== 'verified' && hasEncRoom && (
                        <span className="bundle-count" style={{ color: 'var(--md-sys-color-primary)' }}>encryption ●</span>
                      )}
                    </button>
                    {configOpen && (
                      <div className="bundle-body config-body" role="group">
                        {matrixSrc && cryptoStatus !== 'verified' && (
                          <div className="encryption-block">
                            <div className="encryption-block-head">
                              <span aria-hidden="true" className="material-symbols-outlined">{cryptoStatus === 'none' ? 'lock' : 'lock_open'}</span>
                              <strong>{cryptoStatus === 'none' ? 'Set up encryption' : 'Verify this device'}</strong>
                            </div>
                            <p className="encryption-block-sub">
                              {hasEncRoom
                                ? 'You have encrypted chats this device can’t read yet. Verify to decrypt history.'
                                : 'Verify this device for end-to-end encrypted chats.'}
                            </p>
                            {!cryptoPersistent && (
                              <p className="encryption-block-sub" style={{ fontWeight: 600 }}>
                                ⚠ This device can’t store keys (IndexedDB unavailable), so you’ll need to verify again
                                each reload. Try turning on Lite storage below — it keeps the small key store while
                                skipping the big sync database.
                              </p>
                            )}
                            <EncryptionSetup matrix={matrixSrc} />
                          </div>
                        )}
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
                        {matrixSrc && <button type="button" className="config-btn" onClick={() => setEncryptionOpen(true)}>Encryption &amp; key backup…</button>}
                        {matrixSrc && <button type="button" className="config-btn" onClick={() => setDevicesOpen(true)}>Devices…</button>}
                        <button type="button" className="config-btn" onClick={() => {
                          const v = window.prompt('Call URL template. {roomId} and {roomName} are substituted. Default is the Wally Conference guest page (standalone LiveKit, no login).', getCallTemplate());
                          if (v !== null) { setCallTemplate(v); }
                        }}>Call link: {getCallTemplate() === DEFAULT_CALL_TEMPLATE ? 'Wally Conference (default)' : 'custom'}</button>
                        <button type="button" className="config-btn" onClick={() => {
                          const v = window.prompt('Call SFU — lk-jwt-service URL for in-app calls (only needed if your homeserver doesn’t advertise rtc_foci in .well-known). e.g. https://livekit-jwt.example.com', getSfuServiceUrl());
                          if (v !== null) { setSfuServiceUrl(v); }
                        }}>Call SFU: {getSfuServiceUrl() ? 'set' : 'auto-discover'}</button>
                        <button type="button" className="config-btn" onClick={() => { const v = !ringtoneOn; setRingtoneEnabled(v); setRingtoneOn(v); }}>
                          Incoming-call ringtone: {ringtoneOn ? 'on' : 'off'}
                        </button>
                        <button type="button" className="config-btn" onClick={() => setSettingsOpen(true)}>Priority tuning…</button>
                        <button type="button" className="config-btn" onClick={() => setDoneValuesOpen(true)}>Task "done" statuses…</button>
                        {jmapSrc
                          ? <button type="button" className="config-btn" onClick={() => { if (confirm('Disconnect this mail account?')) { clearJmapCreds(); window.location.reload(); } }}>Mail: {jmapEmail} — disconnect</button>
                          : <button type="button" className="config-btn" onClick={() => setJmapLoginOpen(true)}>Connect mail (JMAP)…</button>}
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
                        <button
                          type="button"
                          className="config-btn"
                          title="Keep the large sync data in memory instead of the local database, while still persisting the small encryption key store. Helps on devices where the local database is broken or fills up; tradeoff is a fuller resync on each load."
                          onClick={() => { setLiteStorage(!isLiteStorage()); window.location.reload(); }}
                        >
                          Lite storage: {isLiteStorage() ? 'on' : 'off'}
                          {matrixSrc && (cryptoStatus !== 'none')
                            ? ` · keys ${cryptoPersistent ? 'persist ✓' : 'in-memory ✗'}`
                            : ''}
                        </button>
                        <button
                          type="button"
                          className="config-btn"
                          title="Sliding sync streams a growing window of rooms (scales to huge accounts). Classic /sync downloads everything at once (can hang on very large accounts). Switch to Classic only if sliding sync misbehaves."
                          onClick={() => { setClassicSync(!isClassicSync()); window.location.reload(); }}
                        >
                          Sync: {isClassicSync() ? 'classic /sync' : 'sliding (auto)'}
                        </button>
                        <button
                          type="button"
                          className="config-btn"
                          title="Clear the local cache and re-download all rooms from the server. Use this if rooms are missing from the inbox."
                          onClick={() => {
                            if (!confirm('Force a full resync? This clears the local cache and re-downloads all your rooms from the server. Use this if rooms are missing.')) return;
                            const p = new URLSearchParams(window.location.search);
                            p.set('reset', '1');
                            window.location.search = p.toString();
                          }}
                        >
                          Force full resync (fix missing rooms)
                        </button>
                        <button type="button" className="config-btn" onClick={onSignOut}>Sign out</button>
                      </div>
                    )}
                  </div>,
                );
                // Index 0 is the config-bundle header pushed above; entries +
                // bundle headers continue from 1 so the cursor walks them all.
                const counter = { n: 1 };
                // "Top section" manual bundles: their items render directly at
                // the top (like Pinned). The bundle row still appears below in
                // the group list, so they also show as part of the bundle.
                for (const g of bundled.groups) {
                  if (g.manual?.display !== 'inline') continue;
                  const its = collectBundleItems(g).filter((it) => displayFilter(it, g.key));
                  if (its.length === 0) continue;
                  rendered.push(
                    <div key={`inline-h-${g.key}`} className="section-header">
                      <span className="section-header-label">{g.label}</span>
                      <span className="bundle-count">{its.length}</span>
                    </div>,
                  );
                  for (const it of its) rendered.push(renderItem(it, counter.n++));
                }
                // Interleaved stream: individual loose rooms and bundles in one
                // tier+priority order (rooms render as rows, bundles fold in place).
                for (const el of bundled.stream) {
                  if (el.kind === 'room') {
                    if (displayFilter(el.item)) rendered.push(renderItem(el.item, counter.n++));
                  } else {
                    rendered.push(renderBundleNode(el.node, 0, counter));
                  }
                }
                idx = counter.n;
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
                {msgHits.map((hit) => {
                  const mailId = hit.roomId.startsWith('jmap:') ? hit.roomId.slice('jmap:'.length) : null;
                  return (
                    <a
                      key={hit.id}
                      className="item msg-hit"
                      href={mailId ? `/mail/${encodeURIComponent(mailId)}` : `/m/${encodeURIComponent(hit.roomId)}`}
                      onClick={(e) => { e.preventDefault(); if (mailId) setSelectedEmail(mailId); else setSelectedRoom(hit.roomId); }}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      <Avatar name={hit.sender} flavor={mailId ? 'gmail' : 'matrix'} />
                      <div className="from">{hit.roomName}</div>
                      <div className="subj">{hit.body}</div>
                      <div className="ts">{formatTs(hit.ts)}</div>
                    </a>
                  );
                })}
              </>
            )}
          </div>
        )}
        {syncing && !loading && (
          <div className="sync-banner" role="status" aria-live="polite">
            <span className="sync-banner-spinner" aria-hidden="true" />
            <span>Syncing your conversations…</span>
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
      {selectedRoom && matrixSrc && (() => {
        // "Next" walks every unread chat in triage order (top-level first,
        // then bundles by how many unread they hold). Step FORWARD from the
        // current room's position so it advances through the whole list rather
        // than ping-ponging on the top unread (which happens if opening a room
        // doesn't immediately clear its unread). When the current room is no
        // longer unread we resume from the top of the remaining unread; once
        // nothing is unread we fall back to plain stream order.
        const itemOf = (rid: string) => items.find((x) => x.id === `matrix:${rid}`);
        const unreadOf = (rid: string) => itemOf(rid)?.unreadCount ?? 0;
        const uIdx = nextUnreadOrder.indexOf(selectedRoom);
        const remainingUnread = uIdx >= 0 ? nextUnreadOrder.slice(uIdx + 1) : nextUnreadOrder;
        const nextUnread = remainingUnread.find((rid) => rid !== selectedRoom);
        // Stay within the CURRENT bundle while triaging: prefer the next unread
        // chat in the same bundle as the open chat before jumping to another
        // bundle. Keeps you working through one space/DM/flavour at a time.
        const curBundle = (() => { const cur = itemOf(selectedRoom); return cur ? primaryKey(cur) : undefined; })();
        const bundleUnread = curBundle
          ? nextUnreadOrder.filter((rid) => { const it = itemOf(rid); return it && primaryKey(it) === curBundle; })
          : [];
        const bIdx = bundleUnread.indexOf(selectedRoom);
        const nextInBundle = (bIdx >= 0 ? bundleUnread.slice(bIdx + 1) : bundleUnread).find((rid) => rid !== selectedRoom);
        const i = roomNavOrder.indexOf(selectedRoom);
        // Prefer the chat you backed away from (so Back→Next round-trips), then
        // the next unread IN THE CURRENT BUNDLE, then any next unread, then plain
        // stream order.
        const nextRoom = (forwardRoom && forwardRoom !== selectedRoom ? forwardRoom : undefined)
          ?? nextInBundle ?? nextUnread ?? (i >= 0 ? roomNavOrder[i + 1] : roomNavOrder[0]);
        const nextItem = nextRoom ? items.find((x) => x.id === `matrix:${nextRoom}`) : undefined;
        const nextCount = nextRoom ? unreadOf(nextRoom) : 0;
        const nextLabel = nextItem
          ? (nextCount > 0 ? `${nextItem.subject} · ${nextCount} unread` : nextItem.subject)
          : undefined;
        const backRoom = navHistory[navHistory.length - 1];
        const backItem = backRoom ? items.find((x) => x.id === `matrix:${backRoom}`) : undefined;
        return (
          <RoomPanel
            matrix={matrixSrc}
            roomId={selectedRoom}
            onClose={() => setSelectedRoom(null)}
            onBack={backRoom ? goBackChat : undefined}
            backLabel={backItem?.subject}
            nextLabel={nextLabel}
            onNext={nextRoom ? () => setSelectedRoom(nextRoom) : undefined}
            onStartCall={matrixSrc.canStartCall(selectedRoom) ? (name) => setCallRoom({ roomId: selectedRoom, name }) : undefined}
            onOpenWidgets={(matrixSrc.getRoomWidgets(selectedRoom).length > 0 || matrixSrc.canManageWidgets(selectedRoom)) ? (name) => setWidgetRoom({ roomId: selectedRoom, name }) : undefined}
            onOpenThread={(rootId) => setOpenThread({ roomId: selectedRoom, rootId })}
            onOpenProfile={(uid) => setSelectedProfile({ userId: uid, roomId: selectedRoom })}
            onOpenSettings={() => setRoomSettings(selectedRoom)}
            incomingCall={incomingCalls[0]}
            onPickUp={(rid, name) => { matrixSrc.setActiveCallRoom(rid); setCallRoom({ roomId: rid, name }); }}
          />
        );
      })()}
      {openThread && matrixSrc && (
        <RoomPanel
          matrix={matrixSrc}
          roomId={openThread.roomId}
          threadRootId={openThread.rootId}
          onClose={() => setOpenThread(null)}
        />
      )}
      {callRoom && matrixSrc && (
        <CallView matrix={matrixSrc} roomId={callRoom.roomId} roomName={callRoom.name} onClose={() => setCallRoom(null)} />
      )}
      {widgetRoom && matrixSrc && (
        <WidgetPanel matrix={matrixSrc} roomId={widgetRoom.roomId} roomName={widgetRoom.name} onClose={() => setWidgetRoom(null)} />
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
      {devicesOpen && matrixSrc && (
        <DevicesSheet matrix={matrixSrc} onClose={() => setDevicesOpen(false)} />
      )}
      {matrixSrc && bundleActionFor && (() => {
        const g = bundled.groups.find((x) => x.key === bundleActionFor);
        if (!g) return null;
        const allItems = collectBundleItems(g);
        const msgs = allItems.filter((i) => i.flavor !== 'issue');
        const tasks = allItems.filter((i) => i.flavor === 'issue');
        const roomId = (id: string) => itemRoomId(id) ?? undefined;
        const close = () => setBundleActionFor(null);
        const canPinBundle = !['pinned', 'snoozed', 'other'].includes(g.key);
        return (
          <div className="sheet-scrim" onClick={close}>
            <div className="action-sheet" role="dialog" aria-modal="true" aria-label="Actions" onClick={(e) => e.stopPropagation()}>
              <div className="action-sheet-title">{g.label} — {allItems.length} item{allItems.length === 1 ? '' : 's'}</div>
              {msgs.length > 0 && (
                <button onClick={async () => {
                  // Read receipts are per-room API calls (safe to loop); the
                  // manuallyUnread clear is one batched account-data write.
                  for (const it of msgs) { const r = roomId(it.id); if (r) await matrixSrc.markRoomRead(r); }
                  await matrixSrc.setManuallyUnreadBatch(msgs.map((i) => i.id), false);
                  close();
                }}>
                  <span aria-hidden="true" className="material-symbols-outlined">mark_chat_read</span>
                  Mark all read
                </button>
              )}
              {msgs.length > 0 && (
                <button onClick={async () => { await matrixSrc.setManuallyUnreadBatch(msgs.map((i) => i.id), true); close(); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">mark_email_unread</span>
                  Mark all unread
                </button>
              )}
              {tasks.length > 0 && (
                <button onClick={async () => { for (const it of tasks) { const m = it.id.match(/^matrix:(.+):issue:(.+)$/); if (m) await matrixSrc.markIssueDone(m[1], m[2]); } close(); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">done_all</span>
                  Mark all tasks done
                </button>
              )}
              {canPinBundle && (
                <button onClick={async () => { await matrixSrc.setPinnedBundle(g.key, !g.pinned); close(); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">{g.pinned ? 'push_pin' : 'keep'}</span>
                  {g.pinned ? 'Unpin bundle' : 'Pin bundle to top'}
                </button>
              )}
              {g.key === 'snoozed' ? (
                <button onClick={async () => { await matrixSrc.setSnoozedBatch(allItems.map((i) => i.id), null); close(); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">alarm_off</span>
                  Unsnooze all
                </button>
              ) : (
                <>
                  <button onClick={async () => { await matrixSrc.setSnoozedBatch(allItems.map((i) => i.id), nextHourOfDay(20)); close(); }}>
                    <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
                    Snooze all until this evening
                  </button>
                  <button onClick={async () => { await matrixSrc.setSnoozedBatch(allItems.map((i) => i.id), nextDayAt(9)); close(); }}>
                    <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
                    Snooze all until tomorrow
                  </button>
                </>
              )}
              {g.manual && (
                <button onClick={() => { setBundleActionFor(null); setBundleSheet({ editing: g.manual }); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">edit</span>
                  Edit bundle
                </button>
              )}
              {!g.manual && !['other', 'pinned', 'snoozed'].includes(g.key) && (
                <button onClick={() => void convertToManual(g.key, g.label)}>
                  <span aria-hidden="true" className="material-symbols-outlined">tune</span>
                  Make editable (convert to filter)
                </button>
              )}
              {!g.manual && !['other', 'pinned', 'snoozed'].includes(g.key) && (
                <button onClick={() => void hideBundle(g.key)}>
                  <span aria-hidden="true" className="material-symbols-outlined">visibility_off</span>
                  Hide this bundle (move to Other)
                </button>
              )}
            </div>
          </div>
        );
      })()}
      {matrixSrc && <VerificationSheet matrix={matrixSrc} />}
      {jmapLoginOpen && (
        <JmapLoginSheet
          onClose={() => setJmapLoginOpen(false)}
          onConnected={() => window.location.reload()}
        />
      )}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
      {selectedEmail && jmapSrc && (
        <EmailView jmap={jmapSrc} emailId={selectedEmail} onClose={() => setSelectedEmail(null)} />
      )}
      {selectedProfile && matrixSrc && (
        <ProfilePage
          matrix={matrixSrc}
          userId={selectedProfile.userId}
          roomId={selectedProfile.roomId}
          onClose={() => setSelectedProfile(null)}
          onOpenRoom={(rid) => { setSelectedProfile(null); setSelectedRoom(rid); }}
        />
      )}
      {roomSettings && matrixSrc && (
        <RoomSettings
          matrix={matrixSrc}
          roomId={roomSettings}
          onClose={() => setRoomSettings(null)}
          onLeft={() => { setRoomSettings(null); setSelectedRoom(null); }}
          onOpenMembers={() => { const r = roomSettings; setRoomSettings(null); setMembersRoom(r); }}
        />
      )}
      {membersRoom && matrixSrc && (
        <MembersPage
          matrix={matrixSrc}
          roomId={membersRoom}
          onClose={() => setMembersRoom(null)}
          onOpenProfile={(uid) => { const r = membersRoom; setMembersRoom(null); setSelectedProfile({ userId: uid, roomId: r ?? undefined }); }}
        />
      )}
      {composeOpen && jmapSrc && (
        <ComposeSheet jmap={jmapSrc} onClose={() => setComposeOpen(false)} />
      )}
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
      {newCallOpen && matrixSrc && (
        <NewCallRoomSheet
          matrix={matrixSrc}
          onClose={() => setNewCallOpen(false)}
          onCreated={(roomId, name) => { setNewCallOpen(false); setSelectedRoom(roomId); setCallRoom({ roomId, name }); }}
        />
      )}
      {matrixSrc && actionSheetFor && (() => {
        const target = items.find((x) => x.id === actionSheetFor);
        if (!target) return null;
        const isPinned = target.bundles.includes('pinned');
        const isSnoozed = target.bundles.includes('snoozed');
        return (
          <div className="sheet-scrim" onClick={() => setActionSheetFor(null)}>
            <div className="action-sheet" role="dialog" aria-modal="true" aria-label="Actions" onClick={(e) => e.stopPropagation()}>
              <div className="action-sheet-title">{target.from} — {target.subject}</div>
              <button onClick={async () => { await matrixSrc.setPinned(target.id, !isPinned); setActionSheetFor(null); }}>
                <span aria-hidden="true" className="material-symbols-outlined">{isPinned ? 'push_pin' : 'keep'}</span>
                {isPinned ? 'Unpin' : 'Pin'}
              </button>
              <button onClick={async () => { await matrixSrc.setSnoozed(target.id, nextHourOfDay(20)); setActionSheetFor(null); }}>
                <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
                Snooze until this evening
              </button>
              <button onClick={async () => { await matrixSrc.setSnoozed(target.id, nextDayAt(9)); setActionSheetFor(null); }}>
                <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
                Snooze until tomorrow 9am
              </button>
              <button onClick={async () => { await matrixSrc.setSnoozed(target.id, nextDayAt(9, 7)); setActionSheetFor(null); }}>
                <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
                Snooze for a week
              </button>
              {isSnoozed && (
                <button onClick={async () => { await matrixSrc.setSnoozed(target.id, null); setActionSheetFor(null); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">alarm_off</span>
                  Unsnooze
                </button>
              )}
              <button onClick={async () => { await matrixSrc.setManuallyUnread(target.id, !target.unread); setActionSheetFor(null); }}>
                <span aria-hidden="true" className="material-symbols-outlined">{target.unread ? 'mark_email_read' : 'mark_email_unread'}</span>
                {target.unread ? 'Mark read' : 'Mark unread'}
              </button>
              <button onClick={async () => {
                const r = itemRoomId(target.id);
                if (r) await matrixSrc.markRoomRead(r);
                await matrixSrc.setManuallyUnread(target.id, false);
                setActionSheetFor(null);
              }}>
                <span aria-hidden="true" className="material-symbols-outlined">done_all</span>
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
                <span aria-hidden="true" className="material-symbols-outlined">check_box</span>
                New task
              </button>
              <button type="button" onClick={() => { setFabMenuOpen(false); setNewDmOpen(true); }}>
                <span aria-hidden="true" className="material-symbols-outlined">person_add</span>
                New DM
              </button>
              <button type="button" onClick={() => { setFabMenuOpen(false); setNewGroupOpen(true); }}>
                <span aria-hidden="true" className="material-symbols-outlined">group_add</span>
                New group
              </button>
              <button type="button" onClick={() => { setFabMenuOpen(false); setNewCallOpen(true); }}>
                <span aria-hidden="true" className="material-symbols-outlined">video_call</span>
                New call room
              </button>
              {jmapSrc && (
                <button type="button" onClick={() => { setFabMenuOpen(false); setComposeOpen(true); }}>
                  <span aria-hidden="true" className="material-symbols-outlined">mail</span>
                  New mail
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="fab"
            aria-label={fabMenuOpen ? 'Close menu' : 'New…'}
            onClick={() => setFabMenuOpen((o) => !o)}
          >
            <span aria-hidden="true" className="material-symbols-outlined">{fabMenuOpen ? 'close' : 'add'}</span>
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
  const isSnoozed = item.bundles.includes('snoozed');
  return (
    <div className="item-actions" onClick={stop}>
      <button type="button" title={isPinned ? 'Unpin' : 'Pin'} onClick={(e) => { stop(e); onTogglePin(); }}>
        <span aria-hidden="true" className="material-symbols-outlined">{isPinned ? 'push_pin' : 'keep'}</span>
      </button>
      {/* Snoozed items get a one-click unsnooze; the schedule button still
          opens the chooser for re-scheduling. */}
      {isSnoozed && (
        <button type="button" title="Unsnooze" onClick={(e) => { stop(e); onSnooze(null); }}>
          <span aria-hidden="true" className="material-symbols-outlined">alarm_off</span>
        </button>
      )}
      <div style={{ position: 'relative' }}>
        <button type="button" title={isSnoozed ? 'Reschedule snooze' : 'Snooze'} onClick={(e) => { stop(e); onOpenSnoozePopover(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
        </button>
        {snoozePopoverOpen && (
          <SnoozeMenu snoozed={isSnoozed} currentUntil={item.snoozedUntil} onSnooze={onSnooze} />
        )}
      </div>
      {item.flavor === 'issue' ? (
        // Issues are "done".
        <button type="button" title="Mark done" onClick={(e) => { stop(e); onDone(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">done_all</span>
        </button>
      ) : item.unread ? (
        // Messages are "read".
        <button type="button" title="Mark read" onClick={(e) => { stop(e); onDone(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">mark_chat_read</span>
        </button>
      ) : (
        // Already read: the only useful toggle is back to unread.
        <button type="button" title="Mark unread" onClick={(e) => { stop(e); onToggleUnread(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">mark_chat_unread</span>
        </button>
      )}
    </div>
  );
}

// Inline hover actions for a bundle row — the bundle-level mirror of
// ItemActions. Same look and reveal-on-hover; the operations are batched
// (pin the bundle as a unit, snooze/mark-done all members at once).
function BundleActions({
  node, issuesOnly, snoozeOpen, onTogglePin, onOpenSnooze, onSnooze, onMarkDone, onMarkUnread, onMore,
}: {
  node: BundleNode;
  issuesOnly: boolean;   // bundle holds only issues → "done" wording; else messages → "read"
  snoozeOpen: boolean;
  onTogglePin: () => void;
  onOpenSnooze: () => void;
  onSnooze: (untilMs: number | null) => void;
  onMarkDone: () => void;
  onMarkUnread: () => void;
  onMore: () => void;
}) {
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const canPin = !['pinned', 'snoozed', 'other'].includes(node.key);
  return (
    <div className="item-actions bundle-actions" onClick={stop}>
      {canPin && (
        <button type="button" title={node.pinned ? 'Unpin bundle' : 'Pin bundle to top'} onClick={(e) => { stop(e); onTogglePin(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">{node.pinned ? 'push_pin' : 'keep'}</span>
        </button>
      )}
      {node.key === 'snoozed' ? (
        // Everything here is already snoozed — the only useful action is to
        // wake it, so skip the full snooze menu and unsnooze directly.
        <button type="button" title="Unsnooze all" onClick={(e) => { stop(e); onSnooze(null); }}>
          <span aria-hidden="true" className="material-symbols-outlined">alarm_off</span>
        </button>
      ) : (
        <div style={{ position: 'relative' }}>
          <button type="button" title="Snooze all" onClick={(e) => { stop(e); onOpenSnooze(); }}>
            <span aria-hidden="true" className="material-symbols-outlined">schedule</span>
          </button>
          {snoozeOpen && (
            <SnoozeMenu snoozed={false} allLabel onSnooze={onSnooze} />
          )}
        </div>
      )}
      {node.unread > 0 ? (
        // Issues are "done"; messages are "read".
        <button type="button" title={issuesOnly ? 'Mark all done' : 'Mark all read'} onClick={(e) => { stop(e); onMarkDone(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">{issuesOnly ? 'done_all' : 'mark_chat_read'}</span>
        </button>
      ) : (
        <button type="button" title="Mark all unread" onClick={(e) => { stop(e); onMarkUnread(); }}>
          <span aria-hidden="true" className="material-symbols-outlined">mark_chat_unread</span>
        </button>
      )}
      <button type="button" title="More actions" onClick={(e) => { stop(e); onMore(); }}>
        <span aria-hidden="true" className="material-symbols-outlined">more_horiz</span>
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
// Upcoming Saturday at `hour` (today if it's already the weekend before then).
function nextWeekendAt(hour: number): number {
  const d = new Date();
  const day = d.getDay(); // 0 Sun … 6 Sat
  let add = (6 - day + 7) % 7; // days until Saturday
  if (add === 0 && d.getHours() >= hour) add = 7;
  d.setDate(d.getDate() + add);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}
// Format a ms-epoch for a datetime-local input's value (local, no tz suffix).
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Shared snooze chooser: presets + a custom date/time, and (when already
// snoozed) a prominent unsnooze. Used by both ItemActions and BundleActions.
function SnoozeMenu({ snoozed, onSnooze, currentUntil, allLabel }: {
  snoozed: boolean;
  onSnooze: (untilMs: number | null) => void;
  currentUntil?: number;
  allLabel?: boolean;
}) {
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const [custom, setCustom] = useState(() => toDatetimeLocal(currentUntil ?? nextDayAt(9)));
  const opt = (label: string, ms: number) => (
    <button type="button" onClick={(e) => { stop(e); onSnooze(ms); }}>{label}</button>
  );
  const commitCustom = (e: React.MouseEvent) => {
    stop(e);
    const t = new Date(custom).getTime();
    if (!isNaN(t) && t > Date.now()) onSnooze(t);
  };
  return (
    <div className="snooze-popover" onClick={stop}>
      {opt('In 1 hour', Date.now() + 3600_000)}
      {opt('In 3 hours', Date.now() + 3 * 3600_000)}
      {opt('This evening', nextHourOfDay(20))}
      {opt('Tomorrow 9am', nextDayAt(9))}
      {opt('This weekend', nextWeekendAt(9))}
      {opt('Next week', nextDayAt(9, 7))}
      <div className="snooze-custom" onClick={stop}>
        <input
          type="datetime-local"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onClick={stop}
        />
        <button type="button" className="snooze-custom-go" onClick={commitCustom}>Snooze until…</button>
      </div>
      {snoozed && (
        <button type="button" className="snooze-unsnooze" onClick={(e) => { stop(e); onSnooze(null); }}>
          <span aria-hidden="true" className="material-symbols-outlined">alarm_off</span>
          {allLabel ? 'Unsnooze all' : 'Unsnooze'}
        </button>
      )}
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
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New DM" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>New DM</div>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Person</span>
            <PersonPicker
              matrix={matrix}
              value={mxid ? [mxid] : []}
              onChange={(ids) => setMxid(ids[0] ?? '')}
              autoFocus
              placeholder="Search people or type @friend:server"
            />
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
  const [invites, setInvites] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try { onCreated(await matrix.createGroup(name.trim(), invites)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New group" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
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
            <PersonPicker
              matrix={matrix}
              multi
              value={invites}
              onChange={setInvites}
              placeholder="Search people or type @user:server"
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

// Keyboard-shortcut legend, toggled with "?". Read-only reference so the
// keyboard triage (e/u/s/p, j/k, etc.) is discoverable.
function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['j / ↓', 'Next item'],
    ['k / ↑', 'Previous item'],
    ['Enter', 'Open the selected item'],
    ['e', 'Archive — mark message read, or task done'],
    ['u', 'Toggle unread'],
    ['s', 'Snooze to tomorrow 9am'],
    ['p', 'Pin / unpin'],
    ['/', 'Search'],
    ['?', 'This help'],
    ['Esc', 'Close / clear search'],
  ];
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>Keyboard shortcuts</div>
        </header>
        <div className="sheet-body">
          <table className="shortcuts-table">
            <tbody>
              {rows.map(([k, d]) => (
                <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function NewCallRoomSheet({ matrix, onClose, onCreated }: { matrix: import('./sources/matrix').MatrixSource; onClose: () => void; onCreated: (roomId: string, name: string) => void }) {
  const [name, setName] = useState('');
  const [video, setVideo] = useState(true);
  const [invites, setInvites] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try { onCreated(await matrix.createCallRoom(name.trim(), video, invites), name.trim()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New call room" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
          <div style={{ flex: 1, fontWeight: 500, fontSize: 18 }}>New call room</div>
        </header>
        <div className="sheet-body">
          <label className="sheet-label">
            <span>Name</span>
            <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={video ? 'Video room' : 'Voice room'} />
          </label>
          <label className="sheet-label">
            <span>Kind</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className={`chip ${video ? 'active' : ''}`} onClick={() => setVideo(true)}>
                <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: 'middle' }}>videocam</span> Video
              </button>
              <button type="button" className={`chip ${!video ? 'active' : ''}`} onClick={() => setVideo(false)}>
                <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 16, verticalAlign: 'middle' }}>call</span> Voice
              </button>
            </div>
            <span className="hint">A persistent call room anyone in it can join. {video ? 'Camera on by default.' : 'Audio-only by default.'}</span>
          </label>
          <label className="sheet-label">
            <span>Invite (optional)</span>
            <PersonPicker
              matrix={matrix}
              multi
              value={invites}
              onChange={setInvites}
              placeholder="Search people or type @user:server"
            />
          </label>
          {error && <p style={{ color: 'var(--md-sys-color-error)', fontSize: 13 }}>{error}</p>}
          <button type="button" className="sheet-submit" onClick={() => void submit()} disabled={!name.trim() || busy} style={{ justifySelf: 'end' }}>
            {busy ? 'Creating…' : `Create ${video ? 'video' : 'voice'} room`}
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
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Add account" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <button type="button" className="hamburger" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
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
  // No usable timestamp (a room we've only seen via state with no dated event)
  // → render nothing rather than "Invalid Date" / a 1970 date.
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
