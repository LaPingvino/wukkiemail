// LiveKit Room lifecycle hook — ported from cinny-wally (hooks/useLiveKitRoom.ts),
// our own code. Connects when `connect` is true and url+token are present;
// exposes participants + mic/cam/screen controls.
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Room, RoomEvent, ConnectionState,
  type RemoteParticipant, type RemoteTrackPublication, type TrackPublication,
  type RemoteTrack, type LocalParticipant, type Participant, type BaseKeyProvider,
} from 'livekit-client';

function createRoom(e2eeKeyProvider?: BaseKeyProvider): Room {
  const opts: ConstructorParameters<typeof Room>[0] = { adaptiveStream: true, dynacast: true };
  if (e2eeKeyProvider) {
    opts.e2ee = {
      keyProvider: e2eeKeyProvider,
      worker: new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' }),
    };
  }
  return new Room(opts);
}

export interface UseLiveKitRoomOptions {
  url: string;
  token: string;
  connect: boolean;
  onDisconnected?: () => void;
  initialAudio?: boolean;
  initialVideo?: boolean;
  e2eeKeyProvider?: BaseKeyProvider;
}

export function useLiveKitRoom({
  url, token, connect, onDisconnected, initialAudio = false, initialVideo = false, e2eeKeyProvider,
}: UseLiveKitRoomOptions) {
  const [room, setRoom] = useState(() => createRoom(e2eeKeyProvider));
  const prevHadE2EE = useRef(!!e2eeKeyProvider);
  useEffect(() => {
    const hasE2EE = !!e2eeKeyProvider;
    if (hasE2EE !== prevHadE2EE.current) {
      prevHadE2EE.current = hasE2EE;
      setRoom(createRoom(e2eeKeyProvider));
    }
  }, [e2eeKeyProvider]);

  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [remoteParticipants, setRemoteParticipants] = useState<RemoteParticipant[]>([]);
  const [localParticipant, setLocalParticipant] = useState<LocalParticipant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMicEnabled, setIsMicEnabled] = useState(initialAudio);
  const [isCamEnabled, setIsCamEnabled] = useState(initialVideo);
  const [isScreenShareEnabled, setIsScreenShareEnabled] = useState(false);
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;
  const connectedRef = useRef(false);

  const updateParticipants = useCallback(() => {
    setRemoteParticipants([...Array.from(room.remoteParticipants.values())]);
  }, [room]);

  useEffect(() => {
    const onConnectionStateChanged = (state: ConnectionState) => {
      setConnectionState(state);
      if (state === ConnectionState.Connected) {
        setLocalParticipant(room.localParticipant);
        updateParticipants();
      }
      if (state === ConnectionState.Disconnected && connectedRef.current) {
        connectedRef.current = false;
        onDisconnectedRef.current?.();
      }
    };
    const onTrackChange = (_t: RemoteTrack | TrackPublication, _p: RemoteTrackPublication | Participant) => updateParticipants();
    const onMuteChange = (_pub: TrackPublication, p: Participant) => {
      updateParticipants();
      if (p === room.localParticipant) {
        setIsMicEnabled(room.localParticipant.isMicrophoneEnabled);
        setIsCamEnabled(room.localParticipant.isCameraEnabled);
      }
    };
    const onLocalTrack = () => {
      setIsMicEnabled(room.localParticipant.isMicrophoneEnabled);
      setIsCamEnabled(room.localParticipant.isCameraEnabled);
      setIsScreenShareEnabled(room.localParticipant.isScreenShareEnabled);
    };

    room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
    room.on(RoomEvent.ParticipantConnected, updateParticipants);
    room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
    room.on(RoomEvent.TrackSubscribed, onTrackChange as never);
    room.on(RoomEvent.TrackUnsubscribed, onTrackChange as never);
    room.on(RoomEvent.TrackMuted, onMuteChange);
    room.on(RoomEvent.TrackUnmuted, onMuteChange);
    room.on(RoomEvent.LocalTrackPublished, onLocalTrack);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrack);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
      room.off(RoomEvent.ParticipantConnected, updateParticipants);
      room.off(RoomEvent.ParticipantDisconnected, updateParticipants);
      room.off(RoomEvent.TrackSubscribed, onTrackChange as never);
      room.off(RoomEvent.TrackUnsubscribed, onTrackChange as never);
      room.off(RoomEvent.TrackMuted, onMuteChange);
      room.off(RoomEvent.TrackUnmuted, onMuteChange);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrack);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrack);
    };
  }, [room, updateParticipants]);

  useEffect(() => {
    if (!connect || !url || !token) return;
    let cancelled = false;
    (async () => {
      try {
        await room.connect(url, token);
        if (cancelled) { room.disconnect(); return; }
        connectedRef.current = true;
        if (initialAudio) { try { await room.localParticipant.setMicrophoneEnabled(true); } catch { /* */ } }
        if (initialVideo) { try { await room.localParticipant.setCameraEnabled(true); } catch { /* */ } }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (room.state !== ConnectionState.Disconnected) { room.disconnect(); connectedRef.current = false; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, url, token, room]);

  const toggleMicrophone = useCallback(async () => {
    const next = !room.localParticipant.isMicrophoneEnabled;
    setIsMicEnabled(next);
    try { await room.localParticipant.setMicrophoneEnabled(next); } catch { setIsMicEnabled(!next); }
  }, [room]);
  const toggleCamera = useCallback(async () => {
    const next = !room.localParticipant.isCameraEnabled;
    setIsCamEnabled(next);
    try { await room.localParticipant.setCameraEnabled(next); } catch { setIsCamEnabled(!next); }
  }, [room]);
  const toggleScreenShare = useCallback(async () => {
    const next = !room.localParticipant.isScreenShareEnabled;
    setIsScreenShareEnabled(next);
    try { await room.localParticipant.setScreenShareEnabled(next); } catch { setIsScreenShareEnabled(false); }
  }, [room]);
  const disconnect = useCallback(() => { room.disconnect(); connectedRef.current = false; }, [room]);

  return {
    room, connectionState, remoteParticipants, localParticipant, error,
    toggleMicrophone, toggleCamera, toggleScreenShare, disconnect,
    isMicEnabled, isCamEnabled, isScreenShareEnabled,
  };
}
