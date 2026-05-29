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

// Discover the homeserver's livekit foci. We build the client from a base URL
// (no autodiscovery), so getClientWellKnown() is usually empty — fetch the
// server-name's /.well-known/matrix/client directly as a fallback.
export async function discoverOwnFoci(mx: MatrixClient): Promise<RtcFocus[]> {
  const cached = (mx.getClientWellKnown?.() as Record<string, unknown> | undefined)?.['org.matrix.msc4143.rtc_foci'];
  if (Array.isArray(cached) && cached.length) return cached as RtcFocus[];
  const domain = mx.getDomain?.() ?? (mx.getUserId()?.split(':')[1] ?? '');
  if (!domain) return [];
  try {
    const res = await fetch(`https://${domain}/.well-known/matrix/client`, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const body = await res.json();
    const foci = body['org.matrix.msc4143.rtc_foci'];
    return Array.isArray(foci) ? (foci as RtcFocus[]) : [];
  } catch { return []; }
}

// Service URL to fetch the token from: the oldest active member's focus (so we
// join the SFU the call already lives on, even across federation), else our
// homeserver's advertised focus, else the manual fallback URL from settings.
export function resolveServiceUrl(mx: MatrixClient, roomId: string, ownFoci: RtcFocus[], fallback: string): string {
  let serviceUrl = ownFoci.find((f) => f.type === 'livekit' && f.livekit_service_url)?.livekit_service_url ?? fallback;
  const room = mx.getRoom(roomId);
  if (room) {
    try {
      let oldestTs = Infinity;
      for (const m of MatrixRTCSession.callMembershipsForRoom(room)) {
        const created = (m as unknown as { createdTs?: () => number }).createdTs?.() ?? Date.now();
        const foci = (m as unknown as { getPreferredFoci?: () => RtcFocus[] }).getPreferredFoci?.() ?? [];
        const lk = foci.find((f) => f.type === 'livekit' && f.livekit_service_url);
        if (lk?.livekit_service_url && created < oldestTs) { oldestTs = created; serviceUrl = lk.livekit_service_url; }
      }
    } catch { /* keep own/fallback */ }
  }
  return serviceUrl;
}

export function fociPreferredFor(roomId: string, ownFoci: RtcFocus[], fallback: string): RtcFocus[] {
  const url = ownFoci.find((f) => f.type === 'livekit' && f.livekit_service_url)?.livekit_service_url ?? fallback;
  return url ? [{ type: 'livekit', livekit_service_url: url, livekit_alias: roomId }] : [];
}
