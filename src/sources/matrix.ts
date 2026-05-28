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
    const rooms = this.client.getRooms();
    const spaces = rooms.filter((r) => isSpace(r));
    return spaces.map((s) => ({
      id: `space:${s.roomId}`,
      label: s.name || s.roomId,
      count: 0,
      flavor: 'matrix',
    }));
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
    if (!this.client) return [];
    const selfId = this.client.getUserId() ?? '';
    const rooms = this.client.getRooms().filter((r) => !isSpace(r));
    const items: InboxItem[] = [];
    for (const room of rooms) {
      const summary = roomToItem(room, selfId);
      if (summary) items.push(summary);
      items.push(...issueItemsForRoom(room));
    }
    return items.sort((a, b) => b.ts - a.ts);
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

function roomToItem(room: Room, selfId: string): InboxItem | null {
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

  return {
    id: `matrix:${room.roomId}`,
    flavor,
    bundleId: null,
    from: fromName,
    fromAddress: senderId,
    subject: room.name || room.roomId,
    snippet,
    ts: last.getTs(),
    unread: (room.getUnreadNotificationCount?.() ?? 0) > 0,
    threadCount: live.length,
    openPath: `/m/${encodeURIComponent(room.roomId)}`,
  };
}

function getSchema(room: Room): IssueSchema {
  const ev = room.currentState.getStateEvents(ISSUE_SCHEMA_EVENT, '');
  const content = ev?.getContent() as Partial<IssueSchema> | undefined;
  if (content?.fields && Array.isArray(content.fields)) return content as IssueSchema;
  return DEFAULT_SCHEMA;
}

function issueItemsForRoom(room: Room): InboxItem[] {
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
    items.push({
      id: `matrix:${room.roomId}:issue:${issueId}`,
      flavor: 'issue',
      bundleId: null,
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
