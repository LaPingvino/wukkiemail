// Gmail OAuth — browser side.
//
// Flow:
//   1. beginLogin() builds the consent URL with a CSRF state token and
//      navigates the tab to it.
//   2. Google redirects back to /api/gmail/oauth/callback (a Pages
//      Function — see functions/api/gmail/oauth/callback.ts) which
//      swaps the code for tokens and 302s to /auth/gmail/return#…
//      with the tokens in the URL fragment.
//   3. consumeReturnFragment() reads the fragment, validates state,
//      persists creds, and tells the caller we're good.
//
// We never touch tokens server-side after the swap — they live in
// localStorage on this device only.

const STORAGE_KEY = 'wukkiemail.gmail.creds.v1';
const STATE_KEY = 'wukkiemail.gmail.oauth.state';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

export interface GmailCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scope: string;
}

export function loadCreds(): GmailCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GmailCreds) : null;
  } catch {
    return null;
  }
}

export function saveCreds(c: GmailCreds): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export function clearCreds(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function getClientId(): string {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!id) {
    throw new Error(
      'VITE_GOOGLE_CLIENT_ID is not set. Add it to Cloudflare Pages env vars (or .env.local for `vite dev`).',
    );
  }
  return id;
}

function getRedirectUri(): string {
  return `${window.location.origin}/api/gmail/oauth/callback`;
}

export function beginLogin(): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Returns true if we consumed a fragment and saved creds — caller should
// then navigate to /. False means this isn't a return URL.
export function consumeReturnFragment(): boolean {
  if (window.location.pathname !== '/auth/gmail/return') return false;
  const frag = window.location.hash.replace(/^#/, '');
  if (!frag) return false;

  const params = new URLSearchParams(frag);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!expectedState || params.get('state') !== expectedState) {
    // CSRF mismatch — refuse silently; the URL fragment never reached a server.
    return false;
  }
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const expiresInRaw = params.get('expires_in');
  if (!accessToken || !refreshToken || !expiresInRaw) return false;

  const expiresAt = Date.now() + Number(expiresInRaw) * 1000;
  saveCreds({
    accessToken,
    refreshToken,
    expiresAt,
    scope: params.get('scope') ?? '',
  });
  return true;
}
