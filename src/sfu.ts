// SFU (LiveKit) token + focus resolution — ported from cinny-wally
// (hooks/useSfuToken.ts + PersistentCallContainer focus logic). Our own code.
//
// Flow: OpenID token from homeserver → POST lk-jwt-service /sfu/get → { jwt, url }.
// Service URL: the oldest active call.member's livekit focus (federated), else
// our homeserver's own .well-known rtc_foci.
import type { MatrixClient } from 'matrix-js-sdk';
import { MatrixRTCSession } from 'matrix-js-sdk/lib/matrixrtc/MatrixRTCSession.js';

export interface SfuTokenResult { jwt: string; url: string }

export async function fetchSfuToken(mx: MatrixClient, serviceUrl: string, roomId: string): Promise<SfuTokenResult> {
  const deviceId = mx.getDeviceId() ?? 'UNKNOWN';
  const openIdToken = await mx.getOpenIdToken();
  const resp = await fetch(`${serviceUrl}/sfu/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room: roomId,
      openid_token: {
        access_token: openIdToken.access_token,
        token_type: openIdToken.token_type,
        matrix_server_name: openIdToken.matrix_server_name,
        expires_in: openIdToken.expires_in,
      },
      device_id: deviceId,
    }),
  });
  if (!resp.ok) throw new Error(`SFU token request failed (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  return { jwt: data.jwt, url: data.url };
}

type RtcFocus = { type: string; livekit_service_url?: string; livekit_alias?: string };

// The homeserver's own livekit focus from .well-known.
export function ownLivekitFocus(mx: MatrixClient): RtcFocus | undefined {
  const wk = mx.getClientWellKnown?.() as Record<string, unknown> | undefined;
  const foci = wk?.['org.matrix.msc4143.rtc_foci'] as RtcFocus[] | undefined;
  return foci?.find((f) => f.type === 'livekit' && f.livekit_service_url);
}

// Service URL to fetch the token from: oldest active member's focus (so we join
// the SFU the call already lives on, even across federation), else our own.
export function resolveCallServiceUrl(mx: MatrixClient, roomId: string): string {
  const own = ownLivekitFocus(mx)?.livekit_service_url ?? '';
  let serviceUrl = own;
  const room = mx.getRoom(roomId);
  if (room) {
    try {
      const memberships = MatrixRTCSession.callMembershipsForRoom(room);
      let oldestTs = Infinity;
      for (const m of memberships) {
        const created = (m as unknown as { createdTs?: () => number }).createdTs?.() ?? Date.now();
        const foci = (m as unknown as { getPreferredFoci?: () => RtcFocus[] }).getPreferredFoci?.() ?? [];
        const lk = foci.find((f) => f.type === 'livekit' && f.livekit_service_url);
        if (lk?.livekit_service_url && created < oldestTs) {
          oldestTs = created;
          serviceUrl = lk.livekit_service_url;
        }
      }
    } catch { /* fall back to own */ }
  }
  return serviceUrl;
}

export function fociPreferredFor(mx: MatrixClient, roomId: string): RtcFocus[] {
  const lk = ownLivekitFocus(mx);
  return lk ? [{ type: 'livekit', livekit_service_url: lk.livekit_service_url ?? '', livekit_alias: roomId }] : [];
}
