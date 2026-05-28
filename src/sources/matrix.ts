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
import { buildClient, loadCreds, type MatrixCreds } from '../auth/matrix';
import { flavorForRoomMembers } from './bridges';
import type { BundleSpec, InboxItem, Source } from './types';

const ISSUE_EVENT = 'eu.kiefte.issue';

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
    // Wait for the first sync so listRooms returns something useful.
    await new Promise<void>((resolve) => {
      const handler = (state: string) => {
        if (state === 'PREPARED' || state === 'SYNCING') {
          this.client.removeListener('sync' as never, handler as never);
          resolve();
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
    const rooms = this.client.getRooms().filter((r) => !isSpace(r));
    return rooms
      .map((r) => roomToItem(r, this.client.getUserId() ?? ''))
      .filter((x): x is InboxItem => x !== null)
      .sort((a, b) => b.ts - a.ts);
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

  // Issue rooms: synthesize an "N open issues" subject so the inbox surfaces
  // issue activity even when the human chatter is quiet.
  const issueCount = room.currentState.getStateEvents(ISSUE_EVENT).length;
  const isIssueRoom = issueCount > 0;

  const senderId = last.getSender() ?? '?';
  const senderMember = room.getMember(senderId);
  const fromName = senderMember?.name ?? senderId;

  const content = last.getContent() as { body?: string; msgtype?: string };
  const snippet = content.body ?? `[${last.getType()}]`;

  return {
    id: `matrix:${room.roomId}`,
    flavor: isIssueRoom ? 'issue' : flavor,
    bundleId: null,
    from: fromName,
    fromAddress: senderId,
    subject: room.name || room.roomId,
    snippet: isIssueRoom ? `${issueCount} issue(s) tracked · ${snippet}` : snippet,
    ts: last.getTs(),
    unread: (room.getUnreadNotificationCount?.() ?? 0) > 0,
    threadCount: live.length,
    openPath: `/m/${encodeURIComponent(room.roomId)}`,
  };
}
