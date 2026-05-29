// Native MatrixRTC-over-LiveKit call — ported from cinny-wally's
// PersistentCallContainer + LiveKitVideoGrid (our own code, no EC).
//
// Joins the MatrixRTCSession (publishes call.member + manages E2EE keys),
// fetches an SFU token, connects LiveKit, and renders participant tiles with
// mic/cam/screen/hangup controls.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, Track, type Participant } from 'livekit-client';
import { MatrixRTCSessionEvent } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js';
import type { MatrixSource } from './sources/matrix';
import { useLiveKitRoom } from './useLiveKitRoom';
import { MatrixKeyProvider } from './MatrixKeyProvider';
import { fetchSfuToken, discoverOwnFoci, resolveServiceUrl, fociPreferredFor } from './sfu';
import { buildCallUrl, getSfuServiceUrl } from './call';

export function CallView({ matrix, roomId, roomName, onClose }: {
  matrix: MatrixSource;
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const mx = matrix.getClient();
  const [creds, setCreds] = useState<{ url: string; jwt: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [keyProvider] = useState(() => new MatrixKeyProvider());
  const isEncrypted = !!mx?.getRoom(roomId)?.hasEncryptionStateEvent?.();

  const fociRef = useRef<Awaited<ReturnType<typeof discoverOwnFoci>>>([]);

  // 1) Discover the SFU (well-known rtc_foci, else the manual fallback URL),
  // then fetch the LiveKit token for this room.
  useEffect(() => {
    if (!mx) { setTokenError('Not signed in'); return; }
    let cancelled = false;
    (async () => {
      const ownFoci = await discoverOwnFoci(mx);
      if (cancelled) return;
      fociRef.current = ownFoci;
      const serviceUrl = resolveServiceUrl(mx, roomId, ownFoci, getSfuServiceUrl());
      if (!serviceUrl) {
        setTokenError('No LiveKit SFU found. Your homeserver doesn’t advertise one (.well-known rtc_foci) — set the lk-jwt-service URL in Settings → Call SFU.');
        return;
      }
      try {
        const r = await fetchSfuToken(mx, serviceUrl, roomId);
        if (!cancelled) setCreds(r);
      } catch (e) {
        if (!cancelled) setTokenError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [mx, roomId]);

  // 2) Join the MatrixRTC session (call.member membership + E2EE key bridge).
  useEffect(() => {
    if (!mx) return;
    const room = mx.getRoom(roomId);
    if (!room) return;
    const rtc = mx.matrixRTC.getRoomSession(room);
    const onKey = (key: Uint8Array, keyIndex: number, participantId: string) => {
      void keyProvider.setEncryptionKey(key, keyIndex, participantId);
    };
    if (isEncrypted) rtc.on(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
    rtc.joinRoomSession(
      fociPreferredFor(roomId, fociRef.current, getSfuServiceUrl()),
      { type: 'livekit', focus_selection: 'oldest_membership' } as never,
      { manageMediaKeys: isEncrypted, useExperimentalToDeviceTransport: true } as never,
    );
    if (isEncrypted) rtc.reemitEncryptionKeys?.();
    return () => {
      if (isEncrypted) rtc.off(MatrixRTCSessionEvent.EncryptionKeyChanged, onKey);
      void rtc.leaveRoomSession();
    };
  }, [mx, roomId, isEncrypted, keyProvider]);

  // 3) Connect LiveKit.
  const lk = useLiveKitRoom({
    url: creds?.url ?? '',
    token: creds?.jwt ?? '',
    connect: !!creds,
    initialAudio: false,
    initialVideo: false,
    e2eeKeyProvider: isEncrypted ? keyProvider : undefined,
    onDisconnected: onClose,
  });

  const tiles = useMemo(() => {
    const ps: Participant[] = [];
    if (lk.localParticipant) ps.push(lk.localParticipant);
    ps.push(...lk.remoteParticipants);
    return ps;
  }, [lk.localParticipant, lk.remoteParticipants]);

  const hangUp = () => { lk.disconnect(); onClose(); };
  const connecting = !!creds && lk.connectionState !== ConnectionState.Connected;

  return (
    <div className="call-panel" role="dialog" aria-modal="true" aria-label={`Call in ${roomName}`}>
      <header className="call-head">
        <button type="button" className="hamburger" aria-label="Leave call" onClick={hangUp}>
          <span className="material-symbols-outlined" style={{ color: 'var(--md-sys-color-error)' }}>call_end</span>
        </button>
        <div className="call-title">Call · {roomName}</div>
        <span className="call-status">
          {tokenError ? 'error' : !creds ? 'getting token…' : connecting ? 'connecting…' : `${tiles.length} in call`}
        </span>
      </header>

      {tokenError ? (
        <div className="call-error">
          <p>Couldn’t start the in-app call.</p>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{tokenError}</p>
          <a className="call-fallback-link" href={buildCallUrl(roomId, roomName)} target="_blank" rel="noopener noreferrer">
            <span className="material-symbols-outlined">open_in_new</span>
            Open the call page in a new tab instead
          </a>
        </div>
      ) : (
        <div className="call-grid" data-count={Math.min(tiles.length, 9)}>
          {tiles.map((p) => <CallTile key={p.sid || p.identity} participant={p} isLocal={p === lk.localParticipant} />)}
          {tiles.length === 0 && <div className="call-empty">{connecting ? 'Connecting…' : 'Waiting for media…'}</div>}
        </div>
      )}

      <div className="call-controls" role="group" aria-label="Call controls">
        <button type="button" className={`call-btn ${lk.isMicEnabled ? 'on' : ''}`} aria-pressed={lk.isMicEnabled} aria-label={lk.isMicEnabled ? 'Mute microphone' : 'Unmute microphone'} onClick={() => void lk.toggleMicrophone()}>
          <span className="material-symbols-outlined">{lk.isMicEnabled ? 'mic' : 'mic_off'}</span>
        </button>
        <button type="button" className={`call-btn ${lk.isCamEnabled ? 'on' : ''}`} aria-pressed={lk.isCamEnabled} aria-label={lk.isCamEnabled ? 'Turn camera off' : 'Turn camera on'} onClick={() => void lk.toggleCamera()}>
          <span className="material-symbols-outlined">{lk.isCamEnabled ? 'videocam' : 'videocam_off'}</span>
        </button>
        <button type="button" className={`call-btn ${lk.isScreenShareEnabled ? 'on' : ''}`} aria-pressed={lk.isScreenShareEnabled} aria-label="Share screen" onClick={() => void lk.toggleScreenShare()}>
          <span className="material-symbols-outlined">screen_share</span>
        </button>
        <button type="button" className="call-btn end" aria-label="Leave call" onClick={hangUp}>
          <span className="material-symbols-outlined">call_end</span>
        </button>
      </div>
    </div>
  );
}

function CallTile({ participant, isLocal }: { participant: Participant; isLocal: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const camPub = participant.getTrackPublication(Track.Source.Camera)
      ?? participant.getTrackPublication(Track.Source.ScreenShare);
    const v = videoRef.current;
    if (camPub?.track && v) { camPub.track.attach(v); return () => { camPub.track?.detach(v); }; }
  });

  useEffect(() => {
    if (isLocal) return; // never play our own audio
    const micPub = participant.getTrackPublication(Track.Source.Microphone);
    const a = audioRef.current;
    if (micPub?.track && a) { micPub.track.attach(a); return () => { micPub.track?.detach(a); }; }
  });

  const camOn = participant.isCameraEnabled || participant.isScreenShareEnabled;
  return (
    <div className="call-tile">
      <video ref={videoRef} autoPlay playsInline muted={isLocal} style={{ display: camOn ? 'block' : 'none' }} />
      {!camOn && <div className="call-tile-avatar">{(participant.name || participant.identity || '?').slice(0, 1).toUpperCase()}</div>}
      {!isLocal && <audio ref={audioRef} autoPlay />}
      <div className="call-tile-name">
        {!participant.isMicrophoneEnabled && <span className="material-symbols-outlined" style={{ fontSize: 14 }}>mic_off</span>}
        {participant.name || participant.identity}{isLocal ? ' (you)' : ''}
      </div>
    </div>
  );
}
