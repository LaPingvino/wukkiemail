// SmallWidget — binds a widget definition (IApp) to an iframe via the Matrix
// ClientWidgetApi + our SmallWidgetDriver, and pumps room/to-device events into
// the widget. Ported from cinny-wally (src/app/features/call/SmallWidget.ts).
// The Element-Call-specific URL builders were dropped (we call natively via
// CallView); this keeps just the generic widget-embedding machinery.
import {
  ClientEvent,
  Direction,
  IEvent,
  KnownMembership,
  MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
} from 'matrix-js-sdk';
import {
  ClientWidgetApi,
  IRoomEvent,
  IStickyActionRequest,
  IWidget,
  IWidgetData,
  MatrixCapabilities,
  WidgetApiFromWidgetAction,
  WidgetKind,
} from 'matrix-widget-api';
import { CinnyWidget } from './CinnyWidget';
import { SmallWidgetDriver } from './SmallWidgetDriver';

export interface IApp extends IWidget {
  client: MatrixClient;
  roomId: string;
  eventId?: string;
  avatar_url?: string;
  sender: string;
  'io.element.managed_hybrid'?: boolean;
}

export class SmallWidget {
  private client: MatrixClient;

  private messaging: ClientWidgetApi | null = null;

  private mockWidget: CinnyWidget;

  public roomId?: string;

  public url?: string;

  public iframe: HTMLIFrameElement | null = null;

  private readUpToMap: { [roomId: string]: string } = {};

  private readonly eventsToFeed = new WeakSet<MatrixEvent>();

  private stickyPromise?: () => Promise<void>;

  constructor(iapp: IApp) {
    this.client = iapp.client;
    this.roomId = iapp.roomId;
    this.url = iapp.url;
    this.mockWidget = new CinnyWidget(iapp);
  }

  startMessaging(iframe: HTMLIFrameElement): ClientWidgetApi {
    const driver = new SmallWidgetDriver(this.client, [], this.mockWidget, WidgetKind.Room, true, this.roomId);
    this.iframe = iframe;
    this.messaging = new ClientWidgetApi(this.mockWidget, iframe, driver);
    if (this.roomId) this.messaging.setViewedRoomId(this.roomId);

    // Seed the "read up to" markers with the newest event in every room so the
    // widget doesn't get spammed with backfill/decryption of ancient events.
    for (const room of this.client.getRooms()) {
      const events = room.getLiveTimeline()?.getEvents() || [];
      const roomEvent = events[events.length - 1];
      if (roomEvent) {
        const eventId = roomEvent.getId();
        if (eventId) this.readUpToMap[room.roomId] = eventId;
      }
    }

    this.messaging.on('action:org.matrix.msc2876.read_events', (ev: CustomEvent) => {
      const room = this.client.getRoom(this.roomId);
      const events: Partial<IEvent>[] = [];
      const { type } = ev.detail.data;

      ev.preventDefault();
      if (room === null) return this.messaging?.transport.reply(ev.detail, { events });
      const state = room.getLiveTimeline().getState(Direction.Forward);
      if (state === undefined) return this.messaging?.transport.reply(ev.detail, { events });

      const stateEvents = state.events?.get(type);
      Array.from(stateEvents?.values() ?? []).forEach((eventObject) => { events.push(eventObject.event); });
      return this.messaging?.transport.reply(ev.detail, { events });
    });

    this.client.on(ClientEvent.Event, this.onEvent);
    this.client.on(MatrixEventEvent.Decrypted, this.onEventDecrypted);
    this.client.on(ClientEvent.ToDeviceEvent, this.onToDeviceEvent);

    this.messaging.on(
      `action:${WidgetApiFromWidgetAction.UpdateAlwaysOnScreen}`,
      async (ev: CustomEvent<IStickyActionRequest>) => {
        if (this.messaging?.hasCapability(MatrixCapabilities.AlwaysOnScreen)) {
          ev.preventDefault();
          if (ev.detail.data.value && this.stickyPromise) await this.stickyPromise();
          this.messaging.transport.reply(ev.detail, {});
        }
      },
    );

    return this.messaging;
  }

  private onEvent = (ev: MatrixEvent): void => {
    this.client.decryptEventIfNeeded(ev);
    this.feedEvent(ev);
  };

  private onEventDecrypted = (ev: MatrixEvent): void => {
    this.feedEvent(ev);
  };

  private onToDeviceEvent = async (ev: MatrixEvent): Promise<void> => {
    await this.client.decryptEventIfNeeded(ev);
    if (ev.isDecryptionFailure()) return;
    await this.messaging?.feedToDevice(ev.getEffectiveEvent() as IRoomEvent, ev.isEncrypted());
  };

  private isFromInvite(ev: MatrixEvent): boolean {
    const room = this.client.getRoom(ev.getRoomId());
    return room?.getMyMembership() === KnownMembership.Invite;
  }

  private relatesToUnknown(ev: MatrixEvent): boolean {
    if (!ev.relationEventId || ev.replyEventId) return false;
    const room = this.client.getRoom(ev.getRoomId());
    return room === null || !room.findEventById(ev.relationEventId);
  }

  private arrayFastClone<T>(a: T[]): T[] {
    return a.slice(0, a.length);
  }

  private advanceReadUpToMarker(ev: MatrixEvent): boolean {
    const evId = ev.getId();
    if (evId === undefined) return false;
    const roomId = ev.getRoomId();
    if (roomId === undefined) return false;
    const room = this.client.getRoom(roomId);
    if (room === null) return false;

    const upToEventId = this.readUpToMap[ev.getRoomId()!];
    if (!upToEventId) {
      this.readUpToMap[roomId] = evId;
      return true;
    }
    if (upToEventId === evId) return false;

    const timeline = room.getLiveTimeline();
    const events = this.arrayFastClone(timeline.getEvents()).reverse().slice(0, 100);

    let advanced = false;
    events.some((timelineEvent) => {
      const id = timelineEvent.getId();
      if (id === upToEventId) return true;
      if (id === evId) {
        this.readUpToMap[roomId] = evId;
        advanced = true;
        return true;
      }
      return false;
    });
    return advanced;
  }

  private feedEvent(ev: MatrixEvent): void {
    if (this.messaging === null) return;
    if (
      this.eventsToFeed.delete(ev) ||
      this.relatesToUnknown(ev) ||
      this.isFromInvite(ev) ||
      this.advanceReadUpToMarker(ev)
    ) {
      if (ev.isBeingDecrypted() || ev.isDecryptionFailure()) {
        this.eventsToFeed.add(ev);
      } else {
        const raw = ev.getEffectiveEvent();
        this.messaging.feedEvent(raw as IRoomEvent, this.roomId ?? '').catch(() => null);
      }
    }
  }

  stopMessaging() {
    this.client.off(ClientEvent.Event, this.onEvent);
    this.client.off(MatrixEventEvent.Decrypted, this.onEventDecrypted);
    this.client.off(ClientEvent.ToDeviceEvent, this.onToDeviceEvent);
    if (this.messaging) {
      this.messaging.stop();
      this.messaging.removeAllListeners();
      this.messaging = null;
    }
  }
}

// Creates a virtual widget definition (IApp) for an embedded iframe widget.
export const createVirtualWidget = (
  client: MatrixClient,
  id: string,
  creatorUserId: string,
  name: string,
  type: string,
  url: URL,
  waitForIframeLoad: boolean,
  data: IWidgetData,
  roomId: string,
): IApp => ({
  client,
  id,
  creatorUserId,
  name,
  type,
  url: url.toString(),
  waitForIframeLoad,
  data,
  roomId,
  sender: creatorUserId,
});
