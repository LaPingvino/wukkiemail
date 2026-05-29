// Voice/video calls are delegated to Element Call (a maintained MatrixRTC
// product) embedded in an in-app iframe. We don't reimplement RTC — the only
// thing that can go wrong is the URL, which is a single editable template, so
// it's trivial to fix without touching call logic. Element Call, logged into
// the same Matrix account, joins the very same room call that Wally/Element
// users are in.
//
// The template supports {roomId} and {roomName} placeholders.

const KEY = 'wukkiemail.callUrlTemplate';
export const DEFAULT_CALL_TEMPLATE = 'https://call.element.io/room/#?roomId={roomId}';

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

export function buildCallUrl(roomId: string, roomName = ''): string {
  return getCallTemplate()
    .replace('{roomId}', encodeURIComponent(roomId))
    .replace('{roomName}', encodeURIComponent(roomName));
}
