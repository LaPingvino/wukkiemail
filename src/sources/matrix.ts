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

interface SchemaField {
  key: string;
  type: 'text' | 'enum' | 'user' | 'date' | 'follow';
  label: string;
  kanban_group?: boolean;
}
interface IssueSchema { fields: SchemaField[]; }

const DEFAULT_SCHEMA: IssueSchema = {
  fields: [
    { key: 'title', type: 'text', label: 'Title' },
    { key: 'status', type: 'enum', label: 'Status', kanban_group: true },
    { key: 'priority', type: 'enum', label: 'Priority' },
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
    const rooms = this.client.getRooms().filter((r) => !isSpace(r));
    const items: InboxItem[] = [];
    for (const room of rooms) {
      const extra = bundleIndex.get(room.roomId) ?? [];
      const summary = roomToItem(room, selfId, extra);
      if (summary) items.push(summary);
      items.push(...issueItemsForRoom(room, extra));
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
    for (let i = all.length - 1; i >= 0 && messages.length < limit; i--) {
      const ev = all[i];
      const type = ev.getType();
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue;
      const content = ev.getContent() as { body?: string; msgtype?: string };
      const senderId = ev.getSender() ?? '?';
      const senderMember = room.getMember(senderId);
      messages.push({
        id: ev.getId() ?? String(ev.getTs()),
        senderId,
        senderName: senderMember?.name ?? senderId,
        body: type === 'm.room.encrypted'
          ? '(encrypted — body not available, v0 has no crypto)'
          : (content.body ?? `[${content.msgtype ?? type}]`),
        ts: ev.getTs(),
        msgtype: content.msgtype ?? type,
      });
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
