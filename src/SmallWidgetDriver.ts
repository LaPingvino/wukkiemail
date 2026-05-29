/* eslint-disable no-return-await */
/* eslint-disable no-param-reassign */
/* eslint-disable no-continue */
/* eslint-disable class-methods-use-this */
/* eslint-disable no-dupe-class-members */
/*
 * Ported from cinny-wally (src/app/features/call/SmallWidgetDriver.ts), itself
 * derived from Element Web's StopGapWidgetDriver.
 *
 * Copyright 2024 New Vector Ltd.
 * Copyright 2020-2023 The Matrix.org Foundation C.I.C.
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 *
 * A WidgetDriver wired to our MatrixClient — backs the ClientWidgetApi so an
 * embedded widget iframe can read/send room events + state, to-device, OpenID,
 * relations, user search, media, and TURN servers. Capabilities are broad
 * because we only embed widgets configured in the room's own state (trusted).
 */
import {
  type Capability,
  EventDirection,
  type ISendDelayedEventDetails,
  type ISendEventDetails,
  type IReadEventRelationsResult,
  type IRoomEvent,
  type ITurnServer,
  MatrixCapabilities,
  type Widget,
  WidgetDriver,
  WidgetEventCapability,
  WidgetKind,
  type IWidgetApiErrorResponseDataDetails,
  type ISearchUserDirectoryResult,
  type IGetMediaConfigResult,
  UpdateDelayedEventAction,
  OpenIDRequestState,
  SimpleObservable,
  IOpenIDUpdate,
} from 'matrix-widget-api';
import {
  ClientEvent,
  EventType,
  type IContent,
  type ITurnServer as MxTurnServer,
  MatrixError,
  type MatrixEvent,
  Direction,
  type SendDelayedEventResponse,
  type StateEvents,
  type TimelineEvents,
  MatrixClient,
} from 'matrix-js-sdk';

export class SmallWidgetDriver extends WidgetDriver {
  private allowedCapabilities: Set<Capability>;

  private readonly mxClient: MatrixClient;

  public constructor(
    mx: MatrixClient,
    allowedCapabilities: Capability[],
    _forWidget: Widget,
    _forWidgetKind: WidgetKind,
    _virtual: boolean,
    private inRoomId?: string,
  ) {
    super();
    this.mxClient = mx;

    this.allowedCapabilities = new Set([
      ...allowedCapabilities,
      MatrixCapabilities.Screenshots,
    ]);

    this.allowedCapabilities.add(MatrixCapabilities.AlwaysOnScreen);
    this.allowedCapabilities.add(MatrixCapabilities.MSC3846TurnServers);
    this.allowedCapabilities.add(MatrixCapabilities.MSC4157SendDelayedEvent);
    this.allowedCapabilities.add(MatrixCapabilities.MSC4157UpdateDelayedEvent);
    this.allowedCapabilities.add(`org.matrix.msc2762.timeline:${inRoomId}`);
    this.allowedCapabilities.add(`org.matrix.msc2762.state:${inRoomId}`);
    this.allowedCapabilities.add(
      WidgetEventCapability.forStateEvent(EventDirection.Receive, EventType.RoomMember).raw,
    );
    this.allowedCapabilities.add(
      WidgetEventCapability.forStateEvent(EventDirection.Receive, 'org.matrix.msc3401.call').raw,
    );
    this.allowedCapabilities.add(
      WidgetEventCapability.forStateEvent(EventDirection.Receive, EventType.RoomEncryption).raw,
    );
    const clientUserId = this.mxClient.getSafeUserId();
    this.allowedCapabilities.add(
      WidgetEventCapability.forStateEvent(
        EventDirection.Send,
        'org.matrix.msc3401.call.member',
        clientUserId,
      ).raw,
    );
    const clientDeviceId = this.mxClient.getDeviceId();
    if (clientDeviceId !== null) {
      this.allowedCapabilities.add(
        WidgetEventCapability.forStateEvent(
          EventDirection.Send,
          'org.matrix.msc3401.call.member',
          `_${clientUserId}_${clientDeviceId}`,
        ).raw,
      );
      this.allowedCapabilities.add(
        WidgetEventCapability.forStateEvent(
          EventDirection.Send,
          'org.matrix.msc3401.call.member',
          `${clientUserId}_${clientDeviceId}`,
        ).raw,
      );
    }
    this.allowedCapabilities.add(
      WidgetEventCapability.forStateEvent(EventDirection.Receive, 'org.matrix.msc3401.call.member').raw,
    );
    this.allowedCapabilities.add(
      WidgetEventCapability.forStateEvent(EventDirection.Receive, EventType.RoomCreate).raw,
    );

    const sendRecvRoomEvents = [
      'io.element.call.encryption_keys',
      'org.matrix.rageshake_request',
      EventType.Reaction,
      EventType.RoomRedaction,
      'io.element.call.reaction',
      EventType.RoomMessage,
    ];
    for (const eventType of sendRecvRoomEvents) {
      this.allowedCapabilities.add(WidgetEventCapability.forRoomEvent(EventDirection.Send, eventType).raw);
      this.allowedCapabilities.add(WidgetEventCapability.forRoomEvent(EventDirection.Receive, eventType).raw);
    }

    const sendRecvToDevice = [
      EventType.CallInvite,
      EventType.CallCandidates,
      EventType.CallAnswer,
      EventType.CallHangup,
      EventType.CallReject,
      EventType.CallSelectAnswer,
      EventType.CallNegotiate,
      EventType.CallSDPStreamMetadataChanged,
      EventType.CallSDPStreamMetadataChangedPrefix,
      EventType.CallReplaces,
      EventType.CallEncryptionKeysPrefix,
    ];
    for (const eventType of sendRecvToDevice) {
      this.allowedCapabilities.add(WidgetEventCapability.forToDeviceEvent(EventDirection.Send, eventType).raw);
      this.allowedCapabilities.add(WidgetEventCapability.forToDeviceEvent(EventDirection.Receive, eventType).raw);
    }
  }

  private delayedEventsSupported: boolean | undefined;

  private async checkDelayedEventSupport(): Promise<boolean> {
    if (this.delayedEventsSupported !== undefined) return this.delayedEventsSupported;
    try {
      const info = await this.mxClient.getVersions();
      this.delayedEventsSupported =
        info.unstable_features?.['org.matrix.msc4157'] === true ||
        info.unstable_features?.['org.matrix.msc4140'] === true;
    } catch {
      this.delayedEventsSupported = false;
    }
    return this.delayedEventsSupported;
  }

  public async validateCapabilities(requested: Set<Capability>): Promise<Set<Capability>> {
    const granted = new Set(requested);
    const supportsDelayed = await this.checkDelayedEventSupport();
    if (!supportsDelayed) {
      granted.delete(MatrixCapabilities.MSC4157SendDelayedEvent);
      granted.delete(MatrixCapabilities.MSC4157UpdateDelayedEvent);
    }
    return granted;
  }

  public async sendEvent<K extends keyof StateEvents>(
    eventType: K, content: StateEvents[K], stateKey: string | null, targetRoomId: string | null,
  ): Promise<ISendEventDetails>;

  public async sendEvent<K extends keyof TimelineEvents>(
    eventType: K, content: TimelineEvents[K], stateKey: null, targetRoomId: string | null,
  ): Promise<ISendEventDetails>;

  public async sendEvent(
    eventType: string, content: IContent, stateKey: string | null = null, targetRoomId: string | null = null,
  ): Promise<ISendEventDetails> {
    const client = this.mxClient;
    const roomId = targetRoomId || this.inRoomId;
    if (!client || !roomId) throw new Error('Not in a room or not attached to a client');

    let r: { event_id: string } | null;
    if (stateKey !== null) {
      r = await client.sendStateEvent(
        roomId, eventType as keyof StateEvents, content as StateEvents[keyof StateEvents], stateKey,
      );
    } else if (eventType === EventType.RoomRedaction) {
      r = await client.redactEvent(roomId, content.redacts);
    } else {
      r = await client.sendEvent(
        roomId, eventType as keyof TimelineEvents, content as TimelineEvents[keyof TimelineEvents],
      );
    }
    return { roomId, eventId: r.event_id };
  }

  public async sendDelayedEvent<K extends keyof StateEvents>(
    delay: number | null, parentDelayId: string | null, eventType: K, content: StateEvents[K],
    stateKey: string | null, targetRoomId: string | null,
  ): Promise<ISendDelayedEventDetails>;

  public async sendDelayedEvent<K extends keyof TimelineEvents>(
    delay: number | null, parentDelayId: string | null, eventType: K, content: TimelineEvents[K],
    stateKey: null, targetRoomId: string | null,
  ): Promise<ISendDelayedEventDetails>;

  public async sendDelayedEvent(
    delay: number | null, parentDelayId: string | null, eventType: string, content: IContent,
    stateKey: string | null = null, targetRoomId: string | null = null,
  ): Promise<ISendDelayedEventDetails> {
    const client = this.mxClient;
    const roomId = targetRoomId || this.inRoomId;
    if (!client || !roomId) throw new Error('Not in a room or not attached to a client');

    let delayOpts;
    if (delay !== null) {
      delayOpts = { delay, ...(parentDelayId !== null && { parent_delay_id: parentDelayId }) };
    } else if (parentDelayId !== null) {
      delayOpts = { parent_delay_id: parentDelayId };
    } else {
      throw new Error('Must provide at least one of delay or parentDelayId');
    }

    let r: SendDelayedEventResponse | null;
    if (stateKey !== null) {
      r = await client._unstable_sendDelayedStateEvent(
        roomId, delayOpts, eventType as keyof StateEvents, content as StateEvents[keyof StateEvents], stateKey,
      );
    } else {
      r = await client._unstable_sendDelayedEvent(
        roomId, delayOpts, null, eventType as keyof TimelineEvents, content as TimelineEvents[keyof TimelineEvents],
      );
    }
    return { roomId, delayId: r.delay_id };
  }

  public async updateDelayedEvent(delayId: string, action: UpdateDelayedEventAction): Promise<void> {
    await this.mxClient._unstable_updateDelayedEvent(delayId, action);
  }

  public async cancelScheduledDelayedEvent(delayId: string): Promise<void> {
    await this.mxClient._unstable_updateDelayedEvent(delayId, UpdateDelayedEventAction.Cancel);
  }

  public async restartScheduledDelayedEvent(delayId: string): Promise<void> {
    await this.mxClient._unstable_updateDelayedEvent(delayId, UpdateDelayedEventAction.Restart);
  }

  public async sendScheduledDelayedEvent(delayId: string): Promise<void> {
    await this.mxClient._unstable_updateDelayedEvent(delayId, UpdateDelayedEventAction.Send);
  }

  public async sendToDevice(
    eventType: string, encrypted: boolean, contentMap: { [userId: string]: { [deviceId: string]: object } },
  ): Promise<void> {
    const client = this.mxClient;
    if (encrypted) {
      const crypto = client.getCrypto();
      if (!crypto) throw new Error('E2EE not enabled');

      const invertedContentMap: { [content: string]: { userId: string; deviceId: string }[] } = {};
      for (const userId of Object.keys(contentMap)) {
        const userContentMap = contentMap[userId];
        for (const deviceId of Object.keys(userContentMap)) {
          const content = userContentMap[deviceId];
          const stringifiedContent = JSON.stringify(content);
          invertedContentMap[stringifiedContent] = invertedContentMap[stringifiedContent] || [];
          invertedContentMap[stringifiedContent].push({ userId, deviceId });
        }
      }

      await Promise.all(
        Object.entries(invertedContentMap).map(async ([stringifiedContent, recipients]) => {
          const batch = await crypto.encryptToDeviceMessages(eventType, recipients, JSON.parse(stringifiedContent));
          await client.queueToDevice(batch);
        }),
      );
    } else {
      await client.queueToDevice({
        eventType,
        batch: Object.entries(contentMap).flatMap(([userId, userContentMap]) =>
          Object.entries(userContentMap).map(([deviceId, content]) => ({ userId, deviceId, payload: content }))),
      });
    }
  }

  public async readRoomTimeline(
    roomId: string, eventType: string, msgtype: string | undefined, stateKey: string | undefined,
    limit: number, since: string | undefined,
  ): Promise<IRoomEvent[]> {
    limit = limit > 0 ? Math.min(limit, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const room = this.mxClient.getRoom(roomId);
    if (room === null) return [];
    const results: MatrixEvent[] = [];
    const events = room.getLiveTimeline().getEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (results.length >= limit) break;
      if (since !== undefined && ev.getId() === since) break;
      if (ev.getType() !== eventType || ev.isState()) continue;
      if (eventType === EventType.RoomMessage && msgtype && msgtype !== ev.getContent().msgtype) continue;
      if (ev.getStateKey() !== undefined && stateKey !== undefined && ev.getStateKey() !== stateKey) continue;
      results.push(ev);
    }
    return results.map((e) => e.getEffectiveEvent() as IRoomEvent);
  }

  public async askOpenID(observer: SimpleObservable<IOpenIDUpdate>): Promise<void> {
    try {
      const token = await this.mxClient.getOpenIdToken();
      return observer.update({ state: OpenIDRequestState.Allowed, token });
    } catch {
      return observer.update({ state: OpenIDRequestState.Blocked });
    }
  }

  public async readRoomState(
    roomId: string, eventType: string, stateKey: string | undefined,
  ): Promise<IRoomEvent[]> {
    const room = this.mxClient.getRoom(roomId);
    if (room === null) return [];
    const state = room.getLiveTimeline().getState(Direction.Forward);
    if (state === undefined) return [];
    if (stateKey === undefined)
      return state.getStateEvents(eventType).map((e) => e.getEffectiveEvent() as IRoomEvent);
    const event = state.getStateEvents(eventType, stateKey);
    return event === null ? [] : [event.getEffectiveEvent() as IRoomEvent];
  }

  public async readEventRelations(
    eventId: string, roomId?: string, relationType?: string, eventType?: string,
    from?: string, to?: string, limit?: number, direction?: 'f' | 'b',
  ): Promise<IReadEventRelationsResult> {
    const client = this.mxClient;
    const dir = direction as Direction;
    roomId = roomId ?? this.inRoomId ?? undefined;
    if (typeof roomId !== 'string') throw new Error('Error while reading the current room');

    const { events, nextBatch, prevBatch } = await client.relations(
      roomId, eventId, relationType ?? null, eventType ?? null, { from, to, limit, dir },
    );
    return {
      chunk: events.map((e) => e.getEffectiveEvent() as IRoomEvent),
      nextBatch: nextBatch ?? undefined,
      prevBatch: prevBatch ?? undefined,
    };
  }

  public async searchUserDirectory(searchTerm: string, limit?: number): Promise<ISearchUserDirectoryResult> {
    const { limited, results } = await this.mxClient.searchUserDirectory({ term: searchTerm, limit });
    return {
      limited,
      results: results.map((r) => ({ userId: r.user_id, displayName: r.display_name, avatarUrl: r.avatar_url })),
    };
  }

  public async getMediaConfig(): Promise<IGetMediaConfigResult> {
    return await this.mxClient.getMediaConfig();
  }

  public async uploadFile(file: XMLHttpRequestBodyInit): Promise<{ contentUri: string }> {
    const uploadResult = await this.mxClient.uploadContent(file);
    return { contentUri: uploadResult.content_uri };
  }

  public async *getTurnServers(): AsyncGenerator<ITurnServer> {
    const client = this.mxClient;
    const toWidget = (s: MxTurnServer): ITurnServer => ({ uris: s.urls, username: s.username, password: s.credential });

    const initial = client.getTurnServers();
    for (const server of initial) yield toWidget(server);
    if (initial.length === 0) return;

    const queue: ITurnServer[] = [];
    let pending: (() => void) | null = null;
    const onTurnServers = (servers: MxTurnServer[]): void => {
      for (const s of servers) queue.push(toWidget(s));
      pending?.();
      pending = null;
    };
    client.on(ClientEvent.TurnServers, onTurnServers);
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((resolve) => { pending = resolve; });
        }
      }
    } finally {
      client.off(ClientEvent.TurnServers, onTurnServers);
    }
  }

  public getKnownRooms(): string[] {
    return this.mxClient.getVisibleRooms().map((r) => r.roomId);
  }

  public processError(error: unknown): IWidgetApiErrorResponseDataDetails | undefined {
    return error instanceof MatrixError ? { matrix_api_error: error.asWidgetApiErrorData() } : undefined;
  }
}
