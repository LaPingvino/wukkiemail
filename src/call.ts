// Voice/video calls are delegated to Element Call (a maintained MatrixRTC
// product) embedded in an in-app iframe. We don't reimplement RTC — the only
// thing that can go wrong is the URL, which is a single editable template, so
// it's trivial to fix without touching call logic. Element Call, logged into
// the same Matrix account, joins the very same room call that Wally/Element
// users are in.
//
// The template supports {roomId} and {roomName} placeholders.

const KEY = 'wukkiemail.callUrlTemplate';
// Default to the Wally Conference guest page (standalone LiveKit client, no
// Element Call / Matrix auth → no "Join as Guest" prompt). Point it at your
// wally-conference deployment; the {roomId} segment is the Matrix room id. The
// bot must be in the room (!wc activate). Editable in settings → Call link.
export const DEFAULT_CALL_TEMPLATE = 'https://chat.kiefte.eu/guest/{roomId}';

export function getCallTemplate(): string {
  try { return localStorage.getItem(KEY) || DEFAULT_CALL_TEMPLATE; } catch { return DEFAULT_CALL_TEMPLATE; }
}

export function setCallTemplate(v: string): void {
  try {
    const t = v.trim();
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

// Manual lk-jwt-service URL for the native call, used when the homeserver
// doesn't advertise org.matrix.msc4143.rtc_foci in .well-known (so we can't
// auto-discover the SFU). e.g. https://livekit-jwt.chat.kiefte.eu
const SFU_KEY = 'wukkiemail.sfuServiceUrl';
export function getSfuServiceUrl(): string {
  try { return localStorage.getItem(SFU_KEY) ?? ''; } catch { return ''; }
}
export function setSfuServiceUrl(v: string): void {
  try {
    const t = v.trim().replace(/\/$/, '');
    if (t) localStorage.setItem(SFU_KEY, t);
    else localStorage.removeItem(SFU_KEY);
  } catch { /* ignore */ }
}

export function buildCallUrl(roomId: string, roomName = ''): string {
  return getCallTemplate()
    .replace('{roomId}', encodeURIComponent(roomId))
    .replace('{roomName}', encodeURIComponent(roomName));
}
