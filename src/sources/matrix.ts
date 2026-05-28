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

import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { ClientEvent } from 'matrix-js-sdk';
import { buildClient, loadCreds, type MatrixCreds } from '../auth/matrix';
import { flavorForRoomMembers } from './bridges';
import type { BundleSpec, InboxItem, Source } from './types';

const ISSUE_EVENT = 'eu.kiefte.issue';
const ISSUE_SCHEMA_EVENT = 'eu.kiefte.issues.schema';
const TRIAGE_EVENT_TYPE = 'eu.kiefte.wukkiemail.triage';

export interface TriageState {
  pinned: string[];
  snoozed: Record<string, number>;
  manuallyUnread: string[]; // items the user flagged unread even if server says read
}
const EMPTY_TRIAGE: TriageState = { pinned: [], snoozed: {}, manuallyUnread: [] };

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

export class MatrixSource implements Source {
  readonly kind = 'matrix' as const;
  readonly id: string;
  private creds: MatrixCreds;
  private client: MatrixClient | null = null;
  private started = false;
  private listeners = new Set<() => void>();
  private syncState: string | null = null;

  constructor(creds: MatrixCreds) {
    this.creds = creds;
    this.id = creds.userId;
  }

  static tryRestore(): MatrixSource | null {
    const creds = loadCreds();
    return creds ? new MatrixSource(creds) : null;
  }

  // Subscribe to "something changed, re-render". Fires on every sync
  // transition; consumers should debounce if needed.
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private notify() { for (const cb of this.listeners) cb(); }

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
      try {
        await client.initRustCrypto();
        // eslint-disable-next-line no-console
        console.info('[wukkiemail] crypto initialised');
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] initRustCrypto failed, continuing without crypto', e);
      }
    }

    try {
      // lazyLoadMembers cuts initial /sync payload dramatically on heavy
      // accounts — members for a room only arrive when we touch the room.
      // initialSyncLimit: 1 keeps the timeline portion tiny too.
      await client.startClient({
        initialSyncLimit: 1,
        lazyLoadMembers: true,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[wukkiemail] startClient threw', e);
      throw e;
    }
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
    for (const space of this.client.getRooms().filter(isSpace)) {
      const children = space.currentState.getStateEvents('m.space.child');
      for (const ev of children) {
        const childRoomId = ev.getStateKey();
        // Only count if `via` is present — empty content means the child was removed.
        const content = ev.getContent() as { via?: string[] };
        if (!childRoomId || !content.via || content.via.length === 0) continue;
        const arr = idx.get(childRoomId) ?? [];
        arr.push(`space:${space.roomId}`);
        idx.set(childRoomId, arr);
      }
    }
    for (const id of dmRoomIds) {
      const arr = idx.get(id) ?? [];
      arr.push('dm');
      idx.set(id, arr);
    }
    return idx;
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
    if (!this.client) return [];
    const selfId = this.client.getUserId() ?? '';
    const bundleIndex = this.buildBundleIndex();
    const triage = this.getTriageState();
    const pinned = new Set(triage.pinned);
    const now = Date.now();
    const rooms = this.client.getRooms().filter((r) => !isSpace(r));
    const items: InboxItem[] = [];
    const manuallyUnread = new Set(triage.manuallyUnread);
    const addItem = (item: InboxItem | null) => {
      if (!item) return;
      const next = { ...item, bundles: [...item.bundles] };
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
      if (pinned.has(item.id)) {
        next.priority += 100;
        next.bundles.push('pinned');
      }
      if (manuallyUnread.has(item.id)) {
        next.unread = true;
        next.priority += 1;
      }
      items.push(next);
    };
    for (const room of rooms) {
      const extra = bundleIndex.get(room.roomId) ?? [];
      addItem(roomToItem(room, selfId, extra));
      for (const issueItem of issueItemsForRoom(room, extra)) addItem(issueItem);
    }
    return items.sort((a, b) => b.ts - a.ts);
  }

  // Paginate the live timeline backwards by ~limit events. Resolves true
  // if more history exists; false if we hit the start of the room. The
  // SDK appends events to the existing timeline, so consumers re-render
  // via the next sync/change tick.
  async loadOlder(roomId: string, limit = 50): Promise<boolean> {
    if (!this.client) return false;
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    const timeline = room.getLiveTimeline();
    const more = await this.client.paginateEventTimeline(timeline, { backwards: true, limit });
    this.notify();
    return more;
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
    };
  }

  // List rooms the user can use as a task target. Filters to rooms
  // where the user has permission to send eu.kiefte.issue state events.
  // Each entry tags whether it's a DM, a space child, encrypted, etc.,
  // so the picker can show the right hint ('Private todo' vs 'Team
  // visible').
  listTaskTargetRooms(): TaskTargetRoom[] {
    if (!this.client) return [];
    const selfId = this.client.getUserId() ?? '';
    const dmIdx = this.buildBundleIndex();
    return this.client.getRooms()
      .filter((r) => !isSpace(r))
      .filter((r) => {
        const pl = r.currentState.getStateEvents('m.room.power_levels', '');
        const plContent = (pl?.getContent() ?? {}) as { events?: Record<string, number>; state_default?: number };
        const required = plContent.events?.[ISSUE_EVENT] ?? plContent.state_default ?? 50;
        const myLevel = r.getMember(selfId)?.powerLevel ?? 0;
        return myLevel >= required;
      })
      .map((r) => {
        const bundles = dmIdx.get(r.roomId) ?? [];
        const memberIds = r.getJoinedMembers().map((m) => m.userId);
        const flavor = flavorForRoomMembers(memberIds.filter((id) => id !== selfId));
        return {
          roomId: r.roomId,
          name: r.name || r.roomId,
          isDm: bundles.includes('dm'),
          flavor,
          memberCount: r.getJoinedMemberCount(),
        };
      })
      .sort((a, b) => (a.isDm === b.isDm ? a.name.localeCompare(b.name) : (a.isDm ? -1 : 1)));
  }

  // Post a comment on an issue. We tag it with eu.kiefte.issue_id so
  // getIssueDetail's filter picks it up. Body is plain text; renderers
  // displaying these messages outside WukkieMail (Cinny, Element) will
  // just show the body without the tag.
  async commentOnIssue(roomId: string, issueId: string, body: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.sendMessage(roomId, {
      msgtype: 'm.text',
      body,
      'eu.kiefte.issue_id': issueId,
    } as never);
    this.notify();
  }

  // Patch an issue's content. Merges the partial with the current
  // state_event content and re-sends. Caller surfaces errors.
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

  // Create a new issue in a target room. Caller picks the room and we
  // generate a stable id (state_key) plus a minimal schema-compatible
  // content (just a title — the user can edit further in the issue
  // panel later, when we wire editing).
  async createTask(roomId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
    if (!this.client) throw new Error('client not started');
    const stateKey = crypto.randomUUID();
    const content = { title, status: 'To Do', ...extra };
    await this.client.sendStateEvent(roomId, ISSUE_EVENT as never, content as never, stateKey);
    this.notify();
    return stateKey;
  }

  async setManuallyUnread(itemId: string, unread: boolean): Promise<void> {
    const s = this.getTriageState();
    const set = new Set(s.manuallyUnread);
    if (unread) set.add(itemId); else set.delete(itemId);
    await this.setTriageState({ ...s, manuallyUnread: [...set] });
  }

  private async setTriageState(next: TriageState): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.setAccountData(TRIAGE_EVENT_TYPE as never, next as never);
    this.notify();
  }

  async setPinned(itemId: string, pinned: boolean): Promise<void> {
    const s = this.getTriageState();
    const set = new Set(s.pinned);
    if (pinned) set.add(itemId); else set.delete(itemId);
    await this.setTriageState({ ...s, pinned: [...set] });
  }

  async setSnoozed(itemId: string, untilMs: number | null): Promise<void> {
    const s = this.getTriageState();
    const snoozed = { ...s.snoozed };
    if (untilMs && untilMs > Date.now()) snoozed[itemId] = untilMs;
    else delete snoozed[itemId];
    await this.setTriageState({ ...s, snoozed });
  }

  // Send a plain text message to a room. For encrypted rooms this will
  // fail until we wire crypto — caller surfaces the error.
  async sendMessage(roomId: string, body: string): Promise<void> {
    if (!this.client) throw new Error('client not started');
    await this.client.sendTextMessage(roomId, body);
  }

  // Mark a room read at its newest message. The SDK fires off a /receipt
  // request; on success the next listItems() will compute unread=0 for
  // this room. Fails silently if the room or messages aren't ready yet —
  // we'll get another chance on the next sync transition.
  async markRoomRead(roomId: string): Promise<void> {
    if (!this.client) return;
    const room = this.client.getRoom(roomId);
    if (!room) return;
    const events = room.getLiveTimeline().getEvents();
    const last = events[events.length - 1];
    if (!last) return;
    try {
      await this.client.sendReadReceipt(last);
      // Force a refresh: getUnreadNotificationCount won't change locally
      // until /sync confirms, but the API call has already taken effect
      // server-side.
      this.notify();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] sendReadReceipt failed for', roomId, e);
    }
  }

  // Pull recent timeline messages for a room. Drops state events and
  // anything without a body (we'll add nicer renderers later).
  getRoomTimeline(roomId: string, limit = 50): RoomTimelineSnapshot | null {
    if (!this.client) return null;
    const room = this.client.getRoom(roomId);
    if (!room) return null;
    const messages: TimelineMessage[] = [];
    const all = room.getLiveTimeline().getEvents();
    const selfId = this.client.getUserId() ?? '';

    // Build a reactions index: target event_id -> key -> Set<senderId>.
    // Single pass over all events so the per-message lookup is O(1).
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
    }

    for (let i = all.length - 1; i >= 0 && messages.length < limit; i--) {
      const ev = all[i];
      const type = ev.getType();
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue;
      const content = ev.getContent() as {
        body?: string; msgtype?: string;
        url?: string; info?: { w?: number; h?: number; mimetype?: string; size?: number };
      };
      const senderId = ev.getSender() ?? '?';
      const senderMember = room.getMember(senderId);
      const msgtype = content.msgtype ?? type;
      const msg: TimelineMessage = {
        id: ev.getId() ?? String(ev.getTs()),
        senderId,
        senderName: senderMember?.name ?? senderId,
        body: type === 'm.room.encrypted'
          ? '(encrypted — body not available)'
          : (content.body ?? `[${msgtype}]`),
        ts: ev.getTs(),
        msgtype,
      };
      // Inline media: thumbnail-size HTTPS URL via mxcUrlToHttp.
      if (msgtype === 'm.image' && content.url) {
        const url = this.client.mxcUrlToHttp(content.url, 800, 800, 'scale');
        if (url) msg.image = { url, alt: content.body ?? 'image', w: content.info?.w, h: content.info?.h };
      } else if ((msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') && content.url) {
        const url = this.client.mxcUrlToHttp(content.url);
        if (url) msg.file = {
          url,
          name: content.body ?? msgtype,
          mimetype: content.info?.mimetype,
          size: content.info?.size,
        };
      }
      const byKey = reactionIdx.get(msg.id);
      if (byKey && byKey.size > 0) {
        msg.reactions = [...byKey.entries()]
          .map(([key, senders]) => ({ key, count: senders.size, selfReacted: senders.has(selfId) }))
          .sort((a, b) => b.count - a.count);
      }
      messages.push(msg);
    }
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
      comments.push({
        id: tev.getId() ?? `${tev.getTs()}`,
        sender: senderMember?.name ?? senderId,
        body: String((c.body as string) ?? ''),
        ts: tev.getTs(),
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
}

export interface TaskTargetRoom {
  roomId: string;
  name: string;
  isDm: boolean;
  flavor: string;
  memberCount: number;
}

export interface RoomTimelineSnapshot {
  roomId: string;
  roomName: string;
  memberCount: number;
  messages: TimelineMessage[];
}

export interface TimelineMessage {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
  msgtype: string;
  image?: { url: string; alt: string; w?: number; h?: number };
  file?: { url: string; name: string; mimetype?: string; size?: number };
  reactions?: { key: string; count: number; selfReacted: boolean }[];
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
function computePriority(room: Room, flavor: string, isDm: boolean, isUnread: boolean, highlight: boolean, lastTs: number, lastSenderId: string): number {
  let p = 0;
  if (highlight) p += 5;
  else if (isUnread) p += 3;
  if (isDm) p += 2;
  if (Date.now() - lastTs < 24 * 3600 * 1000) p += 1;
  const memberCount = room.getJoinedMemberCount();
  const isBridge = flavor !== 'matrix' && flavor !== 'issue';
  if (isBridge && memberCount > 2) p -= 2;
  if (lastSenderId.toLowerCase().includes('bot')) p -= 1;
  return p;
}

function roomToItem(room: Room, selfId: string, extraBundles: string[] = []): InboxItem | null {
  const memberIds = room.getJoinedMembers().map((m) => m.userId);
  const flavor = flavorForRoomMembers(memberIds.filter((id) => id !== selfId));

  const live = room.getLiveTimeline().getEvents();
  const last = live[live.length - 1];
  if (!last) return null;

  const senderId = last.getSender() ?? '?';
  const senderMember = room.getMember(senderId);
  const fromName = senderMember?.name ?? senderId;

  const content = last.getContent() as { body?: string; msgtype?: string };
  const snippet = content.body ?? `[${last.getType()}]`;

  const isDm = extraBundles.includes('dm');
  const notifs = room.getUnreadNotificationCount?.() ?? 0;
  const highlights = room.getUnreadNotificationCount?.('highlight' as never) ?? 0;
  return {
    id: `matrix:${room.roomId}`,
    flavor,
    bundles: [`flavor:${flavor}`, ...extraBundles],
    from: fromName,
    fromAddress: senderId,
    subject: room.name || room.roomId,
    snippet,
    ts: last.getTs(),
    unread: notifs > 0,
    threadCount: live.length,
    priority: computePriority(room, flavor, isDm, notifs > 0, highlights > 0, last.getTs(), senderId),
    openPath: `/m/${encodeURIComponent(room.roomId)}`,
  };
}

function getSchema(room: Room): IssueSchema {
  const ev = room.currentState.getStateEvents(ISSUE_SCHEMA_EVENT, '');
  const content = ev?.getContent() as Partial<IssueSchema> | undefined;
  if (content?.fields && Array.isArray(content.fields)) return content as IssueSchema;
  return DEFAULT_SCHEMA;
}

function issueItemsForRoom(room: Room, extraBundles: string[] = []): InboxItem[] {
  const events = room.currentState.getStateEvents(ISSUE_EVENT);
  if (!events.length) return [];
  const schema = getSchema(room);
  const groupField = schema.fields.find((f) => f.kanban_group && f.type === 'enum');
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
    const senderId = ev.getSender() ?? '?';
    const senderMember = room.getMember(senderId);
    const fromName = senderMember?.name ?? senderId;
    const snippetParts = [status, priority, assignee && `→ ${assignee}`].filter(Boolean);
    // Issues default to medium priority; status==Done sinks them.
    const isDone = /done|closed|resolved/i.test(status);
    items.push({
      id: `matrix:${room.roomId}:issue:${issueId}`,
      flavor: 'issue',
      bundles: ['flavor:issue', ...extraBundles],
      priority: isDone ? -3 : 2,
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
