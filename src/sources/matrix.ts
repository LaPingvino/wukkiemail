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

  constructor(creds: MatrixCreds) {
    this.client = buildClient(creds);
    this.id = creds.userId;
  }

  static tryRestore(): MatrixSource | null {
    const creds = loadCreds();
    return creds ? new MatrixSource(creds) : null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.client.startClient({ initialSyncLimit: 20 });
    const ready = ['PREPARED', 'SYNCING'];
    if (ready.includes(this.client.getSyncState() ?? '')) return;
    // Wait for the first sync, but don't hang forever — surface a real error
    // if the homeserver never reaches PREPARED within 30s.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.removeListener('sync' as never, handler as never);
        reject(new Error(`Matrix sync timeout (state: ${this.client.getSyncState() ?? 'null'})`));
      }, 30_000);
      const handler = (state: string) => {
        if (ready.includes(state)) {
          clearTimeout(timer);
          this.client.removeListener('sync' as never, handler as never);
          resolve();
        } else if (state === 'ERROR') {
          clearTimeout(timer);
          this.client.removeListener('sync' as never, handler as never);
          reject(new Error('Matrix sync entered ERROR state — homeserver unreachable?'));
        }
      };
      this.client.on('sync' as never, handler as never);
    });
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
