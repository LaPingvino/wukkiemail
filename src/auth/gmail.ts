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

// Gmail "metadata" scope only — headers, labels, threading; NO message bodies.
// Restricted scopes (gmail.readonly) require a Cloud Application Security
// Assessment that's both expensive and slow. Metadata is "sensitive" but not
// restricted: basic OAuth verification suffices once we want a hosted multi-
// user instance. WukkieMail surfaces triage info inline and links out to
// mail.google.com/.../<threadId> when the user wants the body.
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.metadata',
].join(' ');

// Build a deep link into the Gmail web UI for a given thread id.
// The /u/0/ slot is "first signed-in account"; we don't know which slot the
// user's account occupies, so we use the explicit ?authuser=<email> form.
export function gmailThreadUrl(threadId: string, email: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#inbox/${threadId}`;
}

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
  // eslint-disable-next-line no-console
  console.info('[wukkiemail] gmail return', {
    hasFragment: frag.length > 0,
    keys: frag ? [...new URLSearchParams(frag).keys()] : [],
  });
  if (!frag) return false;

  const params = new URLSearchParams(frag);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!expectedState || params.get('state') !== expectedState) {
    // eslint-disable-next-line no-console
    console.warn('[wukkiemail] gmail return: state mismatch', { expected: expectedState, got: params.get('state') });
    return false;
  }
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const expiresInRaw = params.get('expires_in');
  if (!accessToken || !refreshToken || !expiresInRaw) {
    // eslint-disable-next-line no-console
    console.warn('[wukkiemail] gmail return: missing tokens in fragment');
    return false;
  }

  const expiresAt = Date.now() + Number(expiresInRaw) * 1000;
  saveCreds({
    accessToken,
    refreshToken,
    expiresAt,
    scope: params.get('scope') ?? '',
  });
  // eslint-disable-next-line no-console
  console.info('[wukkiemail] gmail return: creds saved');
  return true;
}
