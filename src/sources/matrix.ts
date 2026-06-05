// MatrixSource — adapts a logged-in matrix-js-sdk client to the InboxItem contract.
//
// v0 behavior:
//   - Start the client with a minimal sync (no crypto).
//   - One bundle per Matrix space the user is in, plus "Inbox" for the rest.
//   - One InboxItem per room, sorted by most recent activity.
//   - Bridges detected via mxid pattern (see ./bridges).
//   - eu.kiefte.issue rooms get one extra synthetic item ("N open issues").
//
// We deliberately avoid persisting an indexeddb store yet — startup needs
// to be observable end-to-end before we add caching layers.

import type { MatrixClient, Room } from 'matrix-js-sdk';
import { ClientEvent, MatrixEvent, MatrixEventEvent, NotificationCountType, PendingEventOrdering, RoomEvent } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent.js';
import { MatrixRTCSessionManagerEvents } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSessionManager.js';
import { MatrixRTCSessionEvent, type MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js';
import { SlidingSync, SlidingSyncEvent } from 'matrix-js-sdk/lib/sliding-sync.js';
import {
  VerifierEvent, VerificationPhase, VerificationRequestEvent,
  type Verifier, type VerificationRequest, type ShowSasCallbacks, type EmojiMapping,
} from 'matrix-js-sdk/lib/crypto-api/verification.js';
import { buildClient, loadCreds, isClassicSync, type MatrixCreds } from '../auth/matrix';
import { storePrivateKey } from '../auth/secretStorageKeys';
import { flavorForRoomMembers } from './bridges';
import { SearchIndex, type MessageDoc, type MessageHit } from '../search';
import { decryptAttachment, type EncryptedFile } from '../media';
import type { BundleSpec, InboxItem, Source } from './types';

const ISSUE_EVENT = 'eu.kiefte.issue';
const ISSUE_SCHEMA_EVENT = 'eu.kiefte.issues.schema';
const TRIAGE_EVENT_TYPE = 'eu.kiefte.wukkiemail.triage';
const VIEWS_EVENT_TYPE = 'eu.kiefte.wukkiemail.views';
const BUNDLES_EVENT_TYPE = 'eu.kiefte.wukkiemail.bundles';
const WEIGHTS_EVENT_TYPE = 'eu.kiefte.wukkiemail.weights';

export interface PriorityWeights {
  unread: number;     // any unread bump
  mention: number;    // highlight (mention/keyword)
  recent: number;     // <24h
  dm: number;
  bridgeChat: number; // bridged group chat penalty (subtracted)
  bot: number;        // bot-y sender penalty (subtracted)
  topLevel: number;   // priority at/above which an item shows loose at the top level instead of folding into a bundle
  doneStatuses: string[]; // issue status values that count as "done" and sink
  // Per-event-category overrides keyed by eventCategory() (message/image/
  // membership/…). weight is added to the room's priority; hidden drops the
  // row entirely (unless pinned). Both optional, default 0 / false.
  eventTypeAdjust?: Record<string, { weight?: number; hidden?: boolean }>;
}

export const DEFAULT_WEIGHTS: PriorityWeights = {
  unread: 3,
  mention: 5,
  recent: 1,
  dm: 2,
  bridgeChat: 2,
  bot: 1,
  topLevel: 5,
  doneStatuses: ['Done', 'Closed', 'Resolved'],
  eventTypeAdjust: {},
};

export interface TriageState {
  pinned: string[];
  snoozed: Record<string, number>;
  manuallyUnread: string[]; // items the user flagged unread even if server says read
  doneValuesByRoom?: Record<string, string[]>; // per-room override of which kanban status counts as done
}

export interface SavedView {
  id: string;       // stable across renames
  name: string;
  bundle: string;   // 'all' | 'dm' | 'flavor:<f>' | 'space:<id>' | 'snoozed'
  query?: string;
  issueStatus?: string;
  showRead?: boolean; // legacy: true == show read+unread. Superseded by readFilter.
  readFilter?: 'unread' | 'read' | 'all';
}
// A user-authored bundle: a named filter query. The query is interpreted
// by the shared filter system (src/filter.ts), so bundles == saved filters.
export interface ManualBundle {
  id: string;
  label: string;
  query: string;
  // How the bundle presents in the All view:
  //   'folded'   — collapsed row (default)
  //   'expanded' — row open by default
  //   'inline'   — items promoted into the main stream as a top section
  //                (like Pinned); the bundle row still appears too.
  display?: 'folded' | 'expanded' | 'inline';
}

const EMPTY_TRIAGE: TriageState = { pinned: [], snoozed: {}, manuallyUnread: [] };

// Human-friendly fallback for last-event snippets when there's no body.
// Used by roomToItem for non-text events. Keep this lossy and short —
// the inbox row only has room for one line.
function humanizeEventType(type: string, msgtype?: string, content?: { membership?: string }): string {
  if (type === 'm.room.encrypted') return '🔒 (encrypted)';
  if (type === 'm.sticker') return '🏷️ sticker';
  if (type === 'm.room.member') {
    const m = content?.membership;
    if (m === 'join') return 'joined';
    if (m === 'leave') return 'left';
    if (m === 'invite') return 'invited';
    if (m === 'ban') return 'banned';
    return 'member change';
  }
  if (type === 'm.room.name') return 'changed room name';
  if (type === 'm.room.topic') return 'changed topic';
  if (type === 'm.room.avatar') return 'changed avatar';
  if (type === 'm.call.invite' || type === 'm.call.member') return '📞 call';
  if (type === 'm.room.message') {
    switch (msgtype) {
      case 'm.image': return '🖼️ image';
      case 'm.video': return '🎥 video';
      case 'm.audio': return '🎵 audio';
      case 'm.file': return '📎 file';
      case 'm.location': return '📍 location';
      case 'm.notice': return 'notice';
      case 'm.emote': return 'emote';
      default: return msgtype ? `[${msgtype}]` : '[message]';
    }
  }
  return `[${type}]`;
}

// Coarse buckets for the latest event in a room, so the user can tune
// priority and visibility per kind (e.g. sink join/leave noise, hide
// stickers). Keep the set small and human — one row per bucket in
// Settings. Keyed by stable string; labels drive the UI.
export const EVENT_CATEGORY_LABELS: Record<string, string> = {
  message: 'Messages',
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  file: 'Files',
  location: 'Locations',
  sticker: 'Stickers',
  encrypted: 'Encrypted',
  membership: 'Joins / leaves',
  roomstate: 'Room changes',
  call: 'Calls',
  other: 'Other events',
};

export function eventCategory(type: string, msgtype?: string): string {
  if (type === 'm.room.message') {
    switch (msgtype) {
      case 'm.image': return 'image';
      case 'm.video': return 'video';
      case 'm.audio': return 'audio';
      case 'm.file': return 'file';
      case 'm.location': return 'location';
      default: return 'message'; // text / notice / emote
    }
  }
  if (type === 'm.sticker') return 'sticker';
  if (type === 'm.room.encrypted') return 'encrypted';
  if (type === 'm.room.member') return 'membership';
  // Issue-tracker activity (eu.kiefte.issue and friends) — its own category so
  // it's tunable/hideable in By-event-type, and a trailing issue event in a DM
  // doesn't define the row (it then counts as hidden and the real message wins).
  if (type === 'eu.kiefte.issue' || type.startsWith('eu.kiefte.issue')) return 'issue';
  if (type === 'm.room.name' || type === 'm.room.topic' || type === 'm.room.avatar') return 'roomstate';
  // Call/VC membership and signalling. The MSC3401/MSC4143 call-member state
  // events don't share the m.call prefix, so match them explicitly — otherwise
  // they fell through to 'other' and hiding "call" never caught them, leaving a
  // "[org.matrix.msc3401.call.member]" snippet defining a room.
  if (
    type.startsWith('m.call')
    || type.startsWith('org.matrix.msc3401.call')
    || type === 'm.rtc.member'
    || type === 'org.matrix.msc3401.call.member'
  ) return 'call';
  return 'other';
}

function reactionKey(eventId: string, key: string): string {
  return `${eventId}\u0000${key}`;
}

function readImageDimensions(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export interface PersonHit { userId: string; name: string; avatarUrl?: string }

export interface DeviceEntry {
  deviceId: string;
  displayName: string;
  lastSeenTs?: number;
  lastSeenIp?: string;
  isCurrent: boolean;
  verified: boolean;
}

export interface SchemaField {
  key: string;
  type: 'text' | 'enum' | 'user' | 'date' | 'follow';
  label: string;
  kanban_group?: boolean;
  values?: string[];
}
export interface IssueSchema { fields: SchemaField[]; }

const DEFAULT_SCHEMA: IssueSchema = {
  fields: [
    { key: 'title', type: 'text', label: 'Title' },
    { key: 'status', type: 'enum', label: 'Status', kanban_group: true, values: ['Backlog', 'To Do', 'In Progress', 'Done'] },
    { key: 'priority', type: 'enum', label: 'Priority', values: ['Low', 'Medium', 'High', 'Critical'] },
  ],
};

// Snapshot of an in-flight SAS (emoji) verification, pushed to the UI.
//   idle       — nothing happening
//   requested  — a request exists, waiting for the other device to be ready
//   sas        — emoji are ready; show them and ask the user to compare
//   done       — verification completed successfully
//   cancelled  — the other side or a mismatch cancelled it
export interface VerificationState {
  phase: 'idle' | 'requested' | 'sas' | 'done' | 'cancelled';
  emoji?: EmojiMapping[];        // seven [glyph, name] tuples when phase === 'sas'
  otherDeviceId?: string;
  incoming?: boolean;            // true if the other device initiated
  accepted?: boolean;           // incoming request has been accepted (waiting for emoji)
  confirmed?: boolean;          // user pressed "They match" — completion in flight, mismatch path is now dead
  error?: string;
}

// Extract a readable reason from a verification Cancel payload — either an Error or
// an m.key.verification.cancel MatrixEvent carrying { code, reason }. The code (e.g.
// m.key_mismatch vs m.user_error) says whether a "They match" cancel is a crypto/key
// problem or a flow/timeout one.
const describeVerificationCancel = (e: unknown): string => {
  if (!e) return 'cancelled';
  if (e instanceof Error) return e.message;
  const ev = e as { getContent?: () => { code?: string; reason?: string } };
  const c = ev.getContent?.();
  if (c) return [c.code, c.reason].filter(Boolean).join(': ') || 'cancelled';
  return String(e);
};

export class MatrixSource implements Source {
  readonly kind = 'matrix' as const;
  readonly id: string;
  private creds: MatrixCreds;
  private client: MatrixClient | null = null;
  private started = false;
  private listeners = new Set<() => void>();
  private syncState: string | null = null;
  // True when the crypto store is IndexedDB-backed (keys persist across loads).
  private cryptoPersistent = false;
  // Incoming MatrixRTC calls (a call is active in a joined room and we're not
  // in it): roomId -> { since }. Dismissed rooms stay suppressed until the call
  // ends; activeCallRoomId is the room we joined ourselves (never "incoming").
  // Per-space hierarchy (MSC2946) so rooms you're in a space but haven't
  // joined still surface (as joinable). Cached per session.
  private spaceHierarchy = new Map<string, JoinableRoom[]>();
  private hierarchyFetching = new Set<string>();
  // Adaptive timeline inflation: rooms whose single loaded event is a hidden
  // category get a one-shot back-pagination so the real last message surfaces.
  private inflateTimer: ReturnType<typeof setTimeout> | null = null;
  private inflateTried = new Set<string>();
  // Set once we've wired the visibility/online listeners that poke the sliding
  // sync to resend the moment the tab is foregrounded (see start()).
  private pokeWired = false;
  // Room ids we've ever observed as joined this session. getRoomSummary on some
  // servers reports a joined space child with a non-'join' membership, which
  // would surface it as a fake "Join" row whenever the room momentarily isn't in
  // the store (sliding-sync churn). Once we've seen it joined, never treat it as
  // joinable again — kills that flicker.
  private everJoined = new Set<string>();
  // Sliding sync (MSC4186 / simplified MSC3575): used instead of classic /sync
  // when the server supports it, so huge accounts (100s of rooms) don't choke
  // on a full initial sync. We keep a recency-sorted window that grows to cover
  // all rooms, plus per-room subscriptions for rooms we open.
  private slidingSync: SlidingSync | null = null;
  // DIAGNOSTIC: last raw sliding-sync summary fields per room, so wmRaw() can
  // show exactly what the server (Continuwuity) sends — to pin down whether
  // wrong names / dead mentions are missing server fields vs SDK handling.
  private lastRoomData = new Map<string, Record<string, unknown>>();
  private roomSubs = new Set<string>();
  private incomingCalls = new Map<string, { since: number }>();
  private dismissedCalls = new Set<string>();
  private activeCallRoomId: string | null = null;
  private rtcSessionListeners = new Map<string, () => void>();
  isCryptoPersistent(): boolean { return this.cryptoPersistent; }
  // Our reaction event ids by (targetEventId, key) so toggle-off can redact.
  private selfReactionIds = new Map<string, string>();
  // Off-thread full-text message index. Lazily filled from loaded
  // timelines; queried by searchMessages().
  private search = new SearchIndex();
  private harvestTimer: ReturnType<typeof setTimeout> | null = null;
  // ── SAS verification state ──
  private verifyReq: VerificationRequest | null = null;
  private verifier: Verifier | null = null;
  private sasCallbacks: ShowSasCallbacks | null = null;
  // Set the instant the user presses "They match". Once true, the mismatch path
  // is permanently dead for this flow: a stray scrim/close click must NEVER turn
  // an affirmed match into an m.mismatched_sas cancel. (Root cause of the
  // "They match cancels" bug — see reference_wukkiemail_sas_crosssigning.)
  private confirmSent = false;
  // Last SAS emoji names shown — logged on confirm/mismatch so a cross-device
  // comparison can prove the grids actually matched.
  private lastSasNames = '';
  private verifyState: VerificationState = { phase: 'idle' };
  private verifyListeners = new Set<(s: VerificationState) => void>();

  constructor(creds: MatrixCreds) {
    this.creds = creds;
    this.id = creds.userId;
  }

  static tryRestore(): MatrixSource | null {
    const creds = loadCreds();
    return creds ? new MatrixSource(creds) : null;
  }

  // When a room is opened, subscribe to it so its full timeline loads even if
  // it's outside the sliding window. No-op under classic sync.
  subscribeRoom(roomId: string): void {
    if (!this.slidingSync || this.roomSubs.has(roomId)) return;
    this.roomSubs.add(roomId);
    try { this.slidingSync.modifyRoomSubscriptions(new Set(this.roomSubs)); } catch { /* ignore */ }
  }

  // Subscribe to "something changed, re-render". Fires on every sync
  // transition; consumers should debounce if needed.
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  // Raw client for the native call view (MatrixRTC + SFU live on the SDK).
  getClient(): MatrixClient | null { return this.client ?? null; }

  // Can the user start/join a call in this room? Gated on permission to send
  // the call-membership state event (not on room type) — so DMs and any room
  // where you can post state events qualify. maySendStateEvent falls back to
  // state_default for the type, which a DM member meets.
  canStartCall(roomId: string): boolean {
    if (!this.client) return false;
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    const cs = room.currentState;
    // A dedicated call/VC room (MSC3417 create type, or our Wally call-room
    // marker) always offers the call affordance — that's the room's entire
    // purpose. This also avoids hiding the button when m.room.power_levels
    // hasn't loaded under sliding sync, where maySendStateEvent would otherwise
    // fall back to the default state_default (50) and read as "not allowed".
    const createType = (cs.getStateEvents('m.room.create', '')?.getContent() as { type?: string } | undefined)?.type;
    if (createType === 'org.matrix.msc3417.call') return true;
    if (cs.getStateEvents('eu.kiefte.wally.call_room', '')) return true;
    const selfId = this.client.getUserId() ?? '';
    try {
      return cs.maySendStateEvent('m.rtc.member' as never, selfId)
        || cs.maySendStateEvent('org.matrix.msc3401.call.member' as never, selfId);
    } catch { return true; }
  }

  // Room widgets (im.vector.modular.widgets state events). Empty url = removed.
  getRoomWidgets(roomId: string): RoomWidget[] {
    if (!this.client) return [];
    const room = this.client.getRoom(roomId);
    if (!room) return [];
    const state = room.getLiveTimeline().getState('f' as never);
    if (!state) return [];
    return state.getStateEvents('im.vector.modular.widgets')
      .filter((ev) => !!ev.getContent()?.url)
      .map((ev) => {
        const c = ev.getContent() as Record<string, unknown>;
        return {
          id: ev.getStateKey() ?? '',
          type: (c.type as string) ?? 'm.custom',
          url: (c.url as string) ?? '',
          name: (c.name as string) ?? 'Widget',
          data: c.data as Record<string, unknown> | undefined,
          avatarUrl: c.avatar_url as string | undefined,
        };
      });
  }

  // Can the user add/remove widgets here? Widgets are state events, so this is
  // the room's state_default power level (default 50) vs the user's level.
  canManageWidgets(roomId: string): boolean {
    if (!this.client) return false;
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    const myPL = room.getMember(this.client.getUserId() ?? '')?.powerLevel ?? 0;
    const plc = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent() as Record<string, unknown> | undefined;
    const stateDefault = (plc?.state_default as number | undefined) ?? 50;
    return myPL >= stateDefault;
  }

  async addWidget(roomId: string, url: string, name: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const id = `wm-widget-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await this.client.sendStateEvent(roomId, 'im.vector.modular.widgets' as never, { type: 'm.custom', url, name, id } as never, id);
  }

  async removeWidget(roomId: string, widgetId: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.sendStateEvent(roomId, 'im.vector.modular.widgets' as never, {} as never, widgetId);
  }

  // ── Incoming calls ──
  // The SDK's MatrixRTCSessionManager (auto-started by startClient) fires
  // SessionStarted/SessionEnded as call.member memberships come and go. We treat
  // a session as an INCOMING call when it has a participant who isn't us and we
  // haven't joined it on this client. Re-evaluate on the session's own
  // MembershipsChanged so the prompt clears when we join or everyone leaves.
  private startIncomingCallListener(): void {
    const client = this.client;
    if (!client) return;
    const mgr = client.matrixRTC;
    if (!mgr) return;
    mgr.on(MatrixRTCSessionManagerEvents.SessionStarted, (roomId: string, session: MatrixRTCSession) => {
      // Re-evaluate whenever this session's memberships change, and remember the
      // unsubscribe so SessionEnded can detach it.
      const onChange = () => this.evaluateRtcSession(roomId, session);
      session.on(MatrixRTCSessionEvent.MembershipsChanged, onChange);
      this.rtcSessionListeners.set(roomId, () => session.off(MatrixRTCSessionEvent.MembershipsChanged, onChange));
      this.evaluateRtcSession(roomId, session);
    });
    mgr.on(MatrixRTCSessionManagerEvents.SessionEnded, (roomId: string) => {
      this.rtcSessionListeners.get(roomId)?.();
      this.rtcSessionListeners.delete(roomId);
      // Call over: clear any incoming flag AND the dismissal, so the next call
      // in this room rings again.
      const had = this.incomingCalls.delete(roomId);
      this.dismissedCalls.delete(roomId);
      if (had) this.notify();
    });
  }

  private evaluateRtcSession(roomId: string, session: MatrixRTCSession): void {
    const myId = this.client?.getUserId() ?? '';
    const memberships = session.memberships ?? [];
    const others = memberships.some((m) => m.sender && m.sender !== myId);
    const isIncoming =
      others &&
      roomId !== this.activeCallRoomId &&   // not the call we're in
      !this.dismissedCalls.has(roomId);     // not one we declined
    const has = this.incomingCalls.has(roomId);
    if (isIncoming && !has) {
      this.incomingCalls.set(roomId, { since: Date.now() });
      this.notify();
    } else if (!isIncoming && has) {
      this.incomingCalls.delete(roomId);
      this.notify();
    }
  }

  // Rooms with an active call we haven't joined (most recent first).
  getIncomingCalls(): IncomingCall[] {
    if (!this.client) return [];
    return [...this.incomingCalls.entries()]
      .filter(([roomId]) => roomId !== this.activeCallRoomId && !this.dismissedCalls.has(roomId))
      .map(([roomId, v]) => {
        const room = this.client!.getRoom(roomId);
        return { roomId, roomName: room?.name || roomId, since: v.since };
      })
      .sort((a, b) => b.since - a.since);
  }

  // Decline: suppress this call until it ends (SessionEnded clears the flag).
  dismissIncomingCall(roomId: string): void {
    this.dismissedCalls.add(roomId);
    if (this.incomingCalls.delete(roomId)) this.notify();
    else this.notify();
  }

  // CallView calls this so the room we're actively in is never "incoming".
  setActiveCallRoom(roomId: string | null): void {
    this.activeCallRoomId = roomId;
    if (roomId && this.incomingCalls.delete(roomId)) this.notify();
    else this.notify();
  }

  // Custom (mxc) emoji from im.ponies packs (MSC2545): the user's own pack
  // (account data im.ponies.user_emotes), globally-enabled room packs
  // (im.ponies.emote_rooms -> referenced room state), and the current room's
  // packs (im.ponies.room_emotes state events). Deduped by shortcode; first
  // win is the user pack, then room, then global. usage is honoured: an image
  // with an explicit usage list must include 'emoticon'.
  getCustomEmojis(roomId?: string): CustomEmoji[] {
    if (!this.client) return [];
    const out = new Map<string, string>(); // shortcode -> mxc
    const addPack = (content: unknown) => {
      const c = content as { images?: Record<string, { url?: string; usage?: string[] }>; pack?: { usage?: string[] } } | undefined;
      const images = c?.images;
      if (!images || typeof images !== 'object') return;
      const packUsage = c?.pack?.usage;
      for (const [shortcode, img] of Object.entries(images)) {
        if (!img?.url || !img.url.startsWith('mxc://')) continue;
        const usage = img.usage ?? packUsage;
        if (Array.isArray(usage) && usage.length > 0 && !usage.includes('emoticon')) continue;
        if (!out.has(shortcode)) out.set(shortcode, img.url);
      }
    };

    // 1) user pack
    addPack(this.client.getAccountData('im.ponies.user_emotes' as never)?.getContent());

    // 2) current room packs
    if (roomId) {
      const room = this.client.getRoom(roomId);
      const state = room?.getLiveTimeline().getState('f' as never);
      if (state) for (const ev of state.getStateEvents('im.ponies.room_emotes')) addPack(ev.getContent());
    }

    // 3) globally-enabled room packs
    const emoteRooms = this.client.getAccountData('im.ponies.emote_rooms' as never)?.getContent() as { rooms?: Record<string, Record<string, unknown>> } | undefined;
    const rooms = emoteRooms?.rooms;
    if (rooms && typeof rooms === 'object') {
      for (const [rid, stateKeys] of Object.entries(rooms)) {
        const room = this.client.getRoom(rid);
        const state = room?.getLiveTimeline().getState('f' as never);
        if (!state || typeof stateKeys !== 'object') continue;
        for (const sk of Object.keys(stateKeys)) {
          const ev = state.getStateEvents('im.ponies.room_emotes', sk);
          if (ev) addPack(ev.getContent());
        }
      }
    }

    return [...out.entries()].map(([shortcode, mxc]) => ({ shortcode, mxc }));
  }

  // im.ponies images usable as STICKERS (usage includes 'sticker', or no usage
  // list — MSC2545 defaults to both roles). Same pack sources as getCustomEmojis.
  getStickers(roomId?: string): CustomEmoji[] {
    if (!this.client) return [];
    const out = new Map<string, string>();
    const addPack = (content: unknown) => {
      const c = content as { images?: Record<string, { url?: string; usage?: string[] }>; pack?: { usage?: string[] } } | undefined;
      const images = c?.images;
      if (!images || typeof images !== 'object') return;
      const packUsage = c?.pack?.usage;
      for (const [shortcode, img] of Object.entries(images)) {
        if (!img?.url || !img.url.startsWith('mxc://')) continue;
        const usage = img.usage ?? packUsage;
        if (Array.isArray(usage) && usage.length > 0 && !usage.includes('sticker')) continue;
        if (!out.has(shortcode)) out.set(shortcode, img.url);
      }
    };
    addPack(this.client.getAccountData('im.ponies.user_emotes' as never)?.getContent());
    if (roomId) {
      const state = this.client.getRoom(roomId)?.getLiveTimeline().getState('f' as never);
      if (state) for (const ev of state.getStateEvents('im.ponies.room_emotes')) addPack(ev.getContent());
    }
    const emoteRooms = this.client.getAccountData('im.ponies.emote_rooms' as never)?.getContent() as { rooms?: Record<string, Record<string, unknown>> } | undefined;
    const rooms = emoteRooms?.rooms;
    if (rooms && typeof rooms === 'object') {
      for (const [rid, stateKeys] of Object.entries(rooms)) {
        const state = this.client.getRoom(rid)?.getLiveTimeline().getState('f' as never);
        if (!state || typeof stateKeys !== 'object') continue;
        for (const sk of Object.keys(stateKeys)) {
          const ev = state.getStateEvents('im.ponies.room_emotes', sk);
          if (ev) addPack(ev.getContent());
        }
      }
    }
    return [...out.entries()].map(([shortcode, mxc]) => ({ shortcode, mxc }));
  }

  // Send a sticker (m.sticker). The image is the pack's already-uploaded mxc,
  // so there's no upload/encryption step — we just reference it. body is the
  // shortcode (the textual fallback non-sticker clients show).
  async sendSticker(roomId: string, body: string, mxcUrl: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.sendEvent(roomId, 'm.sticker' as never, {
      body,
      url: mxcUrl,
      info: {},
    } as never);
    this.notify();
  }

  private notify() { for (const cb of this.listeners) cb(); }

  // Ensure a global account-data event is available in the LOCAL store. Under
  // sliding sync, global account data rides the (slow) room sync's account_data
  // extension, so on a fresh device the secret-storage / cross-signing events may
  // not have landed when the encryption flow checks for them — making it wrongly
  // report "no secret storage". Fetch the event straight from the server and
  // inject it into the store so SDK methods that read locally (secretStorage,
  // bootstrapCrossSigning, restoreKeyBackup) can find it. Returns the content.
  private async ensureAccountData(type: string): Promise<Record<string, unknown> | null> {
    if (!this.client) return null;
    const local = this.client.getAccountData(type as never)?.getContent() as Record<string, unknown> | undefined;
    if (local && Object.keys(local).length > 0) return local;
    try {
      const fromServer = (await this.client.getAccountDataFromServer(type as never)) as Record<string, unknown> | null;
      if (fromServer && Object.keys(fromServer).length > 0) {
        const ev = new MatrixEvent({ type, content: fromServer });
        this.client.store.storeAccountDataEvents([ev]);
        return fromServer;
      }
    } catch { /* not set / not reachable — caller falls back */ }
    return null;
  }

  // App config lives in global account data: triage (pin/snooze), saved views,
  // manual bundles, sort weights, and custom emoji (im.ponies). Under sliding
  // sync Continuwuity only resends account data that CHANGED since the persisted
  // pos — on a restored pos it resends NONE — so on reload these come up empty
  // and the inbox silently reverts to defaults (saved views vanish, bundles
  // unfold, weights reset). The SDK fork seeds the standard globals (m.direct
  // etc.); these app-specific types it can't know about, so seed them here:
  // pull each from the server into the store, wake any reactive listeners, and
  // notify so the inbox re-reads. Idempotent — ensureAccountData leaves anything
  // already present locally untouched. Sliding-sync only; classic /sync rehydrates
  // account data itself.
  private seedConfigPromise: Promise<void> | null = null;
  private seedConfigAccountData(): void {
    if (!this.slidingSync) return;
    this.seedConfigPromise = (async () => {
      const types = [
        TRIAGE_EVENT_TYPE,
        VIEWS_EVENT_TYPE,
        BUNDLES_EVENT_TYPE,
        WEIGHTS_EVENT_TYPE,
        'im.ponies.user_emotes',
        'im.ponies.emote_rooms',
      ];
      const loaded = await Promise.all(types.map((t) => this.ensureAccountData(t)));
      if (!loaded.some(Boolean)) return;
      // Wake reactive consumers (e.g. the emoji picker) in addition to notify().
      for (const t of types) {
        const ev = this.client?.getAccountData(t as never);
        if (ev) {
          try { this.client?.emit(ClientEvent.AccountData, ev, undefined); } catch { /* ignore */ }
        }
      }
      this.notify();
    })();
  }

  // Config writers merge a change onto the LOCAL account-data blob. On a restored
  // sliding-sync pos Continuwuity resends NONE of it, so until seedConfigAccountData
  // has pulled it from the server the local copy is empty — and a write in that
  // window would merge against nothing and PUT an empty blob, silently wiping the
  // user's saved bundles / pins / views server-side. Gate config writes on the seed
  // so the merge base is always server-authoritative. No-op once seeded, and on
  // classic sync (which rehydrates account data itself).
  private async ensureConfigSeeded(): Promise<void> {
    if (!this.slidingSync) return;
    if (!this.seedConfigPromise) this.seedConfigAccountData();
    try { await this.seedConfigPromise; } catch { /* best-effort; writer still PUTs */ }
  }

  // Read the AUTHORITATIVE account-data value before a read-modify-write. Under
  // sliding sync the local copy is unreliable (Continuwuity only re-pushes account
  // data changed since the persisted pos — none on a restored pos — and a write
  // reflects locally only once the server echoes it back a poll later). Merging
  // against the local copy therefore CLOBBERS: the PUT overwrites the server with a
  // value derived from a stale base. Fetch from the server first so the merge is
  // always against current truth; fall back to local only if the server is
  // unreachable. (Same fix as cinny m.direct.)
  private async readAccountData(type: string): Promise<Record<string, unknown>> {
    if (!this.client) return {};
    try {
      const fromServer = (await this.client.getAccountDataFromServer(
        type as never
      )) as Record<string, unknown> | null;
      if (fromServer && typeof fromServer === 'object') return fromServer;
    } catch {
      /* unreachable — fall back to the local copy */
    }
    const local = this.client.getAccountData(type as never)?.getContent() as
      | Record<string, unknown>
      | undefined;
    return local ?? {};
  }

  // Persist account data AND reflect it in the local store immediately, so getters
  // return the new value at once instead of waiting on a sliding-sync echo that
  // Continuwuity may delay or never send. Without the local reflect, a second edit
  // before the echo reads stale state and clobbers the first — the same data-loss
  // class as the m.direct bug, one type at a time.
  private async commitAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error('client not started');
    // Reflect locally FIRST, so getAccountData is immediately authoritative. Under
    // sliding sync client.setAccountData blocks until the server ECHOES the write
    // (a whole poll cycle, ~3s); if we only stored locally after that await — as
    // this did — a routine sync notify in the gap fires the inbox refresh(), which
    // re-reads the still-stale store and REVERTS the optimistic change. That's why
    // "hide this bundle" popped straight back up: the hide was undone a frame later
    // by a refresh reading account data that hadn't updated yet.
    const prev = this.client.getAccountData(type as never);
    const ev = new MatrixEvent({ type, content });
    this.client.store.storeAccountDataEvents([ev]);
    this.client.emit(ClientEvent.AccountData, ev, prev ?? undefined);
    this.notify();
    // Then persist to the server. client.setAccountData would now no-op (the local
    // store already matches its deep-compare) AND it waits for the echo — so PUT
    // directly. A transient failure keeps the local value; the next successful write
    // or the server echo reconciles.
    try {
      await this.client.setAccountDataRaw(type as never, content as never);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] account-data PUT failed; kept local value', e);
    }
  }

  // Delete the Rust crypto IndexedDB stores for a given store prefix. Used to
  // recover from a stale/device-mismatched crypto store (a re-login mints a new
  // device id but the old store lingers) without dropping to the hang-prone
  // in-memory backend. Names mirror the SDK: `<prefix>::matrix-sdk-crypto` and
  // `<prefix>::matrix-sdk-crypto-meta`.
  // Coalesce a burst of decryption events (e.g. a backup restore decrypting
  // hundreds of messages at once) into a single refresh.
  private decryptedNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleDecryptedNotify() {
    if (this.decryptedNotifyTimer) return;
    this.decryptedNotifyTimer = setTimeout(() => {
      this.decryptedNotifyTimer = null;
      this.notify();
    }, 300);
  }

  getSyncState(): string | null { return this.syncState; }
  isInitialSyncComplete(): boolean {
    return this.syncState === 'PREPARED' || this.syncState === 'SYNCING';
  }

  // Debug snapshot — what does the client see right now?
  describe(): { state: string | null; rooms: number; spaces: number } {
    if (!this.client) return { state: null, rooms: 0, spaces: 0 };
    const all = this.client.getRooms();
    return {
      state: this.syncState,
      rooms: all.filter((r) => !isSpace(r)).length,
      spaces: all.filter((r) => isSpace(r)).length,
    };
  }

  // Diagnostic: dump every known room with the facts that decide whether it
  // appears in the inbox and under which space. Call wmRooms() in the console.
  debugRooms(filter?: string): void {
    if (!this.client) { console.warn('[wukkiemail] not started'); return; }
    const idx = this.buildBundleIndex();
    const all = this.client.getRooms();
    const rows = all
      .filter((r) => !filter || (r.name ?? '').toLowerCase().includes(filter.toLowerCase()) || r.roomId.includes(filter))
      .map((r) => ({
        name: r.name || '(no name)',
        roomId: r.roomId,
        isSpace: isSpace(r),
        membership: r.getMyMembership?.() ?? '?',
        createType: (r.currentState.getStateEvents('m.room.create', '')?.getContent() as { type?: string } | undefined)?.type ?? '',
        timelineEvents: r.getLiveTimeline().getEvents().length,
        bundles: (idx.get(r.roomId) ?? []).join(' ') || '(none)',
        parents: r.currentState.getStateEvents('m.space.parent').map((e) => e.getStateKey()).join(' ') || '',
      }));
    // eslint-disable-next-line no-console
    console.table(rows);
    for (const s of all.filter(isSpace)) {
      const kids = s.currentState.getStateEvents('m.space.child')
        .map((e) => `${e.getStateKey()}${Object.keys(e.getContent() as object).length === 0 ? '(removed)' : ''}`);
      // eslint-disable-next-line no-console
      console.info('[wukkiemail] SPACE', s.name, s.roomId, 'm.space.child:', kids);
    }
    // eslint-disable-next-line no-console
    console.info(`[wukkiemail] ${all.length} rooms total (${rows.length} shown). Pass a name/id substring to wmRooms("wally") to filter.`);
  }

  // Lean diagnostic for the "missing spaces" question. Prints ONLY counts (no
  // per-room table, so it won't flood the console): how many spaces we actually
  // hold vs how many the server reports in the dedicated `spaces` list, plus the
  // `all` list growth state. Call wmSpaces() in the console.
  spaceStats(): void {
    if (!this.client) { console.warn('[wukkiemail] not started'); return; }
    const all = this.client.getRooms();
    const heldSpaces = all.filter(isSpace).length;
    const ss = this.slidingSync;
    const spacesList = ss?.getListData('spaces')?.joinedCount ?? null;
    const allList = ss?.getListData('all')?.joinedCount ?? null;
    const allEnd = ss?.getListParams('all')?.ranges?.[0]?.[1] ?? null;
    const spacesEnd = ss?.getListParams('spaces')?.ranges?.[0]?.[1] ?? null;
    // eslint-disable-next-line no-console
    console.info('[wukkiemail] spaceStats', {
      syncState: this.syncState,
      heldRooms: all.length,
      heldSpaces,
      serverSpacesCount: spacesList,   // server's count of m.space rooms (if filter honoured)
      spacesWindowEnd: spacesEnd,      // how far the spaces list window reaches
      serverAllCount: allList,         // server's count of non-space rooms
      allWindowEnd: allEnd,            // how far the recency window has grown
    });
  }

  // DIAGNOSTIC: for rooms matching a name/id filter, show what the SERVER sent
  // (raw sliding-sync summary: name/heroes/counts/highlight) NEXT TO what the
  // SDK resolved (room.name, member counts, highlight badge). This pins down
  // why names/mentions break: missing server fields vs SDK handling. Call
  // wmRaw("alice") in the console.
  wmRaw(filter?: string): void {
    if (!this.client) { console.warn('[wukkiemail] not started'); return; }
    const rows = this.client.getRooms()
      .filter((r) => !filter || (r.name ?? '').toLowerCase().includes(filter.toLowerCase()) || r.roomId.includes(filter))
      .map((r) => {
        const raw = this.lastRoomData.get(r.roomId) ?? {};
        const heroes = raw.heroes as Array<{ user_id?: string; displayname?: string }> | undefined;
        return {
          resolvedName: r.name || '(none)',
          serverName: (raw.name as string) ?? '—',
          heroes: heroes ? heroes.map((h) => `${h.user_id}=${h.displayname ?? '∅'}`).join(', ') : '—',
          joined: r.getJoinedMemberCount(),
          srvJoined: (raw.joined_count as number) ?? '—',
          members: r.currentState.getMembers().length,
          hl: r.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0,
          srvHl: (raw.highlight_count as number) ?? '—',
          notif: r.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
          srvNotif: (raw.notification_count as number) ?? '—',
          hasNameState: !!r.currentState.getStateEvents('m.room.name', ''),
          roomId: r.roomId,
        };
      });
    // eslint-disable-next-line no-console
    console.table(rows);
    // eslint-disable-next-line no-console
    console.info('[wukkiemail] wmRaw legend: serverName/heroes/srv* = what Continuwuity sent; resolvedName/hl = what the SDK computed. ∅ = hero with no displayname.');
  }

  // DIAGNOSTIC: dump the last ~12 LIVE-TIMELINE events for matching rooms, with
  // type / state-key / sender / ts / human date. getLastActiveTimestamp() (which
  // drives the room sort) is just the ts of the LAST timeline event, so this
  // reveals exactly what makes a room (e.g. ganza) float to the top and whether
  // any event carries a fabricated "now" / invalid timestamp. Call
  // wmEvents("ganza") in the console.
  wmEvents(filter?: string): void {
    if (!this.client) { console.warn('[wukkiemail] not started'); return; }
    const myId = this.client.getUserId();
    const rooms = this.client.getRooms()
      .filter((r) => !filter || (r.name ?? '').toLowerCase().includes(filter.toLowerCase()) || r.roomId.includes(filter));
    for (const r of rooms) {
      const evs = r.getLiveTimeline().getEvents();
      const readUpTo = myId ? r.getEventReadUpTo(myId) : null;
      const lastTs = r.getLastActiveTimestamp();
      const fmt = (ts: number) => (Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : `INVALID(${ts})`);
      const rows = evs.slice(-12).map((e, i) => ({
        idx: evs.length - Math.min(12, evs.length) + i,
        type: e.getType(),
        stateKey: e.getStateKey() ?? '(msg)',
        sender: e.getSender(),
        ts: e.getTs(),
        date: fmt(e.getTs()),
        eventId: e.getId(),
        marker: e.getId() === readUpTo ? '<= readUpTo' : '',
        body: JSON.stringify(e.getContent()).slice(0, 50),
      }));
      // eslint-disable-next-line no-console
      console.group(`[wukkiemail] ${r.name || '(no name)'} — ${r.roomId} | timelineLen=${evs.length} lastActiveTs=${fmt(lastTs)}`);
      // eslint-disable-next-line no-console
      console.table(rows);
      // eslint-disable-next-line no-console
      console.groupEnd();
    }
    // eslint-disable-next-line no-console
    console.info('[wukkiemail] wmEvents legend: the BOTTOM row is the "last active" event that drives sort. stateKey !== (msg) means a STATE event in the timeline. Watch for a "now" or INVALID date.');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Build (and IndexedDB-hydrate) the client lazily — first run takes
    // a sync; subsequent loads hydrate from IndexedDB and are near-instant.
    this.client = await buildClient(this.creds);
    const client = this.client;
    // Sync listener stays attached for the lifetime of the source.
    // Every transition pings subscribers so the inbox redraws as
    // rooms arrive — we don't block on PREPARED any more.
    client.on(ClientEvent.Sync, (state, prev, data) => {
      // eslint-disable-next-line no-console
      console.info('[wukkiemail] sync ->', state, { prev });
      this.syncState = state;
      this.notify();
      if (state === 'PREPARED' || (state === 'SYNCING' && prev !== 'SYNCING')) {
        // First full state is ready — harvest loaded message bodies into
        // the search index. Cheap to repeat (upsert by event id).
        this.harvestSearchDocs();
      }
      if (state === 'ERROR') {
        const err = (data as { error?: { message?: string } })?.error?.message ?? 'unknown';
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] sync ERROR:', err);
      }
    });
    // Belt-and-suspenders: poll the SDK's getSyncState() every 2s in case
    // our listener is the part that's broken — at least the UI updates.
    setInterval(() => {
      const s = client.getSyncState();
      if (s !== this.syncState) {
        // eslint-disable-next-line no-console
        console.info('[wukkiemail] sync state poll caught', s, '(listener missed it?)');
        this.syncState = s;
        this.notify();
      }
    }, 2000);

    // Try to initialise Rust crypto before startClient. Without crypto,
    // encrypted rooms stay placeholder-only; with it, recent messages
    // decrypt automatically (older history needs key backup, which we
    // don't wire UX for yet). Continue without crypto if init fails so
    // unencrypted rooms still work.
    const params = new URLSearchParams(window.location.search);
    if (!params.has('nocrypto')) {
      // The Rust crypto store holds this device's identity keys + cross-signing +
      // key-backup keys — the state that makes encryption and verification a
      // one-time setup which PERSISTS across reloads. The store the OlmMachine
      // opens MUST belong to the same (user, device) as the client, or the
      // constructor rejects it ("account in the store doesn't match").
      //
      // So the store prefix is a DETERMINISTIC function of (userId, deviceId).
      // We deliberately do NOT use the SDK default prefix ('matrix-js-sdk'): it
      // is shared across logins, so a stale store from a previous device collided
      // with the current session. The old code worked around the collision with a
      // per-device fallback PLUS a best-effort delete of the default store — and
      // that delete was the long-standing root-cause bug: once the default store
      // was gone, the NEXT reload found the default prefix free, opened a FRESH
      // EMPTY default store, succeeded, and never re-read the per-device store
      // that actually held the keys. Result: cross-signing silently null on
      // reload, "no secret storage", verified-then-unverified, SAS mismatched_sas
      // (a keyless device MACs an incomplete key set). Keying by device EVERY
      // time removes the collision, the fallback, and the empty-store trap in one
      // move: the same device always reopens the same persistent store. Any
      // leftover default-prefix store from before this change is simply ignored
      // (harmless on disk); key backup repopulates the device-scoped store
      // automatically on first load after the change.
      const devicePrefix = `wukkiemail-crypto:${client.getUserId() ?? 'u'}:${client.getDeviceId() ?? 'd'}`;
      try {
        await client.initRustCrypto({ cryptoDatabasePrefix: devicePrefix });
        this.cryptoPersistent = true;
        // eslint-disable-next-line no-console
        console.info('[wukkiemail] crypto initialised (IndexedDB — persistent, per-device store)');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] initRustCrypto (IndexedDB, per-device) failed', e);
        // Last resort: in-memory. E2EE works this session but nothing persists,
        // so key backup must be re-entered on every load. Avoided wherever we can
        // — it is what hangs load — but better than no crypto at all.
        try {
          await client.initRustCrypto({ useIndexedDB: false });
          this.cryptoPersistent = false;
          // eslint-disable-next-line no-console
          console.warn('[wukkiemail] crypto initialised (in-memory — will NOT persist; key backup re-entry needed each load)');
        } catch (e3) {
          // eslint-disable-next-line no-console
          console.warn('[wukkiemail] crypto unavailable, continuing without encryption', e3);
        }
      }
      // Surface incoming verification requests (e.g. another of the user's
      // devices wants to verify this one) so the UI can show the emoji sheet.
      // Only meaningful if crypto came up — harmless otherwise.
      if (client.getCrypto?.()) {
        client.on(CryptoEvent.VerificationRequestReceived, (req: VerificationRequest) => {
          this.adoptVerificationRequest(req, true);
        });
        // When keys arrive (key backup restore, or to-device key shares) the
        // SDK re-decrypts events and emits Decrypted. Refresh so already-shown
        // "Unable to decrypt" placeholders update to the real message instead
        // of staying stuck. Debounced — a backup restore decrypts many at once.
        client.on(MatrixEventEvent.Decrypted as never, (() => this.scheduleDecryptedNotify()) as never);
        // Best-effort: if the key backup is already unlocked (its key cached in
        // a persisted crypto store from a prior session), pull historical keys
        // so old messages decrypt automatically — no recovery key needed. A
        // no-op when the key isn't available (in-memory crypto / first run);
        // the user then restores via the encryption block.
        void this.tryRestoreKeyBackup();
      }
    }

    try {
      // Sliding sync is now AUTO-ENABLED by the SDK fork: startClient
      // feature-detects MSC4186/MSC3575 and builds a SlidingSync itself, with
      // the lean required_state + window-growth baked into SlidingSync.create's
      // defaults (we used to assemble that here in maybeBuildSlidingSync). So we
      // just pass autoSlidingSync and let the SDK decide. Toggles preserved:
      //   ?classicsync / settings → autoSlidingSync:false (force classic)
      //   ?slidingsync            → force an instance even if not advertised
      // classic /sync can't produce an initial sync for very large accounts
      // (a 615-room account hung), hence the preference for sliding sync.
      const params = new URLSearchParams(window.location.search);
      const forceClassic = params.has('classicsync') || isClassicSync();
      const forceSliding = params.has('slidingsync');
      // Work out upfront whether sliding sync will actually run, so we ONLY
      // apply classic-sync tuning (initialSyncLimit / lazyLoadMembers) in the
      // classic case. Those opts flow into Room creation under sliding sync too
      // (lazyLoadMembers changed timeline/member behaviour — rooms briefly
      // showed the latest event as the start of the room), and the old code
      // passed NEITHER on the sliding-sync path. Match that exactly.
      let willSlide = !forceClassic && forceSliding;
      if (!forceClassic && !forceSliding) {
        try {
          willSlide = await (
            client as unknown as { serverSupportsSimplifiedSlidingSync?: () => Promise<boolean> }
          ).serverSupportsSimplifiedSlidingSync?.() ?? false;
        } catch { willSlide = false; }
      }
      // Only when forcing sliding sync on a server that may not advertise it do
      // we build an explicit instance (SDK defaults supply the lean state now).
      const explicit = forceSliding && !forceClassic ? SlidingSync.create(client, {}) : undefined;
      await client.startClient({
        threadSupport: true,            // organise m.thread relations into threads
        // Detached: local echoes live in room.getPendingEvents() instead of being
        // spliced into the live timeline. getRoomTimeline + cancelFailedEvents call
        // getPendingEvents(), which THROWS under the default 'chronological'
        // ("Cannot call getPendingEvents with pendingEventOrdering == chronological")
        // — that crashed the room view on restore. Makes the client match the
        // assumption the timeline code already documented.
        pendingEventOrdering: PendingEventOrdering.Detached,
        slidingSync: explicit,          // forced instance, if any (else undefined)
        autoSlidingSync: !forceClassic, // else let the SDK feature-detect
        // Classic-sync fallback tuning — ONLY on the classic path, never under
        // sliding sync (where the SDK's lean lists + per-room subs handle it).
        ...(willSlide ? {} : { initialSyncLimit: 1, lazyLoadMembers: true }),
      } as never);
      // Grab whatever SlidingSync the SDK ended up using (auto-built or forced)
      // so subscribeRoom can manage per-room subscriptions. null under classic.
      this.slidingSync =
        (client as unknown as { getSlidingSync?: () => SlidingSync | undefined }).getSlidingSync?.() ?? null;
      // eslint-disable-next-line no-console
      console.info(`[wukkiemail] started with ${this.slidingSync ? 'SLIDING SYNC' : 'classic /sync'}`);
      // DIAGNOSTIC: capture the raw per-room summary fields the server sends so
      // wmRaw() can reveal whether names/mentions break because Continuwuity
      // omits name/heroes/highlight_count vs an SDK-side handling gap.
      if (this.slidingSync) {
        this.slidingSync.on(SlidingSyncEvent.RoomData, ((roomId: string, rdAny: unknown) => {
          const rd = rdAny as Record<string, unknown>;
          this.lastRoomData.set(roomId, {
            name: rd.name,
            heroes: rd.heroes,
            joined_count: rd.joined_count,
            invited_count: rd.invited_count,
            highlight_count: rd.highlight_count,
            notification_count: rd.notification_count,
            required_state_types: Array.isArray(rd.required_state)
              ? (rd.required_state as Array<{ type?: string; state_key?: string }>).map(
                  (e) => `${e.type}/${e.state_key ?? ''}`,
                )
              : undefined,
          });
        }) as never);
      }
      // Speed: the browser suspends the sliding-sync long-poll when the tab is
      // backgrounded (net::ERR_NETWORK_IO_SUSPENDED), so queued messages don't
      // arrive until the poll naturally retries — they show up late and, because
      // several land at once, sometimes out of order. Poke the sync to resend
      // the instant we're visible / back online / refocused so new messages
      // drain immediately. Wired once; the closure reads this.slidingSync live,
      // so it always pokes the current instance.
      if (this.slidingSync && !this.pokeWired) {
        this.pokeWired = true;
        const poke = () => {
          if (document.visibilityState !== 'visible') return;
          try { this.slidingSync?.resend(); } catch { /* ignore */ }
        };
        document.addEventListener('visibilitychange', poke);
        window.addEventListener('online', poke);
        window.addEventListener('focus', poke);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wukkiemail] startClient threw', e);
      throw e;
    }
    this.startNotificationListener();
    this.startIncomingCallListener();
    // Re-hydrate app config (triage / views / bundles / weights / emoji) that
    // Continuwuity doesn't resend on a restored sliding-sync pos. Fire-and-forget
    // so start() still resolves immediately; notify() refreshes the inbox once
    // the values land.
    this.seedConfigAccountData();
    // Console diagnostic: run wmRooms() (or wmRooms("wally")) to dump room state.
    (window as unknown as { wmRooms?: (f?: string) => void }).wmRooms = (f?: string) => this.debugRooms(f);
    (window as unknown as { wmSpaces?: () => void }).wmSpaces = () => this.spaceStats();
    (window as unknown as { wmRaw?: (f?: string) => void }).wmRaw = (f?: string) => this.wmRaw(f);
    (window as unknown as { wmEvents?: (f?: string) => void }).wmEvents = (f?: string) => this.wmEvents(f);
    // Expose the raw MatrixClient for ad-hoc console root-causing.
    (window as unknown as { wmClient?: unknown }).wmClient = client;
    // Typing indicators don't fire on the generic 'sync' event; hook
    // RoomMember.typing directly so RoomPanel re-renders.
    client.on('RoomMember.typing' as never, (() => this.notify()) as never);
    // Re-render the open room the instant a message is sent (local echo) and on
    // each status change (sending → sent / not_sent), not only when the server
    // echo arrives via sync — otherwise a just-sent message appears to vanish.
    client.on(RoomEvent.LocalEchoUpdated as never, (() => this.notify()) as never);
    // start() resolves now — UI can render whatever rooms are available,
    // and re-render as the sync stream lands more.
  }

  async stop(): Promise<void> {
    this.client?.stopClient();
    this.started = false;
  }

  async listBundles(): Promise<BundleSpec[]> {
    if (!this.client) return [];
    const spaces = this.client.getRooms().filter((r) => isSpace(r));
    return spaces.map((s) => ({
      id: `space:${s.roomId}`,
      label: s.name || s.roomId,
      count: 0,
      flavor: 'matrix' as const,
      kind: 'space' as const,
    }));
  }

  // The space hierarchy, so the inbox can nest sub-spaces under their
  // parent. A subspace is an m.space room that another space lists as an
  // m.space.child. Returns every space with its parent (null = root).
  getSpaceTree(): SpaceNode[] {
    if (!this.client) return [];
    const spaces = this.client.getRooms().filter((r) => isSpace(r));
    const spaceIds = new Set(spaces.map((s) => s.roomId));
    const parentOf = new Map<string, string>();
    for (const p of spaces) {
      for (const ev of p.currentState.getStateEvents('m.space.child')) {
        const childId = ev.getStateKey();
        const content = ev.getContent() as { via?: string[] };
        if (!childId || !content.via || content.via.length === 0) continue;
        if (spaceIds.has(childId)) parentOf.set(childId, p.roomId); // child is itself a space
      }
    }
    return spaces.map((s) => ({ id: s.roomId, label: s.name || s.roomId, parentId: parentOf.get(s.roomId) ?? null }));
  }

  // Map roomId → set of bundle keys it belongs to. Computed once per
  // listItems call. DMs come from m.direct account data; space membership
  // from m.space.child state events on the space room.
  private buildBundleIndex(): Map<string, string[]> {
    const idx = new Map<string, string[]>();
    if (!this.client) return idx;
    const dmEvt = this.client.getAccountData('m.direct' as never);
    const dmContent = (dmEvt?.getContent() ?? {}) as Record<string, string[]>;
    const dmRoomIds = new Set<string>();
    for (const ids of Object.values(dmContent)) {
      for (const id of ids ?? []) dmRoomIds.add(id);
    }
    const spaceIds = new Set(this.client.getRooms().filter(isSpace).map((r) => r.roomId));
    const tagSpace = (roomId: string, spaceId: string) => {
      const arr = idx.get(roomId) ?? [];
      if (!arr.includes(`space:${spaceId}`)) arr.push(`space:${spaceId}`);
      idx.set(roomId, arr);
    };
    // Direction 1: m.space.child on the space (space → room).
    for (const spaceId of spaceIds) {
      const space = this.client.getRoom(spaceId);
      for (const ev of space?.currentState.getStateEvents('m.space.child') ?? []) {
        const childRoomId = ev.getStateKey();
        // A removed child has empty content ({}); anything with content is a
        // child. Don't require `via` specifically — some clients write a child
        // with order/suggested but no via, and requiring via dropped those
        // rooms from the space entirely.
        const content = ev.getContent() as Record<string, unknown>;
        if (!childRoomId || Object.keys(content).length === 0) continue;
        tagSpace(childRoomId, spaceId);
      }
    }
    // Direction 2: m.space.parent on the room (room → space). Rooms created in a
    // space often carry ONLY this link, so relying on m.space.child alone left
    // them untagged and missing from the space. State_key is the parent space.
    for (const room of this.client.getRooms()) {
      if (spaceIds.has(room.roomId)) continue;
      for (const ev of room.currentState.getStateEvents('m.space.parent')) {
        const parentId = ev.getStateKey();
        const content = ev.getContent() as Record<string, unknown>;
        if (!parentId || !spaceIds.has(parentId) || Object.keys(content).length === 0) continue;
        tagSpace(room.roomId, parentId);
      }
    }
    for (const id of dmRoomIds) {
      const arr = idx.get(id) ?? [];
      arr.push('dm');
      idx.set(id, arr);
    }
    return idx;
  }

  // Apply this user's triage overlay (pin / snooze / manual-unread) to items
  // from ANOTHER source (e.g. JMAP), so a combined inbox shares one synced
  // triage. Triage is keyed by InboxItem.id, which works for any source.
  applyExternalTriage(items: InboxItem[]): InboxItem[] {
    const triage = this.getTriageState();
    const pinned = new Set(triage.pinned);
    const manuallyUnread = new Set(triage.manuallyUnread);
    const now = Date.now();
    return items.map((item) => {
      const next = { ...item, bundles: [...item.bundles] };
      const snoozedUntil = triage.snoozed[item.id];
      if (snoozedUntil && snoozedUntil > now) { next.bundles.push('snoozed'); next.snoozedUntil = snoozedUntil; next.priority -= 50; }
      if (pinned.has(item.id)) { next.priority += 100; next.bundles.push('pinned'); }
      if (manuallyUnread.has(item.id)) { next.unread = true; next.unreadCount = Math.max(1, next.unreadCount ?? 0); next.priority += 1; }
      return next;
    });
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
    if (!this.client) return [];
    const selfId = this.client.getUserId() ?? '';
    const bundleIndex = this.buildBundleIndex();
    const triage = this.getTriageState();
    const weights = this.getWeights();
    const pinned = new Set(triage.pinned);
    const now = Date.now();
    const rooms = this.client.getRooms().filter((r) => !isSpace(r));
    const items: InboxItem[] = [];
    const manuallyUnread = new Set(triage.manuallyUnread);
    const originLabel = (selfId.match(/^@([^:]+):/)?.[1]) ?? selfId;
    const addItem = (item: InboxItem | null) => {
      if (!item) return;
      const next = { ...item, bundles: [...item.bundles], accountId: this.id, originLabel };
      const snoozedUntil = triage.snoozed[item.id];
      if (snoozedUntil && snoozedUntil > now) {
        // Mark snoozed and tag it so the inbox can opt to show it via the
        // 'snoozed' bundle, but it's hidden from the All view.
        next.bundles.push('snoozed');
        // Track wake-up time for the panel/UI to display ('Snoozed until …').
        next.snoozedUntil = snoozedUntil;
        // Snoozed items get -50 so they sink in any view that does include them.
        next.priority -= 50;
      }
      // Pinned via our triage set OR already tagged 'pinned' (m.favourite,
      // added in roomToItem). Either way, float it and ensure the tag once.
      const alreadyPinned = next.bundles.includes('pinned');
      if (pinned.has(item.id) || alreadyPinned) {
        next.priority += 100;
        if (!alreadyPinned) next.bundles.push('pinned');
      }
      if (manuallyUnread.has(item.id)) {
        next.unread = true;
        next.unreadCount = Math.max(1, next.unreadCount ?? 0);
        next.priority += 1;
      }
      items.push(next);
    };
    for (const room of rooms) {
      if (room.getMyMembership?.() === 'join') this.everJoined.add(room.roomId);
      const extra = bundleIndex.get(room.roomId) ?? [];
      // Event-type hiding is NOT a visibility filter — a hidden category (e.g.
      // someone joining) must never make a room appear or disappear. It only
      // stops those events from DEFINING the row: roomToItem picks the latest
      // non-hidden event for the snippet/timestamp/category, and unread is
      // driven by real notifications (membership/state events don't notify). So
      // every room is added; hidden events simply don't count.
      const item = roomToItem(room, selfId, extra, this.client, weights);
      addItem(item);
      const roomDone = (triage.doneValuesByRoom ?? {})[room.roomId];
      for (const issueItem of issueItemsForRoom(room, extra, weights.doneStatuses, roomDone)) addItem(issueItem);
    }

    // Surface rooms a space lists that we haven't joined (populated lazily by
    // syncSpaceRooms when a space bundle is opened — see App). Joined-but-
    // unsynced children are materialized there instead and show as normal rooms.
    for (const jr of this.getJoinableRooms()) {
      addItem({
        id: `matrix:${jr.roomId}`,
        flavor: 'matrix',
        bundles: [`flavor:matrix`, `space:${jr.spaceId}`],
        from: `${jr.memberCount} member${jr.memberCount === 1 ? '' : 's'}`,
        fromAddress: jr.roomId,
        subject: jr.name,
        snippet: jr.topic || 'Tap Join to enter this room',
        ts: 0,
        unread: false,
        unreadCount: 0,
        joinable: true,
        threadCount: 0,
        priority: -1, // sink below joined rooms
        openPath: `/m/${encodeURIComponent(jr.roomId)}`,
        avatarUrl: jr.avatarUrl,
      });
    }

    // Schedule adaptive inflation for any rooms whose only loaded event is a
    // hidden category (debounced; no-op when nothing is hidden).
    this.scheduleInflate();
    // Stable tiebreaker on equal recency so rooms don't swap places between
    // renders when two share a timestamp (or a bump arrives a beat apart).
    return items.sort((a, b) => (b.ts - a.ts) || a.id.localeCompare(b.id));
  }

  // Enumerate the event categories present across the user's rooms (by each
  // room's latest event), with counts. Drives the per-type tuning rows in
  // Settings. Ignores the hidden flag so hidden categories still appear —
  // otherwise the user couldn't un-hide them.
  getDetectedEventCategories(): { key: string; label: string; count: number }[] {
    if (!this.client) return [];
    const tally = new Map<string, number>();
    for (const room of this.client.getRooms()) {
      if (isSpace(room)) continue;
      const live = room.getLiveTimeline().getEvents();
      const last = live[live.length - 1];
      if (!last) continue;
      const content = last.getContent() as { msgtype?: string };
      const key = eventCategory(last.getType(), content.msgtype);
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([key, count]) => ({ key, label: EVENT_CATEGORY_LABELS[key] ?? key, count }))
      .sort((a, b) => b.count - a.count);
  }

  // Paginate the live timeline backwards by ~limit events. Returns `more` (the
  // SDK's "history may remain" flag) and `added` (how many events actually
  // landed). The SDK appends to the existing timeline, so consumers re-render
  // via the next change tick.
  //
  // Sliding-sync race: right after a room enters the window its backward
  // pagination token often isn't populated yet, so the first paginate is a
  // no-op — it returns false (→ a premature "start of room") OR true-but-empty
  // (→ a "Load older" button that does nothing when clicked). Both symptoms are
  // the same missing token. We give the sync a brief moment and retry a few
  // times; if the token still hasn't arrived, the caller keeps a clickable
  // affordance so the user can try again once it has.
  async loadOlder(roomId: string, limit = 50): Promise<{ more: boolean; added: number }> {
    if (!this.client) return { more: false, added: 0 };
    const room = this.client.getRoom(roomId);
    if (!room) return { more: false, added: 0 };
    const timeline = room.getLiveTimeline();
    const before = timeline.getEvents().length;
    // Genuinely at the start (oldest loaded event is the room create) vs a
    // missing token — only the latter is worth retrying. Without this, short
    // rooms would spin ~1.5s on every "Load older" before admitting the obvious.
    const atStart = () => timeline.getEvents()[0]?.getType() === 'm.room.create';
    let more = await this.client.paginateEventTimeline(timeline, { backwards: true, limit });
    let added = timeline.getEvents().length - before;
    for (let i = 0; added === 0 && !atStart() && i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 500); });
      // eslint-disable-next-line no-await-in-loop
      more = await this.client.paginateEventTimeline(timeline, { backwards: true, limit });
      added = timeline.getEvents().length - before;
    }
    // Index the freshly-paginated history so older messages become findable.
    const roomName = room.name || room.roomId;
    const docs: MessageDoc[] = [];
    for (const ev of timeline.getEvents()) {
      const doc = this.eventToDoc(ev, room.roomId, roomName);
      if (doc) docs.push(doc);
    }
    void this.search.addMessages(docs);
    this.notify();
    // Treat "events actually arrived" as proof more history exists, even if the
    // SDK's flag says otherwise — so we never strand the user at a false bottom.
    return { more: more || added > 0, added };
  }

  // ── Triage state (pin / snooze) via account data ────────────────────
  //
  // Persisted as a single account-data event 'eu.kiefte.wukkiemail.triage'
  // so it syncs across this user's devices automatically. Per-item keyed
  // by InboxItem.id (e.g. 'matrix:!room:server').
  //
  //   { pinned: string[], snoozed: { [id]: untilTsMs } }

  getTriageState(): TriageState {
    if (!this.client) return EMPTY_TRIAGE;
    const ev = this.client.getAccountData(TRIAGE_EVENT_TYPE as never);
    const c = (ev?.getContent() ?? {}) as Partial<TriageState>;
    return {
      pinned: Array.isArray(c.pinned) ? c.pinned : [],
      snoozed: c.snoozed && typeof c.snoozed === 'object' ? c.snoozed : {},
      manuallyUnread: Array.isArray(c.manuallyUnread) ? c.manuallyUnread : [],
      doneValuesByRoom: c.doneValuesByRoom && typeof c.doneValuesByRoom === 'object' ? c.doneValuesByRoom : {},
    };
  }

  // List rooms eligible as task targets. Two tiers, returned together
  // with `hasSchema` set:
  //   1. Rooms that already have an eu.kiefte.issues.schema state event
  //      (just create issues in them).
  //   2. Rooms where the user has rights to send that schema state event
  //      (bootstrap-on-first-use).
  // Everything else is filtered out — listing rooms where the user
  // can't actually post issues just causes confused 'permission
  // denied' surprises later.
  listTaskTargetRooms(): TaskTargetRoom[] {
    if (!this.client) return [];
    const selfId = this.client.getUserId() ?? '';
    const dmIdx = this.buildBundleIndex();
    const out: TaskTargetRoom[] = [];
    for (const r of this.client.getRooms()) {
      if (isSpace(r)) continue;
      const pl = r.currentState.getStateEvents('m.room.power_levels', '');
      const plContent = (pl?.getContent() ?? {}) as { events?: Record<string, number>; state_default?: number };
      const myLevel = r.getMember(selfId)?.powerLevel ?? 0;
      const canPostIssue = myLevel >= (plContent.events?.[ISSUE_EVENT] ?? plContent.state_default ?? 50);
      const canPostSchema = myLevel >= (plContent.events?.[ISSUE_SCHEMA_EVENT] ?? plContent.state_default ?? 50);
      const schemaEv = r.currentState.getStateEvents(ISSUE_SCHEMA_EVENT, '');
      const schemaFields = (schemaEv?.getContent() as { fields?: unknown[] } | undefined)?.fields;
      const hasSchema = Array.isArray(schemaFields) && schemaFields.length > 0;
      if (!canPostIssue) continue;
      if (!hasSchema && !canPostSchema) continue;
      const bundles = dmIdx.get(r.roomId) ?? [];
      const memberIds = r.getJoinedMembers().map((m) => m.userId);
      const flavor = flavorForRoomMembers(memberIds.filter((id) => id !== selfId));
      out.push({
        roomId: r.roomId,
        name: r.name || r.roomId,
        isDm: bundles.includes('dm'),
        flavor,
        memberCount: r.getJoinedMemberCount(),
        hasSchema,
      });
    }
    // Schema-having rooms first (closer to ready), then DMs, then alpha.
    return out.sort((a, b) => {
      if (a.hasSchema !== b.hasSchema) return a.hasSchema ? -1 : 1;
      if (a.isDm !== b.isDm) return a.isDm ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Rooms whose task schema has a kanban-group enum, for the per-room
  // done-values editor. For each: the full list of status values, which
  // ones currently count as "done", and whether that's an explicit
  // override or the default (last value of the kanban field).
  listIssueRoomsWithStatus(): IssueRoomStatus[] {
    if (!this.client) return [];
    const overrides = this.getTriageState().doneValuesByRoom ?? {};
    const out: IssueRoomStatus[] = [];
    for (const r of this.client.getRooms()) {
      if (isSpace(r)) continue;
      const schemaEv = r.currentState.getStateEvents(ISSUE_SCHEMA_EVENT, '');
      if (!schemaEv) continue;
      const schema = getSchema(r);
      const groupField = schema.fields.find((f) => f.kanban_group && f.type === 'enum' && f.values?.length);
      if (!groupField?.values?.length) continue;
      const values = groupField.values;
      const override = overrides[r.roomId];
      const defaultDone = [values[values.length - 1]];
      out.push({
        roomId: r.roomId,
        name: r.name || r.roomId,
        statusField: groupField.label,
        values,
        doneValues: override && override.length > 0 ? override : defaultDone,
        isOverride: !!(override && override.length > 0),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Set (or clear) which status values count as "done" for one room.
  // Passing an empty array clears the override → falls back to the
  // schema default (last kanban value). Synced via the triage account data.
  async setDoneValuesForRoom(roomId: string, values: string[]): Promise<void> {
    const s = this.getTriageState();
    const byRoom = { ...(s.doneValuesByRoom ?? {}) };
    if (values.length > 0) byRoom[roomId] = values;
    else delete byRoom[roomId];
    await this.setTriageState({ ...s, doneValuesByRoom: byRoom });
  }

  // ── Full-text search index ──────────────────────────────────────────
  //
  // We index every loaded m.room.message body into a worker-backed
  // IndexedDB. Coverage grows as the user syncs and scrolls back (older
  // history isn't loaded until paginated). Harvest is debounced and
  // idempotent (upsert by event id).

  private harvestSearchDocs(): void {
    if (this.harvestTimer) return; // already scheduled
    this.harvestTimer = setTimeout(() => {
      this.harvestTimer = null;
      if (!this.client) return;
      const docs: MessageDoc[] = [];
      for (const room of this.client.getRooms()) {
        if (isSpace(room)) continue;
        const roomName = room.name || room.roomId;
        for (const ev of room.getLiveTimeline().getEvents()) {
          const doc = this.eventToDoc(ev, room.roomId, roomName);
          if (doc) docs.push(doc);
        }
      }
      void this.search.addMessages(docs);
    }, 800);
  }

  private eventToDoc(ev: MatrixEvent, roomId: string, roomName: string): MessageDoc | null {
    if (ev.getType() !== 'm.room.message') return null;
    const body = (ev.getContent() as { body?: string }).body;
    if (!body || typeof body !== 'string') return null;
    const id = ev.getId();
    if (!id) return null;
    return { id, roomId, roomName, sender: ev.getSender() ?? '?', body, ts: ev.getTs() };
  }

  // Query the index. text terms match body/room, from terms match sender.
  // Returns recent message hits (newest-first, capped).
  async searchMessages(parts: { text: string[]; from: string[] }, limit = 50): Promise<MessageHit[]> {
    return this.search.search(parts, limit);
  }

  // Presence for a user — 'online' | 'unavailable' | 'offline' | null.
  // Matrix presence is server-pushed via m.presence; if the homeserver
  // disables presence, this returns null and we just render nothing.
  getPresence(userId: string): 'online' | 'unavailable' | 'offline' | null {
    if (!this.client) return null;
    const user = this.client.getUser(userId);
    const p = user?.presence;
    if (p === 'online' || p === 'unavailable' || p === 'offline') return p;
    return null;
  }

  // Toggle a reaction on a message: send m.reaction if absent, redact
  // our existing reaction if present.
  async toggleReaction(roomId: string, targetEventId: string, key: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const existing = this.selfReactionIds.get(reactionKey(targetEventId, key));
    if (existing) {
      await this.client.redactEvent(roomId, existing);
      this.selfReactionIds.delete(reactionKey(targetEventId, key));
    } else {
      const res = await this.client.sendEvent(roomId, 'm.reaction' as never, {
        'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key },
      } as never);
      const newId = (res as { event_id?: string }).event_id;
      if (newId) this.selfReactionIds.set(reactionKey(targetEventId, key), newId);
    }
    this.notify();
  }

  // Post a comment on an issue. We tag it with eu.kiefte.issue_id so
  // getIssueDetail's filter picks it up. Body is plain text; renderers
  // displaying these messages outside WukkieMail (Cinny, Element) will
  // just show the body without the tag.
  async commentOnIssue(roomId: string, issueId: string, body: string, html?: string | null): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body,
      'eu.kiefte.issue_id': issueId,
    };
    if (html) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    await this.client.sendMessage(roomId, content as never);
    this.notify();
  }

  // Patch an issue's content. Merges the partial with the current
  // state_event content and re-sends. Caller surfaces errors.
  // Set an issue's kanban status to its room's "done" value (per-room
  // override if set, else the schema default — the last kanban value).
  // No-op if the schema has no kanban-group field. Used by the Tasks
  // header sweep.
  async markIssueDone(roomId: string, issueId: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const groupField = getSchema(room).fields.find((f) => f.kanban_group && f.type === 'enum' && f.values?.length);
    if (!groupField?.values?.length) return;
    const override = this.getTriageState().doneValuesByRoom?.[roomId];
    const doneVal = override && override.length > 0
      ? override[override.length - 1]
      : groupField.values[groupField.values.length - 1];
    await this.updateIssue(roomId, issueId, { [groupField.key]: doneVal });
  }

  async updateIssue(roomId: string, issueId: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error(`room not found: ${roomId}`);
    const ev = room.currentState.getStateEvents(ISSUE_EVENT, issueId);
    const current = (ev?.getContent() ?? {}) as Record<string, unknown>;
    const next = { ...current, ...patch };
    await this.client.sendStateEvent(roomId, ISSUE_EVENT as never, next as never, issueId);
    this.notify();
  }

  // Start a direct chat with another user. Creates an encrypted-by-default
  // room, invites the target, and records the room in m.direct so it
  // shows up in our DMs bundle on the next listItems tick.
  async createDirectMessage(targetMxid: string): Promise<string> {
    if (!this.client) throw new Error('client not started');
    const res = await this.client.createRoom({
      preset: 'trusted_private_chat' as never,
      visibility: 'private' as never,
      invite: [targetMxid],
      is_direct: true,
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } } as never,
      ],
    });
    const roomId = (res as { room_id?: string }).room_id;
    if (!roomId) throw new Error('createRoom returned no room_id');
    // Tag in m.direct so the DM bundle picks it up. Account data is a map of
    // mxid -> roomId[]. Read the AUTHORITATIVE server copy before merging — a
    // stale local base here would overwrite every other DM mapping (the cinny
    // m.direct clobber, same shape).
    const existing = (await this.readAccountData('m.direct')) as Record<string, string[]>;
    const list = new Set(existing[targetMxid] ?? []);
    list.add(roomId);
    await this.commitAccountData('m.direct', { ...existing, [targetMxid]: [...list] });
    return roomId;
  }

  // Create a multi-user group room. Encrypted by default; private invite-only.
  async createGroup(name: string, invites: string[] = []): Promise<string> {
    if (!this.client) throw new Error('client not started');
    const res = await this.client.createRoom({
      name,
      visibility: 'private' as never,
      preset: 'private_chat' as never,
      invite: invites.filter(Boolean),
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } } as never,
      ],
    });
    const roomId = (res as { room_id?: string }).room_id;
    if (!roomId) throw new Error('createRoom returned no room_id');
    this.notify();
    return roomId;
  }

  // Targeted, lightweight space sync — run when a space bundle is opened.
  // A space's m.space.child can reference rooms the local sync store doesn't
  // have (the user is joined, but the initial /sync didn't include them, or the
  // store is stale). Rather than a full resync, we look up ONLY the missing
  // children via getRoomSummary (which reports our membership), then:
  //   - membership 'join'  -> materialize it with an idempotent joinRoom, so it
  //     becomes a normal room in the store and appears as a normal item;
  //   - otherwise          -> list it as "joinable" (Join button) using the
  //     summary, so the space still shows the room.
  async syncSpaceRooms(spaceId: string): Promise<void> {
    if (!this.client || this.hierarchyFetching.has(spaceId)) return;
    const space = this.client.getRoom(spaceId);
    if (!space) return;
    this.hierarchyFetching.add(spaceId);
    try {
      const children = space.currentState.getStateEvents('m.space.child')
        .map((ev) => ({ id: ev.getStateKey() ?? '', content: ev.getContent() as { via?: string[] } }))
        .filter((c) => c.id && Object.keys(c.content).length > 0); // skip removed ({})
      const missing = children.filter((c) => !this.client!.getRoom(c.id));
      if (missing.length === 0) return;
      // PRIMARY path under sliding sync: a child we're joined to is often just
      // outside the recency window. Subscribe to each missing child so the
      // server streams it into the store on the next sync — this is how opening
      // a room already works, and crucially it needs NO MSC3266 room summary
      // (Continuwuity has none, so getRoomSummary below 404s for every child).
      // The joined children arrive asynchronously and render once they land.
      if (this.slidingSync) {
        let added = false;
        for (const c of missing) {
          if (!this.roomSubs.has(c.id)) { this.roomSubs.add(c.id); added = true; }
        }
        if (added) {
          try { this.slidingSync.modifyRoomSubscriptions(new Set(this.roomSubs)); } catch { /* ignore */ }
        }
      }
      // NOTE: we deliberately do NOT call getRoomSummary (MSC3266) here. It is
      // absent on Continuwuity (404s for every child) and fired a storm of
      // doomed requests across all open spaces; joined children are delivered by
      // the subscription above + the recency window anyway. Discovering NOT-joined
      // ("joinable") children would need the space hierarchy API (MSC2946
      // /hierarchy) instead — a future enhancement; for now those simply aren't
      // surfaced, which matches "joinable rooms hidden by default".
    } finally {
      this.hierarchyFetching.delete(spaceId);
    }
  }

  // Adaptive timeline inflation. The recency sync loads 1 event/room (lean, fast
  // first paint). For rooms where that one event is a hidden category — a join,
  // a call.member, a trailing issue event — we genuinely lack the info to show a
  // preview or judge unread, so paginate a bit more history. We do this only for
  // those rooms, a few at a time, each tried ONCE (if still all-noise after, give
  // up — don't loop). So the cost scales with NEED, not account size: eagerly
  // paginating hundreds of rooms is exactly the expensive thing to avoid on a big
  // account. No-op when nothing is hidden (every loaded event is then meaningful).
  private scheduleInflate(delayMs = 800): void {
    if (this.inflateTimer) return;
    this.inflateTimer = setTimeout(() => {
      this.inflateTimer = null;
      void this.inflateLackingRooms();
    }, delayMs);
  }

  private async inflateLackingRooms(): Promise<void> {
    if (!this.client) return;
    const hidden = new Set(
      Object.entries(this.getWeights().eventTypeAdjust ?? {})
        .filter(([, v]) => v?.hidden === true)
        .map(([k]) => k),
    );
    if (hidden.size === 0) return;
    const lacksMeaning = (room: Room): boolean => {
      if (room.getMyMembership?.() !== 'join') return false;
      const evs = room.getLiveTimeline().getEvents();
      if (evs.length === 0) return false; // nothing loaded yet — the window will deliver one
      return !evs.some((e) => !hidden.has(eventCategory(e.getType(), (e.getContent() as { msgtype?: string }).msgtype)));
    };
    const candidates = this.client.getRooms().filter(
      (r) => !isSpace(r) && !this.inflateTried.has(r.roomId) && lacksMeaning(r),
    );
    if (candidates.length === 0) return;
    // Inflate by IMPORTANCE, not store order: unread rooms first (you want to
    // see what's actually waiting), then most-recent. So the part of the inbox
    // you care about settles right away and the long tail fills in behind it,
    // rather than the whole list shuffling. This is the "load the right thing at
    // each moment" lever — get the order right and the correction looks seamless.
    candidates.sort((a, b) => {
      const ua = (a.getUnreadNotificationCount?.() ?? 0) > 0 ? 1 : 0;
      const ub = (b.getUnreadNotificationCount?.() ?? 0) > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return (b.getLastActiveTimestamp?.() ?? 0) - (a.getLastActiveTimestamp?.() ?? 0);
    });
    const batch = candidates.slice(0, 8);
    let anyOk = false;
    await Promise.all(batch.map(async (room) => {
      try {
        await this.client!.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: 20 });
        // Succeeded: mark tried ONLY now. If the room is still all-noise after a
        // successful paginate it's genuinely empty of real events, so we stop.
        this.inflateTried.add(room.roomId);
        anyOk = true;
      } catch {
        // Network/offline failure — DON'T mark tried, so a later cycle retries
        // once the connection recovers. Self-correction over a flaky link is the
        // point: we never permanently give up on a room because of a dropped req.
      }
    }));
    if (anyOk) this.notify();
    if (!anyOk) {
      this.scheduleInflate(5000); // whole batch failed — back off, but keep retrying (flaky link)
    } else if (candidates.length > batch.length) {
      this.scheduleInflate(); // tail remains — continue promptly
    }
  }

  // Joinable rooms across all fetched spaces, excluding ones we've since joined
  // or been invited to (those become normal/invite items).
  getJoinableRooms(): JoinableRoom[] {
    if (!this.client) return [];
    const out: JoinableRoom[] = [];
    for (const list of this.spaceHierarchy.values()) {
      for (const jr of list) {
        // Ever-joined wins over a stale summary that says otherwise — and covers
        // the window where the room has briefly fallen out of the store.
        if (this.everJoined.has(jr.roomId)) continue;
        const room = this.client.getRoom(jr.roomId);
        const m = room?.getMyMembership?.();
        if (m === 'join' || m === 'invite') continue; // already an item
        out.push(jr);
      }
    }
    return out;
  }

  // Accept a pending invite (join the room) / decline it (leave). Both notify
  // so the row updates immediately. acceptInvite doubles as "join" for the
  // joinable space rooms surfaced from the hierarchy.
  async acceptInvite(roomId: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.joinRoom(roomId);
    this.notify();
  }

  async rejectInvite(roomId: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.leave(roomId);
    this.notify();
  }

  // Create a persistent voice/video call room (Element-style "video room":
  // m.room.create type org.matrix.msc3417.call). The call-membership state
  // events must be sendable by everyone, so we lower their power level to 0 in
  // power_level_content_override AT CREATION (post-creation sendStateEvent for
  // power levels is racy — see the VC power-level note in memory). `video` is
  // recorded on a small marker state event so the UI can show the right icon
  // and default the call to video; both kinds are otherwise the same room.
  async createCallRoom(name: string, video: boolean, invites: string[] = []): Promise<string> {
    if (!this.client) throw new Error('client not started');
    const res = await this.client.createRoom({
      name,
      visibility: 'private' as never,
      preset: 'private_chat' as never,
      invite: invites.filter(Boolean),
      creation_content: { type: 'org.matrix.msc3417.call' } as never,
      power_level_content_override: {
        events: {
          'org.matrix.msc3401.call.member': 0,
          'm.rtc.member': 0,
          'eu.kiefte.wally.call_room': 0,
        },
      } as never,
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } } as never,
        { type: 'eu.kiefte.wally.call_room', state_key: '', content: { video } } as never,
      ],
    });
    const roomId = (res as { room_id?: string }).room_id;
    if (!roomId) throw new Error('createRoom returned no room_id');
    this.notify();
    return roomId;
  }

  // Create a new issue in a target room. Caller picks the room and we
  // generate a stable id (state_key) plus a minimal schema-compatible
  // content (just a title — the user can edit further in the issue
  // panel later, when we wire editing).
  async createTask(roomId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    if (!this.client) throw new Error('client not started');
    const room = this.client.getRoom(roomId);
    if (room) {
      // Bootstrap the schema state event if the room doesn't have one.
      // Subsequent tasks share it. Failure here surfaces as create error.
      const schemaEv = room.currentState.getStateEvents(ISSUE_SCHEMA_EVENT, '');
      const hasSchema = (schemaEv?.getContent() as { fields?: unknown[] } | undefined)?.fields?.length;
      if (!hasSchema) {
        await this.client.sendStateEvent(roomId, ISSUE_SCHEMA_EVENT as never, DEFAULT_SCHEMA as never, '');
      }
    }
    const stateKey = crypto.randomUUID();
    const content = { title, status: 'To Do', ...extra };
    await this.client.sendStateEvent(roomId, ISSUE_EVENT as never, content as never, stateKey);
    this.notify();
    return stateKey;
  }

  // Saved filtered views — named combinations of bundle + query + status
  // filter, persisted via account data so they sync across this user's
  // devices. Pinned views show up as extra chips in the inbox chip bar.
  getSavedViews(): SavedView[] {
    if (!this.client) return [];
    const ev = this.client.getAccountData(VIEWS_EVENT_TYPE as never);
    const c = (ev?.getContent() ?? {}) as { views?: SavedView[] };
    return Array.isArray(c.views) ? c.views : [];
  }

  async setSavedViews(views: SavedView[]): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.commitAccountData(VIEWS_EVENT_TYPE, { views });
  }

  // Manual bundles = user-authored named filters, synced via account data.
  // A bundle is { id, label, query }; the query is parsed by the shared
  // filter system, so manual bundles and search speak the same language.
  // The same account-data event also holds `hidden` (auto-bundle keys the
  // user has removed — their items fall into "Other") and `pinned` (bundle
  // keys the user pinned so the whole bundle floats to the top intact, as
  // opposed to pinning each member item individually).
  private getBundlesContent(): { bundles: ManualBundle[]; hidden: string[]; pinned: string[] } {
    if (!this.client) return { bundles: [], hidden: [], pinned: [] };
    const ev = this.client.getAccountData(BUNDLES_EVENT_TYPE as never);
    const c = (ev?.getContent() ?? {}) as { bundles?: ManualBundle[]; hidden?: string[]; pinned?: string[] };
    return {
      bundles: Array.isArray(c.bundles) ? c.bundles.filter((b) => b && b.id && b.query !== undefined) : [],
      hidden: Array.isArray(c.hidden) ? c.hidden.filter((s) => typeof s === 'string') : [],
      pinned: Array.isArray(c.pinned) ? c.pinned.filter((s) => typeof s === 'string') : [],
    };
  }

  getManualBundles(): ManualBundle[] { return this.getBundlesContent().bundles; }
  getHiddenBundles(): string[] { return this.getBundlesContent().hidden; }
  getPinnedBundleKeys(): string[] { return this.getBundlesContent().pinned; }

  async setManualBundles(bundles: ManualBundle[]): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.ensureConfigSeeded();
    const { hidden, pinned } = this.getBundlesContent();
    await this.commitAccountData(BUNDLES_EVENT_TYPE, { bundles, hidden, pinned });
  }

  async setHiddenBundles(hidden: string[]): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.ensureConfigSeeded();
    const { bundles, pinned } = this.getBundlesContent();
    await this.commitAccountData(BUNDLES_EVENT_TYPE, { bundles, hidden, pinned });
  }

  async setPinnedBundle(key: string, pinned: boolean): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.ensureConfigSeeded();
    const cur = this.getBundlesContent();
    const set = new Set(cur.pinned);
    if (pinned) set.add(key); else set.delete(key);
    await this.commitAccountData(BUNDLES_EVENT_TYPE, { bundles: cur.bundles, hidden: cur.hidden, pinned: [...set] });
  }

  getWeights(): PriorityWeights {
    if (!this.client) return DEFAULT_WEIGHTS;
    const ev = this.client.getAccountData(WEIGHTS_EVENT_TYPE as never);
    const c = (ev?.getContent() ?? {}) as Partial<PriorityWeights>;
    return {
      unread: typeof c.unread === 'number' ? c.unread : DEFAULT_WEIGHTS.unread,
      mention: typeof c.mention === 'number' ? c.mention : DEFAULT_WEIGHTS.mention,
      recent: typeof c.recent === 'number' ? c.recent : DEFAULT_WEIGHTS.recent,
      dm: typeof c.dm === 'number' ? c.dm : DEFAULT_WEIGHTS.dm,
      bridgeChat: typeof c.bridgeChat === 'number' ? c.bridgeChat : DEFAULT_WEIGHTS.bridgeChat,
      bot: typeof c.bot === 'number' ? c.bot : DEFAULT_WEIGHTS.bot,
      topLevel: typeof c.topLevel === 'number' ? c.topLevel : DEFAULT_WEIGHTS.topLevel,
      doneStatuses: Array.isArray(c.doneStatuses) ? c.doneStatuses : DEFAULT_WEIGHTS.doneStatuses,
      eventTypeAdjust: c.eventTypeAdjust && typeof c.eventTypeAdjust === 'object' ? c.eventTypeAdjust : {},
    };
  }

  async setWeights(w: PriorityWeights): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.commitAccountData(WEIGHTS_EVENT_TYPE, w as unknown as Record<string, unknown>);
  }

  async setManuallyUnread(itemId: string, unread: boolean): Promise<void> {
    await this.setManuallyUnreadBatch([itemId], unread);
  }

  // Batch variants do ONE read-modify-write. A per-item method in a loop
  // races: setAccountData only updates the local copy once the server echoes
  // it via sync, so each iteration reads stale state and the last write wins —
  // which is why "mark all" used to land on only one item.
  async setManuallyUnreadBatch(itemIds: string[], unread: boolean): Promise<void> {
    await this.mutateTriage((s) => {
      const set = new Set(s.manuallyUnread);
      for (const id of itemIds) { if (unread) set.add(id); else set.delete(id); }
      return { ...s, manuallyUnread: [...set] };
    });
  }

  async setSnoozedBatch(itemIds: string[], untilMs: number | null): Promise<void> {
    await this.mutateTriage((s) => {
      const snoozed = { ...s.snoozed };
      for (const id of itemIds) {
        if (untilMs && untilMs > Date.now()) snoozed[id] = untilMs;
        else delete snoozed[id];
      }
      return { ...s, snoozed };
    });
  }

  private async setTriageState(next: TriageState): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.commitAccountData(TRIAGE_EVENT_TYPE, next as unknown as Record<string, unknown>);
  }

  // Read-modify-write the triage blob, gated on the config seed so the merge base
  // is server-authoritative — otherwise a pin/snooze/mark-unread in the pre-seed
  // boot window (these are reachable straight from an inbox row) merges against an
  // empty local copy and the PUT wipes the rest of the user's triage. See
  // ensureConfigSeeded.
  private async mutateTriage(fn: (s: TriageState) => TriageState): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.ensureConfigSeeded();
    await this.setTriageState(fn(this.getTriageState()));
  }

  // Pinning a Matrix room maps to the standard m.favourite room tag, so it's
  // the SAME favourite Wally/Element show (shared via account data). Issues
  // and non-room items (jmap mail) have no room tag, so they fall back to our
  // own triage.pinned set.
  async setPinned(itemId: string, pinned: boolean): Promise<void> {
    // A plain Matrix room item (matrix:<roomId>, no :issue: suffix) maps to the
    // m.favourite room tag. Issues and jmap items have no room tag → triage.
    // Room ids may or may not contain a colon (v12 dropped the :server part),
    // so strip the prefix rather than matching a colon-less localpart — the old
    // /^matrix:([^:]+)$/ failed for every colon-containing (pre-v12) room, so
    // those pins silently fell back to triage instead of the shared favourite.
    const roomId = itemId.startsWith('matrix:') ? itemId.slice('matrix:'.length) : null;
    if (roomId && !roomId.includes(':issue:') && this.client) {
      try {
        if (pinned) await this.client.setRoomTag(roomId, 'm.favourite', { order: 0.5 });
        else await this.client.deleteRoomTag(roomId, 'm.favourite');
        this.notify();
        return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] setRoomTag favourite failed, falling back to triage', e);
      }
    }
    await this.mutateTriage((s) => {
      const set = new Set(s.pinned);
      if (pinned) set.add(itemId); else set.delete(itemId);
      return { ...s, pinned: [...set] };
    });
  }

  async setSnoozed(itemId: string, untilMs: number | null): Promise<void> {
    await this.mutateTriage((s) => {
      const snoozed = { ...s.snoozed };
      if (untilMs && untilMs > Date.now()) snoozed[itemId] = untilMs;
      else delete snoozed[itemId];
      return { ...s, snoozed };
    });
  }

  // Verify this device with an existing recovery key (e.g. signed in
  // on a new device, account already has cross-signing). We decode the
  // recovery key, hand it to the SDK to decrypt SSSS, and let
  // bootstrapCrossSigning(setupNewCrossSigning=false) fetch + trust
  // the existing master keys.
  async verifyWithRecoveryKey(recoveryKey: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const crypto = await this.ensureCrypto();
    // decodeRecoveryKey isn't re-exported from the package root — deep path.
    const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api/recovery-key.js');
    const decoded = decodeRecoveryKey(recoveryKey.trim());

    // Under sliding sync the secret-storage account data may not have synced into
    // the local store yet (it rides the slow room sync), so pull what the flow
    // needs straight from the server first — otherwise a fresh device wrongly
    // reports "no secret storage". The backup auto-restore on a healthy load
    // proves 4S exists on this account.
    const defaultKey = await this.ensureAccountData('m.secret_storage.default_key');
    const keyId = (defaultKey?.key as string | undefined) ?? (await this.client.secretStorage.getDefaultKeyId());
    if (!keyId) throw new Error('No secret storage (recovery key) is set up on this account.');
    // The key descriptor plus the encrypted secrets bootstrap needs to import.
    await Promise.all([
      this.ensureAccountData(`m.secret_storage.key.${keyId}`),
      this.ensureAccountData('m.cross_signing.master'),
      this.ensureAccountData('m.cross_signing.self_signing'),
      this.ensureAccountData('m.cross_signing.user_signing'),
      this.ensureAccountData('m.megolm_backup.v1'),
    ]);
    const keyInfo = (this.client.getAccountData(`m.secret_storage.key.${keyId}` as never)?.getContent()) as never;
    const ok = await this.client.secretStorage.checkKey(decoded, keyInfo);
    if (!ok) throw new Error('That recovery key does not match this account.');
    storePrivateKey(keyId, decoded);
    // Keep the legacy stash too — some callbacks/paths still read it.
    (window as unknown as { _wukkieKey?: Uint8Array })._wukkieKey = decoded;

    // The rust OlmMachine can only import our cross-signing PRIVATE keys (from 4S)
    // if it ALREADY holds our cross-signing PUBLIC keys — otherwise the import
    // fails SILENTLY and the SDK throws "importCrossSigningKeys failed to import
    // the keys" (CrossSigningIdentity.ts). Those public keys ride a /keys/query
    // for our OWN user, which under sliding sync has NOT run for ourselves on a
    // fresh device/login. Force that query now (downloadUncached=true) so the
    // public keys are present before bootstrapCrossSigning reads 4S.
    try {
      const selfId = this.client.getUserId();
      if (selfId) await crypto.userHasCrossSigningKeys(selfId, true);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] could not pre-download cross-signing public keys', e);
    }

    // Wally's proven order: bootstrapCrossSigning imports the cross-signing
    // private keys from 4S (so this device becomes verified and CAN request
    // verification); bootstrapSecretStorage wires everything up; then load the
    // backup key from 4S and restore the keys. Skipping bootstrapSecretStorage
    // left cross-signing un-imported ("no existing cross-signing key").
    await crypto.bootstrapCrossSigning({});
    await crypto.bootstrapSecretStorage({});
    try {
      await crypto.checkKeyBackupAndEnable?.();
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage?.();
      const res = await crypto.restoreKeyBackup?.();
      // eslint-disable-next-line no-console
      console.info('[wukkiemail] cross-signing imported + key backup restored', res ?? '(no result)');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] key backup restore failed (cross-signing may still have imported)', e);
    }
    this.notify();
  }

  // ── SAS (emoji) device verification ─────────────────────────────────
  //
  // Verifies this device against another of the user's own devices by
  // comparing seven emoji. Works both ways: startSelfVerification()
  // initiates; an inbound request is caught by the CryptoEvent listener
  // wired in start(). Either path funnels through adoptVerificationRequest,
  // which drives the request to the SAS phase and reports emoji via the
  // verifyListeners channel.

  onVerification(cb: (s: VerificationState) => void): () => void {
    this.verifyListeners.add(cb);
    cb(this.verifyState); // replay current state immediately
    return () => { this.verifyListeners.delete(cb); };
  }

  getVerificationState(): VerificationState { return this.verifyState; }

  private setVerifyState(patch: Partial<VerificationState>): void {
    this.verifyState = { ...this.verifyState, ...patch };
    for (const cb of this.verifyListeners) cb(this.verifyState);
  }

  // Begin verifying this device against the user's other devices.
  async startSelfVerification(): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const crypto = this.client.getCrypto?.();
    if (!crypto) throw new Error('crypto not initialised');
    try {
      const req = await crypto.requestOwnUserVerification();
      this.adoptVerificationRequest(req, false);
    } catch (e) {
      // Emoji verification needs an existing cross-signing identity to verify
      // against. A brand-new account has none yet — point the user at setup.
      if (/cross-signing/i.test(String(e))) {
        throw new Error('No cross-signing keys exist on your account yet. Choose "Set up fresh" to create them (or paste your recovery key if you set it up elsewhere).');
      }
      throw e;
    }
  }

  // Pull room keys from the server-side backup. Succeeds silently only when
  // the backup decryption key is already available to crypto (cached from a
  // persisted prior session); otherwise it needs the recovery key, which the
  // user supplies via verifyWithRecoveryKey.
  private async tryRestoreKeyBackup(): Promise<void> {
    const crypto = this.client?.getCrypto?.();
    if (!crypto) return;
    try {
      await crypto.checkKeyBackupAndEnable?.();
      // If the crypto store persisted (lite storage keeps it on IndexedDB),
      // the backup decryption key cached during a prior recovery-key verify is
      // still here — so this restores history WITHOUT re-entering the key.
      try { await crypto.loadSessionBackupPrivateKeyFromSecretStorage?.(); } catch { /* needs recovery key */ }
      const res = await crypto.restoreKeyBackup?.();
      if (res) {
        // eslint-disable-next-line no-console
        console.info('[wukkiemail] auto-restored key backup', res);
        this.notify();
      }
    } catch { /* needs recovery key — handled by the encryption block */ }
  }

  // Verify one specific other device of ours (emoji SAS), driven through the
  // same verification state channel / sheet as self-verification.
  async startDeviceVerification(deviceId: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const crypto = this.client.getCrypto?.();
    if (!crypto) throw new Error('crypto not initialised');
    const selfId = this.client.getUserId() ?? '';
    const req = await crypto.requestDeviceVerification(selfId, deviceId);
    this.adoptVerificationRequest(req, false);
  }

  // ── Device management ───────────────────────────────────────────────
  async listDevices(): Promise<DeviceEntry[]> {
    if (!this.client) return [];
    const selfId = this.client.getUserId() ?? '';
    const thisId = this.client.getDeviceId() ?? '';
    const crypto = this.client.getCrypto?.();
    const res = await this.client.getDevices();
    const out: DeviceEntry[] = [];
    for (const d of res.devices) {
      let verified = false;
      if (crypto) {
        try { verified = (await crypto.getDeviceVerificationStatus(selfId, d.device_id))?.isVerified() ?? false; }
        catch { /* unknown */ }
      }
      out.push({
        deviceId: d.device_id,
        displayName: d.display_name ?? '',
        lastSeenTs: d.last_seen_ts,
        lastSeenIp: d.last_seen_ip,
        isCurrent: d.device_id === thisId,
        verified,
      });
    }
    out.sort((a, b) =>
      (a.isCurrent ? -1 : b.isCurrent ? 1 : 0) || ((b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0)));
    return out;
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    if (!this.client) return;
    await this.client.setDeviceDetails(deviceId, { display_name: name });
    this.notify();
  }

  // Deleting a device needs User-Interactive Auth (the account password). Try
  // without auth first; on the 401 challenge, retry with the password.
  async deleteDevice(deviceId: string, password: string): Promise<void> {
    if (!this.client) return;
    const selfId = this.client.getUserId() ?? '';
    try {
      await this.client.deleteDevice(deviceId);
    } catch {
      await this.client.deleteDevice(deviceId, {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: selfId },
        password,
      } as never);
    }
    this.notify();
  }

  // Wire a request (inbound or outbound) up to our state channel and drive
  // it through to SAS. Idempotent guard: only track one at a time.
  private adoptVerificationRequest(req: VerificationRequest, incoming: boolean): void {
    // Drop any stale prior request.
    this.teardownVerification();
    this.verifyReq = req;
    this.setVerifyState({
      phase: 'requested',
      incoming,
      otherDeviceId: req.otherDeviceId,
      emoji: undefined,
      error: undefined,
    });

    const onChange = () => { void this.onRequestChange(req); };
    req.on(VerificationRequestEvent.Change, onChange);
    // Kick once in case it's already past Requested.
    void this.onRequestChange(req);
  }

  private async onRequestChange(req: VerificationRequest): Promise<void> {
    if (req !== this.verifyReq) return; // superseded
    if (req.phase === VerificationPhase.Cancelled) {
      this.setVerifyState({ phase: 'cancelled' });
      this.teardownVerification();
      return;
    }
    if (req.phase === VerificationPhase.Done) {
      this.setVerifyState({ phase: 'done', emoji: undefined });
      this.teardownVerification();
      this.notify();
      return;
    }
    // Initiator: once the other side is ready, kick off SAS. Only the initiator
    // starts — if both started we'd glare and the emoji could land on a verifier
    // we never attached to (the bug where one side shows emoji, the other doesn't).
    // The receiver waits for Started below and adopts the initiator's verifier.
    if (
      req.phase === VerificationPhase.Ready &&
      req.initiatedByMe &&
      !req.verifier &&
      !this.verifier
    ) {
      try {
        const verifier = await req.startVerification('m.sas.v1');
        this.attachVerifier(verifier);
      } catch (e) {
        this.setVerifyState({ phase: 'cancelled', error: String(e) });
        this.teardownVerification();
      }
      return;
    }
    // Either side: adopt the verifier once SAS has started.
    if (req.phase === VerificationPhase.Started && req.verifier && !this.verifier) {
      this.attachVerifier(req.verifier);
    }
  }

  // User pressed "Accept" on an incoming request (mirrors Wally's accept step).
  async acceptVerification(): Promise<void> {
    if (!this.verifyReq) return;
    try {
      await this.verifyReq.accept();
      this.setVerifyState({ accepted: true });
    } catch (e) {
      this.setVerifyState({ phase: 'cancelled', error: String(e) });
      this.teardownVerification();
    }
  }

  private attachVerifier(verifier: Verifier): void {
    this.verifier = verifier;
    // Attach the ShowSas listener BEFORE verify() drives the handshake, so the
    // emoji event is never missed (same ordering as Wally's SasVerification).
    verifier.on(VerifierEvent.ShowSas, (sas: ShowSasCallbacks) => {
      this.sasCallbacks = sas;
      this.lastSasNames = (sas.sas.emoji ?? []).map(([, name]) => name).join(' ');
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail][verify] SAS emoji:', this.lastSasNames);
      this.setVerifyState({ phase: 'sas', emoji: sas.sas.emoji });
    });
    verifier.on(VerifierEvent.Cancel, (e: unknown) => {
      const reason = describeVerificationCancel(e);
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail][verify] cancelled:', reason, e);
      this.setVerifyState({ phase: 'cancelled', error: reason });
      this.teardownVerification();
    });
    // verify() resolves when the whole flow completes; errors when cancelled.
    verifier.verify().catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail][verify] verify() rejected:', describeVerificationCancel(e), e);
      /* phase surfaced via the Cancel handler above */
    });
  }

  // User pressed "They match". From this instant the mismatch path is dead:
  // mark confirmSent and DROP sasCallbacks BEFORE awaiting confirm(), so a scrim
  // or close click landing during the (network-bound) confirm can no longer reach
  // sasCallbacks.mismatch(). The sheet moves to a "finishing" view (confirmed:true)
  // with no destructive buttons; completion arrives via onRequestChange → done.
  async confirmVerification(): Promise<void> {
    const cb = this.sasCallbacks;
    if (!cb) return;
    this.confirmSent = true;
    this.sasCallbacks = null;
    this.setVerifyState({ confirmed: true });
    // eslint-disable-next-line no-console
    console.warn('[wukkiemail][verify] confirm() — matched SAS:', this.lastSasNames);
    try {
      await cb.confirm();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wukkiemail][verify] confirm() threw:', e);
      throw e;
    }
  }

  // User pressed "They don't match" or closed the sheet. Once the user has
  // affirmed a match (confirmSent), this is a NO-OP — we never convert a confirmed
  // match into an m.mismatched_sas cancel; the in-flight completion is left to land.
  cancelVerification(): void {
    if (this.confirmSent) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail][verify] cancel ignored — already confirmed match');
      return;
    }
    try {
      if (this.sasCallbacks) {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail][verify] mismatch() sent by user — SAS was:', this.lastSasNames);
        this.sasCallbacks.mismatch();
      } else if (this.verifier) this.verifier.cancel(new Error('cancelled by user'));
      else if (this.verifyReq) void this.verifyReq.cancel();
    } catch { /* best effort */ }
    this.setVerifyState({ phase: 'cancelled' });
    this.teardownVerification();
  }

  // Reset to idle (e.g. after the user dismisses a done/cancelled sheet).
  resetVerification(): void {
    this.teardownVerification();
    this.setVerifyState({ phase: 'idle', emoji: undefined, error: undefined, otherDeviceId: undefined, incoming: undefined, accepted: undefined, confirmed: undefined });
  }

  private teardownVerification(): void {
    this.verifyReq?.removeAllListeners?.(VerificationRequestEvent.Change);
    this.verifier?.removeAllListeners?.(VerifierEvent.ShowSas);
    this.verifier?.removeAllListeners?.(VerifierEvent.Cancel);
    this.verifyReq = null;
    this.verifier = null;
    this.sasCallbacks = null;
    this.confirmSent = false;
  }

  // Bootstrap encryption: cross-signing keys + secret storage backed by
  // a recovery key. Takes the user's account password for UIA (Matrix
  // homeservers require it for uploading device signing keys). Returns
  // the encoded recovery key the user must save out-of-band.
  //
  // This is the one-time setup for a fresh account. Subsequent devices
  // verify against this key (different flow).
  // Returns the crypto API, initialising it on demand if startup couldn't.
  // Tries IndexedDB then an in-memory store (broken-IDB devices). Throws a
  // human-readable error if crypto genuinely can't come up so the setup UI
  // shows something better than "crypto not initialised".
  private async ensureCrypto() {
    if (!this.client) throw new Error('client not started');
    let crypto = this.client.getCrypto?.();
    if (crypto) return crypto;
    // Same DETERMINISTIC device-scoped prefix as the boot path (see initRustCrypto
    // at startup): the store MUST be keyed by (userId, deviceId) so on-demand
    // init reopens the SAME persistent store rather than the shared default one.
    const devicePrefix = `wukkiemail-crypto:${this.client.getUserId() ?? 'u'}:${this.client.getDeviceId() ?? 'd'}`;
    try {
      await this.client.initRustCrypto({ cryptoDatabasePrefix: devicePrefix });
    } catch {
      try { await this.client.initRustCrypto({ useIndexedDB: false }); } catch { /* fall through */ }
    }
    crypto = this.client.getCrypto?.();
    if (!crypto) {
      throw new Error('Encryption is unavailable on this device — the crypto store could not be initialised (often a broken or blocked IndexedDB). Try another browser, or disable private/incognito mode.');
    }
    return crypto;
  }

  async bootstrapEncryption(password: string): Promise<string> {
    if (!this.client) throw new Error('client not started');
    const crypto = await this.ensureCrypto();
    const selfId = this.client.getUserId() ?? '';

    // 1) Generate the recovery key and stash its bytes for the
    // getSecretStorageKey callback to find. THEN bootstrap secret
    // storage with it. Order matters: cross-signing wants to write
    // its keys into an existing SSSS, not the other way around.
    const recoveryKey = await crypto.createRecoveryKeyFromPassphrase();
    (window as unknown as { _wukkieKey?: Uint8Array })._wukkieKey = recoveryKey.privateKey;
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => recoveryKey,
      setupNewKeyBackup: true,
      setupNewSecretStorage: true,
    });

    // 2) Cross-signing keys. UIA replays the password.
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        await makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: selfId },
          password,
        });
      },
    });

    this.notify();
    return recoveryKey.encodedPrivateKey ?? '';
  }

  // Encryption setup status.
  //   'none'      — crypto failed to initialise or isn't available
  //   'setup'     — crypto running, cross-signing not bootstrapped yet
  //   'unverified'— cross-signing keys exist but this device isn't verified
  //   'verified'  — fully set up
  // We deliberately collapse server quirks into this 4-state enum so the
  // UI can show one banner without juggling SDK details.
  async getCryptoStatus(): Promise<'none' | 'setup' | 'unverified' | 'verified'> {
    if (!this.client) return 'none';
    const crypto = this.client.getCrypto?.();
    if (!crypto) return 'none';
    try {
      const selfId = this.client.getUserId() ?? '';
      const status = await crypto.getUserVerificationStatus(selfId);
      const deviceStatus = await crypto.getDeviceVerificationStatus(selfId, this.client.getDeviceId() ?? '');
      if (deviceStatus?.crossSigningVerified) return 'verified';
      if (status?.isCrossSigningVerified()) return 'unverified';
      return 'setup';
    } catch {
      return 'setup';
    }
  }

  // True if any joined room has m.room.encryption state — used to decide
  // whether the crypto banner is worth showing at all.
  hasAnyEncryptedRoom(): boolean {
    if (!this.client) return false;
    return this.client.getRooms().some((r) => {
      const ev = r.currentState.getStateEvents('m.room.encryption', '');
      return !!ev;
    });
  }

  // Resolve an mxc:// URI to an HTTP thumbnail (used for custom emoji in
  // formatted_body). Returns null if not logged in or the URI is bad.
  mxcToHttp(mxc: string, w = 32, h = 32): string | null {
    if (!this.client) return null;
    try { return this.client.mxcUrlToHttp(mxc, w, h, 'scale') ?? null; }
    catch { return null; }
  }

  // Download + decrypt an encrypted attachment (E2EE m.image/file) and return
  // a blob: URL the caller is responsible for revoking. null on failure.
  async decryptMedia(file: EncryptedFile, mimetype?: string): Promise<string | null> {
    if (!this.client) return null;
    const httpUrl = this.client.mxcUrlToHttp(file.url);
    if (!httpUrl) return null;
    try {
      const res = await fetch(httpUrl);
      if (!res.ok) return null;
      const plain = await decryptAttachment(await res.arrayBuffer(), file);
      const blob = new Blob([plain], { type: mimetype || 'application/octet-stream' });
      return URL.createObjectURL(blob);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] decryptMedia failed', e);
      return null;
    }
  }

  // Names of users currently typing in a room, excluding ourselves.
  // Empty list when we don't have the room cached yet or nobody's
  // typing. Refreshes via the subscribe() channel when typing events
  // flip member.typing (the SDK fires RoomMember.typing, which feeds
  // into our generic sync notify).
  getTypingUsers(roomId: string): string[] {
    if (!this.client) return [];
    const room = this.client.getRoom(roomId);
    if (!room) return [];
    const self = this.client.getUserId() ?? '';
    return room.getMembers()
      .filter((m) => m.typing && m.userId !== self)
      .map((m) => m.name ?? m.userId);
  }

  // Show a browser notification for a recent room event the user
  // probably cares about. Caller decides whether the user has granted
  // permission (we just fire if Notification.permission === 'granted').
  // Triggered from a Room.timeline listener — keeps us out of any push
  // gateway setup. The notification's click focuses our tab; that's it
  // for now.
  private startNotificationListener(): void {
    if (!this.client) return;
    if (typeof Notification === 'undefined') return;
    const selfId = this.client.getUserId() ?? '';
    const startedAt = Date.now();
    const onEvent = (event: MatrixEvent, room?: Room) => {
      try {
        if (!room) return;
        if (event.getType() !== 'm.room.message') return;
        // Index every incoming message (incl. our own) for full-text search.
        const doc = this.eventToDoc(event, room.roomId, room.name || room.roomId);
        if (doc) void this.search.addMessages([doc]);
        if (event.getSender() === selfId) return;
        // Skip backfill — only notify for events that arrived after we
        // hooked the listener.
        if (event.getTs() < startedAt) return;
        // Only highlight events: a mention/keyword, or any message in a DM.
        const isDm = !!this.buildBundleIndex().get(room.roomId)?.includes('dm');
        const highlight = (room.getUnreadNotificationCount?.('highlight' as never) ?? 0) > 0;
        if (!isDm && !highlight) return;
        // Don't double-fire when the tab is focused.
        if (document.visibilityState === 'visible') return;
        if (Notification.permission !== 'granted') return;
        const senderMember = room.getMember(event.getSender() ?? '');
        const from = senderMember?.name ?? event.getSender() ?? '?';
        const body = (event.getContent() as { body?: string }).body ?? '';
        const n = new Notification(`${from} · ${room.name || 'Matrix'}`, {
          body: body.slice(0, 140),
          icon: '/icons/android-192.png',
          tag: room.roomId, // collapse multiple notifs from the same room
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] notif handler threw', e);
      }
    };
    this.client.on('Room.timeline' as never, onEvent as never);
  }

  // Public: request browser notification permission, called from a user
  // gesture (button) so browsers don't reject the prompt.
  async requestNotificationPermission(): Promise<NotificationPermission> {
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    return Notification.requestPermission();
  }

  getNotificationPermission(): NotificationPermission | 'unsupported' {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }

  // Upload a file to the homeserver's media repo and send an m.image
  // (or m.file) event referencing it. For images we sniff w/h via an
  // off-DOM Image so receivers don't get a layout jump.
  async uploadAndSendFile(roomId: string, file: File): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const isImage = file.type.startsWith('image/');
    const uploadRes = await this.client.uploadContent(file, { type: file.type });
    const mxc = (uploadRes as { content_uri?: string }).content_uri;
    if (!mxc) throw new Error('upload returned no content_uri');
    const content: Record<string, unknown> = {
      msgtype: isImage ? 'm.image' : 'm.file',
      body: file.name,
      url: mxc,
      info: { mimetype: file.type, size: file.size },
    };
    if (isImage) {
      const dims = await readImageDimensions(file);
      if (dims) (content.info as Record<string, unknown>).w = dims.w, (content.info as Record<string, unknown>).h = dims.h;
    }
    await this.client.sendMessage(roomId, content as never);
  }

  // Drop any failed local echoes from a room: removes the phantom "sent"
  // message from view AND clears the SDK send queue (a not_sent event blocks
  // subsequent sends in that room until cancelled). Called after a send fails.
  cancelFailedEvents(roomId: string): void {
    if (!this.client) return;
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const evs = room.getPendingEvents?.() ?? room.getLiveTimeline().getEvents();
    for (const ev of evs) {
      const st = (ev as unknown as { status?: string }).status;
      if (st === 'not_sent' || st === 'queued') {
        try { this.client.cancelPendingEvent(ev); } catch { /* already gone */ }
      }
    }
    this.notify();
  }

  // Send our own typing state. The SDK debounces and resends so a
  // 30s timeout is fine — call again if the user keeps typing.
  async sendTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
    if (!this.client) return;
    try { await this.client.sendTyping(roomId, typing, timeoutMs); }
    catch (e) { /* ignore — server may have disabled typing */ void e; }
  }

  // Joined members of a room (excluding ourselves), for @-mention
  // autocomplete. Sorted by display name. Avatars resolved to thumbnails.
  getRoomMembers(roomId: string): { userId: string; name: string; avatarUrl?: string }[] {
    if (!this.client) return [];
    const room = this.client.getRoom(roomId);
    if (!room) return [];
    const selfId = this.client.getUserId();
    const out: { userId: string; name: string; avatarUrl?: string }[] = [];
    for (const m of room.getJoinedMembers()) {
      if (m.userId === selfId) continue;
      let avatarUrl: string | undefined;
      const mxc = m.getMxcAvatarUrl?.();
      if (mxc) {
        const url = this.client.mxcUrlToHttp(mxc, 64, 64, 'crop');
        if (url) avatarUrl = url;
      }
      out.push({ userId: m.userId, name: m.name || m.userId, avatarUrl });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // getRoomMembers only sees the members the SDK happens to know — senders in
  // the loaded timeline ($LAZY) — so the roster comes up partial, which is why
  // @-mention autocomplete and the person picker miss people. Force a full
  // /members fetch, then return the complete list.
  //
  // Under sliding sync loadMembersIfNeeded is a NO-OP: lazyLoadMembers is off
  // on that path (see startClient above), so the SDK pre-resolves membersLoaded
  // and never hits /members — the roster stays $LAZY-only forever (bridged
  // Signal group members show as bare mxids). forceLoadMembers (fork) fetches
  // /members regardless. The .d.ts doesn't declare it yet, hence the cast —
  // same idiom as cinny-wally useRoomMembers.ts. Both cache, so repeat calls
  // are cheap.
  async loadRoomMembers(roomId: string): Promise<{ userId: string; name: string; avatarUrl?: string }[]> {
    if (!this.client) return [];
    const room = this.client.getRoom(roomId);
    if (!room) return [];
    const forceable = room as unknown as { forceLoadMembers?: () => Promise<unknown> };
    try {
      await (this.slidingSync && forceable.forceLoadMembers
        ? forceable.forceLoadMembers()
        : room.loadMembersIfNeeded());
    } catch { /* fall back to what we have */ }
    return this.getRoomMembers(roomId);
  }

  // Search users for a person picker.
  //   roomId set  → restrict to that room's members (e.g. issue assignee).
  //   roomId unset → known contacts (everyone across your joined rooms) plus
  //                  the homeserver user directory, merged and de-duped.
  // An empty query returns the local candidates (members / contacts) so the
  // dropdown can show something before the user types.
  async searchUsers(query: string, roomId?: string): Promise<PersonHit[]> {
    if (!this.client) return [];
    const q = query.trim().toLowerCase();
    const matches = (h: PersonHit) =>
      !q || h.userId.toLowerCase().includes(q) || h.name.toLowerCase().includes(q);

    if (roomId) {
      return (await this.loadRoomMembers(roomId)).filter(matches);
    }

    const selfId = this.client.getUserId();
    const known = new Map<string, PersonHit>();
    const avatarOf = (mxc?: string | null): string | undefined => {
      if (!mxc) return undefined;
      const url = this.client!.mxcUrlToHttp(mxc, 64, 64, 'crop');
      return url ?? undefined;
    };
    for (const room of this.client.getRooms()) {
      for (const m of room.getJoinedMembers()) {
        if (m.userId === selfId || known.has(m.userId)) continue;
        const hit: PersonHit = { userId: m.userId, name: m.name || m.userId, avatarUrl: avatarOf(m.getMxcAvatarUrl?.()) };
        if (matches(hit)) known.set(m.userId, hit);
      }
    }
    // The server directory finds people you don't already share a room with.
    // It may be disabled by the homeserver — ignore failures.
    if (q) {
      try {
        const res = await this.client.searchUserDirectory({ term: query.trim(), limit: 20 });
        for (const u of res.results) {
          if (u.user_id === selfId || known.has(u.user_id)) continue;
          known.set(u.user_id, { userId: u.user_id, name: u.display_name || u.user_id, avatarUrl: avatarOf(u.avatar_url) });
        }
      } catch { /* directory disabled / offline */ }
    }
    return [...known.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50);
  }

  // Synchronously resolve a userId to a display name + avatar from any joined
  // room — used to render picked-person chips without an async round-trip.
  resolveUser(userId: string): PersonHit {
    if (!this.client) return { userId, name: userId };
    for (const room of this.client.getRooms()) {
      const m = room.getMember(userId);
      if (m) {
        const mxc = m.getMxcAvatarUrl?.();
        const url = mxc ? this.client.mxcUrlToHttp(mxc, 64, 64, 'crop') : null;
        return { userId, name: m.name || userId, avatarUrl: url ?? undefined };
      }
    }
    return { userId, name: userId };
  }

  // Send a plain text message to a room. For encrypted rooms this will
  // fail until we wire crypto — caller surfaces the error.
  async redactMessage(roomId: string, eventId: string, reason?: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
  }

  async editMessage(roomId: string, originalEventId: string, body: string, html?: string | null): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const newContent: Record<string, unknown> = { msgtype: 'm.text', body };
    if (html) {
      newContent.format = 'org.matrix.custom.html';
      newContent.formatted_body = html;
    }
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: originalEventId },
    };
    if (html) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = `* ${html}`;
    }
    await this.client.sendMessage(roomId, content as never);
  }

  async sendMessage(
    roomId: string, body: string, html?: string | null,
    replyTo?: { eventId: string; senderName: string; body: string } | null,
    mentionUserIds?: string[],
    threadRootId?: string | null,
  ): Promise<void> {
    if (!this.client) throw new Error('client not started');
    const content: Record<string, unknown> = { msgtype: 'm.text', body };
    if (html) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    // Intentional mentions (MSC3952 / matrix v1.7) so the mentioned user's
    // push rules fire even without a keyword match.
    if (mentionUserIds && mentionUserIds.length > 0) {
      content['m.mentions'] = { user_ids: [...new Set(mentionUserIds)] };
    }
    if (replyTo) {
      // A reply, possibly inside a thread. The thread relation (if any) is the
      // outer rel_type; the in_reply_to points at the specific message.
      const relates: Record<string, unknown> = { 'm.in_reply_to': { event_id: replyTo.eventId } };
      if (threadRootId) {
        relates.rel_type = 'm.thread';
        relates.event_id = threadRootId;
        relates.is_falling_back = false; // an explicit in-thread reply, not a fallback
      }
      content['m.relates_to'] = relates;
      // Plain-body fallback per the rich-reply spec.
      const quoted = replyTo.body.split('\n').map((l) => `> ${l}`).join('\n');
      content.body = `${quoted}\n\n${body}`;
      // Formatted fallback wraps original in <mx-reply>; we use a small
      // synthetic one without a permalink (clients tolerate this).
      const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const replyHtml = html ?? escHtml(body);
      content.formatted_body =
        `<mx-reply><blockquote><strong>${escHtml(replyTo.senderName)}:</strong> ${escHtml(replyTo.body)}</blockquote></mx-reply>${replyHtml}`;
      content.format = 'org.matrix.custom.html';
    } else if (threadRootId) {
      // A plain thread message. Per the threads spec we fall back to a reply to
      // the latest event in the thread (so non-threaded clients still render it
      // in order) with is_falling_back: true.
      content['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: threadRootId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: this.latestThreadEventId(roomId, threadRootId) },
      };
    }
    await this.client.sendMessage(roomId, content as never);
  }

  // Newest event in a thread (the root if it has no replies yet) — the target
  // for a falling-back in_reply_to on the next thread message.
  private latestThreadEventId(roomId: string, rootId: string): string {
    const room = this.client?.getRoom(roomId);
    if (!room) return rootId;
    let latestId = rootId; let latestTs = -1;
    for (const ev of room.getLiveTimeline().getEvents()) {
      const r = (ev.getContent() as { 'm.relates_to'?: { rel_type?: string; event_id?: string } })['m.relates_to'];
      if (r?.rel_type !== 'm.thread' || r.event_id !== rootId) continue;
      if (ev.getTs() >= latestTs) { latestTs = ev.getTs(); latestId = ev.getId() ?? latestId; }
    }
    return latestId;
  }

  // Mark a room read at its newest message. The SDK fires off a /receipt
  // request; on success the next listItems() will compute unread=0 for
  // this room. Fails silently if the room or messages aren't ready yet —
  // we'll get another chance on the next sync transition.
  async markRoomRead(roomId: string): Promise<void> {
    if (!this.client) return;
    const room = this.client.getRoom(roomId);
    if (!room) return;
    // Clear any manual-unread flag too: reading a room must not leave it stuck
    // unread. The manuallyUnread overlay forces unread=true / unreadCount>=1
    // independent of the real count, so a flag set (deliberately, or by the old
    // "click sticks it unread" race) survived the receipt + count zeroing and
    // re-forced "1 unread" — making the room loop forever in next/previous
    // (ganza). Only write when actually flagged, to avoid an account-data write
    // on every room open.
    const itemId = `matrix:${roomId}`;
    if (this.getTriageState().manuallyUnread.includes(itemId)) {
      void this.setManuallyUnread(itemId, false);
    }
    // Zero the local unread counts FIRST, regardless of whether a receipt gets
    // sent. getUnreadNotificationCount otherwise stays stale until /sync echoes
    // back, so the inbox keeps showing the room unread — and a room with a
    // server unread count but ZERO loaded timeline events (lean sliding sync)
    // has nothing to receipt, so this is the only thing that clears it.
    room.setUnreadNotificationCount('total' as never, 0);
    room.setUnreadNotificationCount('highlight' as never, 0);
    this.notify();
    const events = room.getLiveTimeline().getEvents();
    const last = events[events.length - 1];
    if (!last) {
      // Nothing loaded to receipt (lean sliding sync left this room with a
      // server unread count but no events). The optimistic zero above already
      // cleared the inbox; kick off a room subscription so its timeline loads
      // and a later mark-read can advance the server-side marker.
      this.subscribeRoom(roomId);
      return;
    }
    try {
      // Receipt the ACTUAL last event, state or not. Continuwuity accepts
      // receipts on state events (incl. eu.kiefte.issue) — its read marker sits
      // on them — so advancing the marker to the true end of the room is correct.
      // Skipping state events (an earlier attempt) wrongly left the marker behind
      // the trailing issue/member events.
      await this.client.sendReadReceipt(last);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] sendReadReceipt failed for', roomId, e);
    }
  }

  // Pull recent timeline messages for a room. Drops state events and
  // anything without a body (we'll add nicer renderers later).
  getRoomTimeline(roomId: string, limit = 50, threadRootId?: string): RoomTimelineSnapshot | null {
    if (!this.client) return null;
    const room = this.client.getRoom(roomId);
    if (!room) return null;
    const messages: TimelineMessage[] = [];
    const live = room.getLiveTimeline().getEvents();
    // Local-echo (pending) events are DETACHED from the live timeline under the
    // SDK's pending-event ordering, so a just-sent message would be invisible
    // until the server echoes it back — it looked like the message vanished into
    // the ether. Merge the pending queue in (deduped; they sort newest, after the
    // live events) so it shows immediately, flagged `pending` for a "sending" look
    // until the real echo replaces it.
    const pending = room.getPendingEvents?.() ?? [];
    const liveIds = new Set(live.map((e) => e.getId()));
    const all = pending.length ? [...live, ...pending.filter((e) => !liveIds.has(e.getId()))] : live;
    const selfId = this.client.getUserId() ?? '';

    // Edits index: targetEventId -> latest replacement content. We pick
    // the highest-ts m.replace from the original sender (per spec).
    const editIdx = new Map<string, { body: string; html?: string; ts: number; senderId: string }>();
    for (const ev of all) {
      if (ev.getType() !== 'm.room.message') continue;
      const c = ev.getContent() as {
        body?: string; format?: string; formatted_body?: string;
        'm.new_content'?: { body?: string; format?: string; formatted_body?: string };
        'm.relates_to'?: { rel_type?: string; event_id?: string };
      };
      const rt = c['m.relates_to'];
      if (rt?.rel_type !== 'm.replace' || !rt.event_id) continue;
      const newC = c['m.new_content'];
      if (!newC?.body) continue;
      const senderId = ev.getSender() ?? '';
      const prev = editIdx.get(rt.event_id);
      if (!prev || ev.getTs() > prev.ts) {
        editIdx.set(rt.event_id, {
          body: newC.body,
          html: newC.format === 'org.matrix.custom.html' ? newC.formatted_body : undefined,
          ts: ev.getTs(),
          senderId,
        });
      }
    }

    // Build a reactions index: target event_id -> key -> Set<senderId>.
    // Also note our own reaction event ids so we can redact on toggle.
    const reactionIdx = new Map<string, Map<string, Set<string>>>();
    for (const ev of all) {
      if (ev.getType() !== 'm.reaction') continue;
      const c = ev.getContent() as { 'm.relates_to'?: { event_id?: string; key?: string; rel_type?: string } };
      const r = c['m.relates_to'];
      if (!r || r.rel_type !== 'm.annotation' || !r.event_id || !r.key) continue;
      const sender = ev.getSender() ?? '';
      const byTarget = reactionIdx.get(r.event_id) ?? new Map<string, Set<string>>();
      const senders = byTarget.get(r.key) ?? new Set<string>();
      senders.add(sender);
      byTarget.set(r.key, senders);
      reactionIdx.set(r.event_id, byTarget);
      if (sender === selfId) {
        // Cache our own reaction event id for redaction on toggle-off.
        const evId = ev.getId();
        if (evId) this.selfReactionIds.set(reactionKey(r.event_id, r.key), evId);
      }
    }

    // Thread index: rootEventId -> reply count + latest reply (for the "N
    // replies" affordance in the main timeline and for thread-aware sends).
    // Threads carry m.relates_to.rel_type === 'm.thread'; the relation is in
    // the (decrypted) content so getContent() sees it in E2EE rooms too.
    const threadIdx = new Map<string, { count: number; latestTs: number; latestEventId: string }>();
    for (const ev of all) {
      const c = ev.getContent() as { 'm.relates_to'?: { rel_type?: string; event_id?: string } };
      const r = c['m.relates_to'];
      if (r?.rel_type !== 'm.thread' || !r.event_id) continue;
      if (ev.isRedacted?.()) continue;
      const ets = ev.getTs();
      const eid = ev.getId() ?? '';
      const prev = threadIdx.get(r.event_id);
      if (!prev) threadIdx.set(r.event_id, { count: 1, latestTs: ets, latestEventId: eid });
      else { prev.count++; if (ets >= prev.latestTs) { prev.latestTs = ets; prev.latestEventId = eid; } }
    }

    // Accumulator for a run of consecutive membership/state changes (newest-first,
    // since the loop walks backwards). Flushed as ONE folded summary message when a
    // real message interrupts the run or the loop ends. This is also why "Load
    // older" through a window full of joins/leaves now shows something instead of
    // silently adding nothing: the run becomes a visible one-line block.
    let pendingState: { lines: string[]; count: number; ts: number; firstId: string } | null = null;
    const flushState = () => {
      if (!pendingState) return;
      messages.push({
        id: `state:${pendingState.firstId}`,
        kind: 'state',
        stateLines: pendingState.lines.slice().reverse(), // collected newest-first → chronological
        stateCount: pendingState.count,
        senderId: '',
        senderName: '',
        body: '',
        msgtype: 'm.room.member',
        ts: pendingState.ts,
      });
      pendingState = null;
    };

    for (let i = all.length - 1; i >= 0 && messages.length < limit; i--) {
      const ev = all[i];
      const type = ev.getType();
      // Fold membership / room-state changes into a one-line summary rather than
      // dropping them. Not in thread view (threads show only message events).
      if (!threadRootId && SUMMARIZABLE_STATE.has(type)) {
        const line = formatStateEvent(ev, room);
        if (line) {
          if (!pendingState) {
            pendingState = { lines: [], count: 0, ts: ev.getTs(), firstId: ev.getId() ?? String(ev.getTs()) };
          }
          pendingState.count += 1;
          if (pendingState.lines.length < 60) pendingState.lines.push(line); // cap formatting; count keeps the true total
        }
        continue;
      }
      if (type !== 'm.room.message' && type !== 'm.room.encrypted' && type !== 'm.sticker') continue;
      if (ev.isRedacted?.()) continue;
      // Hide failed/cancelled local echoes — showing them looks as if the
      // message sent. The composer keeps the text (and the queue is cleared
      // via cancelFailedEvents) so the user can retry.
      const st = (ev as unknown as { status?: string }).status;
      if (st === 'not_sent' || st === 'cancelled') continue;
      // Skip the edit events themselves — they're applied via editIdx.
      const earlyContent = ev.getContent() as { 'm.relates_to'?: { rel_type?: string; event_id?: string } };
      if (earlyContent['m.relates_to']?.rel_type === 'm.replace') continue;
      // Thread routing. A thread reply has rel_type 'm.thread'; its root is
      // event_id. In thread mode we keep only the root event and its replies;
      // in the main timeline we hide thread replies (they live in the thread
      // view, Element-style) so the inbox preview isn't doubled up.
      const evThreadRoot = earlyContent['m.relates_to']?.rel_type === 'm.thread'
        ? earlyContent['m.relates_to']?.event_id : undefined;
      if (threadRootId) {
        if (ev.getId() !== threadRootId && evThreadRoot !== threadRootId) continue;
      } else if (evThreadRoot) {
        continue;
      }
      const content = ev.getContent() as {
        body?: string; msgtype?: string;
        url?: string; file?: EncryptedFile; info?: { w?: number; h?: number; mimetype?: string; size?: number };
        format?: string; formatted_body?: string;
        'm.relates_to'?: { 'm.in_reply_to'?: { event_id?: string } };
      };
      // When the message is a rich reply, strip the spec's '> quoted'
      // fallback prefix from the plain body; the formatted_body keeps
      // the styled <mx-reply> block so the quote still shows.
      const isReply = !!content['m.relates_to']?.['m.in_reply_to']?.event_id;
      const stripReplyFallback = (s: string) => {
        const lines = s.split('\n');
        let i = 0;
        while (i < lines.length && lines[i].startsWith('>')) i++;
        // Skip the blank line separator the spec mandates.
        if (i < lines.length && lines[i] === '') i++;
        return lines.slice(i).join('\n');
      };
      const senderId = ev.getSender() ?? '?';
      const senderMember = room.getMember(senderId);
      const msgtype = content.msgtype ?? type;
      const rawBody = type === 'm.room.encrypted'
        ? '(encrypted — body not available)'
        : (content.body ?? `[${msgtype}]`);
      const msg: TimelineMessage = {
        id: ev.getId() ?? String(ev.getTs()),
        senderId,
        senderName: senderMember?.name ?? senderId,
        body: isReply ? stripReplyFallback(rawBody) : rawBody,
        ts: ev.getTs(),
        msgtype,
        // Still in flight (local echo) — shown muted until the server echo lands.
        pending: st === 'sending' || st === 'queued' || undefined,
      };
      // Inline media: thumbnail-size HTTPS URL via mxcUrlToHttp. Encrypted
      // rooms carry content.file (an EncryptedFile) instead of content.url;
      // we pass it through for the viewer to fetch + decrypt with Web Crypto.
      if (msgtype === 'm.sticker' && content.file?.url) {
        // Stickers (m.sticker) render as a small image, same as m.image.
        msg.image = { url: '', alt: content.body ?? 'sticker', w: content.info?.w, h: content.info?.h, encrypted: content.file as EncryptedFile, sticker: true };
      } else if (msgtype === 'm.sticker' && content.url) {
        const url = this.client.mxcUrlToHttp(content.url, 256, 256, 'scale');
        if (url) msg.image = { url, alt: content.body ?? 'sticker', w: content.info?.w, h: content.info?.h, sticker: true };
      } else if (msgtype === 'm.image' && content.file?.url) {
        msg.image = { url: '', alt: content.body ?? 'image', w: content.info?.w, h: content.info?.h, encrypted: content.file as EncryptedFile };
      } else if (msgtype === 'm.image' && content.url) {
        const url = this.client.mxcUrlToHttp(content.url, 800, 800, 'scale');
        if (url) msg.image = { url, alt: content.body ?? 'image', w: content.info?.w, h: content.info?.h };
      } else if ((msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') && content.file?.url) {
        // Encrypted room: ciphertext at content.file (EncryptedFile). No plain
        // URL — the viewer fetches + decrypts on demand via decryptMedia.
        msg.file = {
          url: '',
          name: content.body ?? msgtype,
          mimetype: content.info?.mimetype,
          size: content.info?.size,
          encrypted: content.file as EncryptedFile,
        };
      } else if ((msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') && content.url) {
        const url = this.client.mxcUrlToHttp(content.url);
        if (url) msg.file = {
          url,
          name: content.body ?? msgtype,
          mimetype: content.info?.mimetype,
          size: content.info?.size,
        };
      }
      if (content.format === 'org.matrix.custom.html' && content.formatted_body) {
        msg.html = content.formatted_body;
      }
      const receipts = room.getReceiptsForEvent?.(ev) ?? [];
      const seenIds = new Set<string>();
      for (const r of receipts as Array<{ userId: string; type: string }>) {
        if (r.userId === selfId) continue;
        if (r.type !== 'm.read' && r.type !== 'm.read.private') continue;
        seenIds.add(r.userId);
      }
      if (seenIds.size > 0) {
        msg.readBy = [];
        for (const uid of seenIds) {
          const member = room.getMember(uid);
          const mxc = member?.getMxcAvatarUrl?.();
          msg.readBy.push({
            userId: uid,
            name: member?.name ?? uid,
            avatarUrl: mxc ? (this.client.mxcUrlToHttp(mxc, 32, 32, 'crop') ?? undefined) : undefined,
          });
        }
      }
      const edit = editIdx.get(msg.id);
      if (edit && edit.senderId === msg.senderId) {
        msg.body = edit.body;
        msg.html = edit.html;
        msg.edited = true;
      }
      const byKey = reactionIdx.get(msg.id);
      if (byKey && byKey.size > 0) {
        msg.reactions = [...byKey.entries()]
          .map(([key, senders]) => ({ key, count: senders.size, selfReacted: senders.has(selfId) }))
          .sort((a, b) => b.count - a.count);
      }
      // In the main timeline, flag messages that have a thread hanging off them
      // so the UI can show a "N replies" entry point. (Not in thread mode — the
      // root there is just the first message of the thread view.)
      if (!threadRootId) {
        const ts = threadIdx.get(msg.id);
        if (ts) msg.threadSummary = { count: ts.count, latestTs: ts.latestTs };
      }
      // Close any state run that sits between this message and the newer one
      // above it, so the fold lands in the right chronological slot.
      flushState();
      messages.push(msg);
    }
    // Oldest run, with no older message after it.
    flushState();
    messages.reverse();
    return {
      roomId,
      roomName: room.name || roomId,
      memberCount: room.getJoinedMemberCount(),
      messages,
    };
  }

  // Pull a single issue's state event + schema + comments from a room.
  // Comments are any timeline event whose content has eu.kiefte.issue_id
  // matching the issueId. Returns null if the room or issue isn't found.
  getIssueDetail(roomId: string, issueId: string): IssueDetail | null {
    if (!this.client) return null;
    const room = this.client.getRoom(roomId);
    if (!room) return null;
    const ev = room.currentState.getStateEvents(ISSUE_EVENT, issueId);
    if (!ev) return null;
    const content = ev.getContent() as Record<string, unknown> & { _deleted?: boolean; title?: string };
    if (content._deleted) return null;
    const schema = getSchema(room);
    const comments: IssueComment[] = [];
    for (const tev of room.getLiveTimeline().getEvents()) {
      const c = tev.getContent() as Record<string, unknown>;
      if (c['eu.kiefte.issue_id'] !== issueId) continue;
      const senderId = tev.getSender() ?? '?';
      const senderMember = room.getMember(senderId);
      const html = c['format'] === 'org.matrix.custom.html' ? (c['formatted_body'] as string | undefined) : undefined;
      comments.push({
        id: tev.getId() ?? `${tev.getTs()}`,
        sender: senderMember?.name ?? senderId,
        body: String((c.body as string) ?? ''),
        ts: tev.getTs(),
        html,
      });
    }
    comments.sort((a, b) => a.ts - b.ts);
    return {
      issueId,
      roomId,
      roomName: room.name || roomId,
      content,
      schema,
      comments,
      lastUpdate: ev.getTs(),
    };
  }
}

export interface IssueDetail {
  issueId: string;
  roomId: string;
  roomName: string;
  content: Record<string, unknown> & { title?: string };
  schema: IssueSchema;
  comments: IssueComment[];
  lastUpdate: number;
}

export interface IssueComment {
  id: string;
  sender: string;
  body: string;
  ts: number;
  html?: string;
}

export interface TaskTargetRoom {
  roomId: string;
  name: string;
  isDm: boolean;
  flavor: string;
  memberCount: number;
  hasSchema: boolean;
}

export interface SpaceNode {
  id: string;        // room id of the space
  label: string;
  parentId: string | null; // parent space room id, or null for a root space
}

export interface IssueRoomStatus {
  roomId: string;
  name: string;
  statusField: string;  // label of the kanban-group field (e.g. "Status")
  values: string[];     // all status values in schema order
  doneValues: string[]; // which currently count as done (override or default)
  isOverride: boolean;  // true if the user set an explicit override
}

export interface CustomEmoji {
  shortcode: string;
  mxc: string;
}

export interface IncomingCall {
  roomId: string;
  roomName: string;
  since: number;
}

export interface JoinableRoom {
  roomId: string;
  spaceId: string;
  name: string;
  topic?: string;
  memberCount: number;
  avatarUrl?: string;
}

export interface RoomWidget {
  id: string;
  type: string;
  url: string;
  name: string;
  data?: Record<string, unknown>;
  avatarUrl?: string;
}

export interface RoomTimelineSnapshot {
  roomId: string;
  roomName: string;
  memberCount: number;
  messages: TimelineMessage[];
}

export interface ReadReceipt {
  userId: string;
  name: string;
  avatarUrl?: string;
}

export interface TimelineMessage {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
  msgtype: string;
  // A folded run of consecutive membership / room-state changes (joins, leaves,
  // renames, topic/avatar). These don't render as normal messages — RoomPanel
  // shows a one-line "N room changes" summary that expands to `stateLines`.
  // `rendersInRoomView` already keeps them out of next-unread navigation.
  kind?: 'message' | 'state';
  stateLines?: string[]; // chronological human one-liners (capped; see stateCount for the true total)
  stateCount?: number;   // total changes in the run (may exceed stateLines.length)
  pending?: boolean; // local echo still sending/queued — render muted until the server echo replaces it
  image?: { url: string; alt: string; w?: number; h?: number; encrypted?: EncryptedFile; sticker?: boolean };
  file?: { url: string; name: string; mimetype?: string; size?: number; encrypted?: EncryptedFile };
  reactions?: { key: string; count: number; selfReacted: boolean }[];
  html?: string;  // formatted_body when format=org.matrix.custom.html
  edited?: boolean;
  readBy?: ReadReceipt[]; // members whose latest read receipt points at this event
  threadSummary?: { count: number; latestTs: number }; // set on main-timeline thread roots
}

function isSpace(room: Room): boolean {
  const create = room.currentState.getStateEvents('m.room.create', '');
  const type = create?.getContent()?.type;
  return type === 'm.space';
}

// Priority scoring. Bigger = higher in the inbox stream.
//   +5  unread highlight (mention/own keyword)
//   +3  any unread
//   +2  DM with a human
//   +1  recent (<24h) activity
//   -2  bridged group chat (notification spam-prone)
//   -1  bot-y sender (mxid contains 'bot')
function computePriority(room: Room, flavor: string, isDm: boolean, isUnread: boolean, highlight: boolean, lastTs: number, lastSenderId: string, w: PriorityWeights, categoryAdjust = 0): number {
  let p = 0;
  if (highlight) p += w.mention;
  else if (isUnread) p += w.unread;
  if (isDm) p += w.dm;
  if (Date.now() - lastTs < 24 * 3600 * 1000) p += w.recent;
  const memberCount = room.getJoinedMemberCount();
  const isBridge = flavor !== 'matrix' && flavor !== 'issue';
  if (isBridge && memberCount > 2) p -= w.bridgeChat;
  if (lastSenderId.toLowerCase().includes('bot')) p -= w.bot;
  p += categoryAdjust;
  return p;
}

// Would this event render visible content in the room view? "Next unread"
// navigation uses this to skip rooms whose unread is only non-rendering events
// (state changes, reactions, redactions, or undecryptable messages) — landing on
// one shows an empty window. Only message/sticker events with actual content count.
function rendersInRoomView(ev: MatrixEvent): boolean {
  if (ev.isState()) return false;
  if (ev.isRedacted?.()) return false;
  if (ev.isDecryptionFailure?.()) return false; // UTD — nothing to show
  const type = ev.getType();
  if (type === 'm.sticker') return true;
  if (type === 'm.room.message') {
    const body = (ev.getContent() as { body?: string }).body;
    return typeof body === 'string' && body.length > 0;
  }
  return false; // reactions, receipts, call.member, membership, etc.
}

// Room-state events we fold into a one-line summary in the timeline instead of
// dropping. Anything else (call.member, reactions, custom state) is still hidden.
const SUMMARIZABLE_STATE = new Set([
  'm.room.member',
  'm.room.name',
  'm.room.topic',
  'm.room.avatar',
  'm.room.canonical_alias',
]);

// Human one-liner for a foldable membership change. Returns null for no-op
// member events (a 'join' that changed neither name nor avatar) so we don't fold
// in invisible noise.
function formatMemberEvent(ev: MatrixEvent, room: Room): string | null {
  const content = ev.getContent() as { membership?: string; displayname?: string; avatar_url?: string };
  const prev = (ev.getPrevContent?.() ?? {}) as { membership?: string; displayname?: string; avatar_url?: string };
  const target = ev.getStateKey() ?? '';
  const sender = ev.getSender() ?? '';
  const name = content.displayname || room.getMember(target)?.name || target;
  switch (content.membership) {
    case 'join':
      if (prev.membership === 'join') {
        if ((prev.displayname || '') !== (content.displayname || '')) {
          return `${prev.displayname || target} is now ${content.displayname || target}`;
        }
        if ((prev.avatar_url || '') !== (content.avatar_url || '')) return `${name} changed their avatar`;
        return null; // join->join with no visible change
      }
      return `${name} joined`;
    case 'leave':
      return sender === target ? `${name} left` : `${name} was removed`;
    case 'invite':
      return `${name} was invited`;
    case 'ban':
      return `${name} was banned`;
    case 'knock':
      return `${name} requested to join`;
    default:
      return null;
  }
}

// Human one-liner for a foldable room-state change, or null to skip it.
function formatStateEvent(ev: MatrixEvent, room: Room): string | null {
  const type = ev.getType();
  if (type === 'm.room.member') return formatMemberEvent(ev, room);
  const sender = ev.getSender() ?? '';
  const who = room.getMember(sender)?.name || sender;
  switch (type) {
    case 'm.room.name': {
      const n = (ev.getContent() as { name?: string }).name;
      return n ? `${who} changed the room name to “${n}”` : `${who} removed the room name`;
    }
    case 'm.room.topic':
      return `${who} changed the topic`;
    case 'm.room.avatar':
      return `${who} changed the room avatar`;
    case 'm.room.canonical_alias':
      return `${who} changed the main address`;
    default:
      return null;
  }
}

function roomToItem(room: Room, selfId: string, extraBundles: string[] = [], client?: MatrixClient, weights: PriorityWeights = DEFAULT_WEIGHTS): InboxItem | null {
  const memberIds = room.getJoinedMembers().map((m) => m.userId);
  const flavor = flavorForRoomMembers(memberIds.filter((id) => id !== selfId));

  const live = room.getLiveTimeline().getEvents();
  // Event-type hiding is a display/counter filter, not a visibility one: a
  // hidden category (e.g. a "joined" membership event) must not define the row.
  // Pick the latest event whose category the user has NOT hidden for the
  // snippet / timestamp / category, so a trailing join or call.member doesn't
  // resurface a room or turn its preview into noise. Falls back to the true
  // latest event when every loaded event is hidden (the room still shows).
  const hiddenCatSet = new Set(
    Object.entries(weights.eventTypeAdjust ?? {}).filter(([, v]) => v?.hidden === true).map(([k]) => k),
  );
  const actualLast = live[live.length - 1];
  let last = actualLast;
  // Did we actually find a non-hidden event to define the row? Under sliding
  // sync the loaded timeline is often just the single latest event, so if THAT
  // is a hidden category (a join, a call.member) there's no earlier real message
  // loaded to fall back to. In that case we must NOT render the hidden event as
  // the preview ("joined") — show no snippet instead (it fills in once the real
  // message loads, e.g. when the room is opened).
  let meaningfulFound = hiddenCatSet.size === 0;
  if (hiddenCatSet.size > 0 && actualLast) {
    for (let i = live.length - 1; i >= 0; i--) {
      const ev = live[i];
      const cat = eventCategory(ev.getType(), (ev.getContent() as { msgtype?: string }).msgtype);
      if (!hiddenCatSet.has(cat)) { last = ev; meaningfulFound = true; break; }
    }
  }
  // A joined/invited room with no loaded timeline event — a quiet room, a
  // freshly-created or invited VC room, or one only hydrated via space
  // hierarchy — must still appear. Dropping it here is what made rooms vanish
  // from a space even on the All filter. Synthesize a minimal item from room
  // state instead of returning null.
  // Recency for sorting — ALWAYS in milliseconds, one consistent scale for
  // every room. We used to sort on the server's raw bump_stamp, but
  // Continuwuity's bump_stamp is a small stream counter, not a ms epoch: mixing
  // it with the ms fallback used for rooms that lacked one put the list on two
  // incompatible scales and shuffled it (the "out of order" bug). Take the last
  // loaded NON-STATE event's origin_server_ts instead. Skipping state events
  // keeps the float-fix — a trailing eu.kiefte.issue / membership edit no longer
  // lifts a read room (the ganza case) — without ever leaving the ms scale.
  let recencyEv: MatrixEvent | undefined;
  for (let i = live.length - 1; i >= 0; i -= 1) {
    if (!live[i].isState()) { recencyEv = live[i]; break; }
  }
  // Fallbacks, still ms: the server bump_stamp ONLY when it's a real ms epoch
  // (a counter-scale value is deliberately ignored so it can't corrupt the
  // order), else the raw last event, else 0. ?? doesn't catch NaN (a missing
  // origin_server_ts → NaN), so coerce to a finite number.
  const bump = room.getLastActiveTimestamp?.();
  const bumpMs = (typeof bump === 'number' && bump > 1e12) ? bump : undefined;
  const tsCandidate = recencyEv?.getTs() ?? bumpMs ?? actualLast?.getTs() ?? 0;
  const lastTs = Number.isFinite(tsCandidate) ? tsCandidate : 0;

  // A pending invite: we've been invited but haven't joined. Surface it as a
  // prominent (always-unread) row with the inviter as the sender, so the UI can
  // offer Accept / Decline.
  const isInvite = room.getMyMembership?.() === 'invite';
  const inviteEvent = isInvite ? room.getMember(selfId)?.events?.member : undefined;
  const inviterId = inviteEvent?.getSender();
  const inviterName = inviterId ? (room.getMember(inviterId)?.name ?? inviterId) : undefined;

  const senderId = (isInvite ? inviterId : last?.getSender()) ?? '?';
  const senderMember = senderId !== '?' ? room.getMember(senderId) : null;
  const fromName = isInvite
    ? (inviterName ?? 'Someone')
    : (senderMember?.name ?? (last ? senderId : (room.name || room.roomId)));

  const content = (last?.getContent() ?? {}) as { body?: string; msgtype?: string; membership?: string };
  const snippet = isInvite
    ? 'invited you to join'
    : (last && meaningfulFound ? (content.body ?? humanizeEventType(last.getType(), content.msgtype, content)) : '');
  const category = eventCategory(last?.getType() ?? 'm.room.create', content.msgtype);
  const catAdjust = weights.eventTypeAdjust?.[category]?.weight ?? 0;

  const isDm = extraBundles.includes('dm');
  // getUnreadNotificationCount already excludes joins/state events (they match no
  // push rule), so unread is correctly driven by real messages/mentions — a
  // trailing join never inflates it. Hidden-category handling therefore only
  // affects the SNIPPET (see meaningfulFound above), NOT unread: gating unread on
  // meaningfulFound wrongly marked genuinely-unread rooms read until their
  // message loaded, then flipped them back on open (read-receipt race).
  const notifs = room.getUnreadNotificationCount?.() ?? 0;
  const highlights = room.getUnreadNotificationCount?.('highlight' as never) ?? 0;
  // Does the unread portion contain anything the room view renders? Scan the
  // loaded timeline back to this user's read marker; stop at the first renderable
  // message. If the unread is only state/reactions/redactions/UTD, the room would
  // open to an empty window, so "next unread" should skip it (see unreadHasText).
  let unreadHasText = false;
  let scanReachedMarker = false;
  if (notifs > 0) {
    const readUpTo = selfId ? room.getEventReadUpTo(selfId) : null;
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const ev = live[i];
      if (readUpTo && ev.getId() === readUpTo) { scanReachedMarker = true; break; } // whole unread window scanned
      if (rendersInRoomView(ev)) { unreadHasText = true; break; }
    }
  }
  // A room whose ENTIRE unread window is non-rendering events (membership/state/
  // reactions/redactions/UTD) would open to an empty view — count it as fully
  // read: no unread badge, out of the unread tallies (so bundle unread-sort and
  // Next-unread stay honest), no unread priority bump. Gate on scanReachedMarker:
  // timelines load contiguously, so a loaded read marker means we saw the whole
  // unread window. If the marker ISN'T loaded the real message may just be
  // unpaginated — stay unread (the documented race that bit the old
  // meaningfulFound gating). A highlight/mention always keeps the room unread.
  const unreadOnlyFiltered = notifs > 0 && highlights === 0 && !unreadHasText && scanReachedMarker;
  const msgUnread = notifs > 0 && !unreadOnlyFiltered;
  const presenceRaw = client?.getUser(senderId)?.presence;
  const senderPresence = (presenceRaw === 'online' || presenceRaw === 'unavailable' || presenceRaw === 'offline')
    ? presenceRaw : undefined;
  // Prefer the room avatar (a DM defaults to the other party's), fall
  // back to the room's first member. mxcUrlToHttp on a fresh client may
  // return undefined when not yet logged in — guard with optional chain.
  let avatarUrl: string | undefined;
  if (client) {
    const roomAvatarMxc = room.getMxcAvatarUrl?.();
    const memberAvatarMxc = senderMember?.getMxcAvatarUrl?.();
    const mxc = roomAvatarMxc ?? memberAvatarMxc;
    if (mxc) {
      const url = client.mxcUrlToHttp(mxc, 80, 80, 'crop');
      if (url) avatarUrl = url;
    }
  }
  // A room favourited in Wally/Element (m.favourite tag) is "pinned" here.
  const isFavourite = !!(room.tags && room.tags['m.favourite']);
  return {
    id: `matrix:${room.roomId}`,
    flavor,
    bundles: [`flavor:${flavor}`, ...extraBundles, ...(isFavourite ? ['pinned'] : [])],
    from: fromName,
    fromAddress: senderId,
    subject: room.name || room.roomId,
    snippet,
    ts: isInvite && inviteEvent ? (inviteEvent.getTs() ?? lastTs) : lastTs,
    // Invites are always "unread" so they surface in the default view, and get
    // a big priority bump to float to the top.
    unread: isInvite || msgUnread,
    unreadCount: unreadOnlyFiltered ? 0 : notifs,
    unreadHasText,
    onlyUpdates: unreadOnlyFiltered || undefined,
    invite: isInvite || undefined,
    threadCount: live.length,
    priority: computePriority(room, flavor, isDm, msgUnread, highlights > 0, lastTs, senderId, weights, catAdjust) + (isInvite ? 50 : 0),
    eventCategory: category,
    openPath: `/m/${encodeURIComponent(room.roomId)}`,
    senderPresence,
    avatarUrl,
  };
}

function getSchema(room: Room): IssueSchema {
  const ev = room.currentState.getStateEvents(ISSUE_SCHEMA_EVENT, '');
  const content = ev?.getContent() as Partial<IssueSchema> | undefined;
  if (content?.fields && Array.isArray(content.fields)) return content as IssueSchema;
  return DEFAULT_SCHEMA;
}

function issueItemsForRoom(
  room: Room, extraBundles: string[] = [],
  globalDoneStatuses: string[] = DEFAULT_WEIGHTS.doneStatuses,
  perRoomDone?: string[],
): InboxItem[] {
  // Per-schema done logic:
  //   1. If the user explicitly set done values for this room, use those.
  //   2. Otherwise, default to the LAST value of the kanban-group enum —
  //      matches the convention in most kanban schemas (To Do → … → Done).
  //   3. Fall back to the global doneStatuses list if the schema has no
  //      kanban group field with values.
  const schema = getSchema(room);
  const groupField = schema.fields.find((f) => f.kanban_group && f.type === 'enum' && f.values?.length);
  let doneSet: Set<string>;
  if (perRoomDone && perRoomDone.length > 0) {
    doneSet = new Set(perRoomDone.map((s) => s.toLowerCase()));
  } else if (groupField?.values?.length) {
    doneSet = new Set([groupField.values[groupField.values.length - 1].toLowerCase()]);
  } else {
    doneSet = new Set(globalDoneStatuses.map((s) => s.toLowerCase()));
  }
  const events = room.currentState.getStateEvents(ISSUE_EVENT);
  if (!events.length) return [];
  const items: InboxItem[] = [];
  for (const ev of events as MatrixEvent[]) {
    const issueId = ev.getStateKey();
    if (!issueId) continue;
    const content = ev.getContent() as Record<string, unknown> & {
      _deleted?: boolean;
      title?: string;
    };
    if (content._deleted) continue;
    const title = String(content.title ?? '(untitled)');
    const status = groupField ? String(content[groupField.key] ?? '') : '';
    const priority = String(content['priority'] ?? '');
    const assignee = String(content['assignee'] ?? '');
    // Collect every user-typed field's value so the inbox can offer an
    // "assigned to me" filter on any of them (not just 'assignee').
    const userValues = schema.fields
      .filter((f) => f.type === 'user')
      .map((f) => String(content[f.key] ?? '').trim())
      .filter(Boolean);
    const senderId = ev.getSender() ?? '?';
    const senderMember = room.getMember(senderId);
    const fromName = senderMember?.name ?? senderId;
    const snippetParts = [status, priority, assignee && `→ ${assignee}`].filter(Boolean);
    // Issues default to medium priority; status==Done sinks them.
    const isDone = doneSet.has(status.toLowerCase());
    items.push({
      id: `matrix:${room.roomId}:issue:${issueId}`,
      flavor: 'issue',
      bundles: ['flavor:issue', ...extraBundles],
      priority: isDone ? -3 : 2,
      statusValue: status || undefined,
      userValues: userValues.length > 0 ? userValues : undefined,
      from: fromName,
      fromAddress: senderId,
      subject: `${room.name || room.roomId} · ${title}`,
      snippet: snippetParts.join(' · ') || '(no status)',
      ts: ev.getTs(),
      unread: false,
      threadCount: 0,
      openPath: `/m/${encodeURIComponent(room.roomId)}/issue/${encodeURIComponent(issueId)}`,
    });
  }
  return items;
}
