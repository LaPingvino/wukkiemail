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
  private client: MatrixClient;
  private started = false;
  private listeners = new Set<() => void>();
  private syncState: string | null = null;

  constructor(creds: MatrixCreds) {
    this.client = buildClient(creds);
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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Sync listener stays attached for the lifetime of the source.
    // Every transition pings subscribers so the inbox redraws as
    // rooms arrive — we don't block on PREPARED any more.
    const onSync = (state: string, prev: string | null, data: unknown) => {
      // eslint-disable-next-line no-console
      console.info('[wukkiemail] sync ->', state, { prev });
      this.syncState = state;
      this.notify();
      if (state === 'ERROR') {
        const err = (data as { error?: { message?: string } })?.error?.message ?? 'unknown';
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] sync ERROR:', err);
      }
    };
    this.client.on('sync' as never, onSync as never);

    try {
      // lazyLoadMembers cuts initial /sync payload dramatically on heavy
      // accounts — members for a room only arrive when we touch the room.
      // initialSyncLimit: 1 keeps the timeline portion tiny too.
      await this.client.startClient({
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
    this.client.stopClient();
    this.started = false;
  }

  async listBundles(): Promise<BundleSpec[]> {
    const rooms = this.client.getRooms();
    const spaces = rooms.filter((r) => isSpace(r));
    const bundles: BundleSpec[] = spaces.map((s) => ({
      id: `space:${s.roomId}`,
      label: s.name || s.roomId,
      count: 0,
      flavor: 'matrix',
    }));
    return bundles;
  }

  async listItems(_bundleId: string | null): Promise<InboxItem[]> {
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
