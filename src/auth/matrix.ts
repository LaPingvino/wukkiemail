// Minimal Matrix authentication: mxid + password → access token.
// Homeserver discovered via /.well-known/matrix/client per the spec.
// Credentials persisted in localStorage; the client is rebuilt on reload.

import { createClient, MemoryStore, type MatrixClient } from 'matrix-js-sdk';

export interface MatrixCreds {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

const STORAGE_KEY = 'wukkiemail.matrix.creds.v1';

export function loadCreds(): MatrixCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MatrixCreds) : null;
  } catch {
    return null;
  }
}

export function saveCreds(c: MatrixCreds): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

export function clearCreds(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// Returns the base URL for a server name (host portion of an mxid).
// Falls back to https://<serverName> if .well-known is absent — same behavior
// as Element and matrix-js-sdk's autoDiscoveryFromDomain.
export async function discoverHomeserver(serverName: string): Promise<string> {
  try {
    const res = await fetch(`https://${serverName}/.well-known/matrix/client`, {
      headers: { accept: 'application/json' },
    });
    if (res.ok) {
      const body = (await res.json()) as { 'm.homeserver'?: { base_url?: string } };
      const base = body['m.homeserver']?.base_url;
      if (base) return base.replace(/\/$/, '');
    }
  } catch {
    // network error → fall through to default
  }
  return `https://${serverName}`;
}

export function parseMxid(input: string): { userId: string; serverName: string } {
  const trimmed = input.trim();
  // Accept "@user:server", "user:server", or "user@server"
  const m = trimmed.match(/^@?([^:@]+)[:@](.+)$/);
  if (!m) throw new Error(`not a Matrix ID: ${input}`);
  const [, user, server] = m;
  return { userId: `@${user}:${server}`, serverName: server };
}

export async function loginWithPassword(
  mxidInput: string,
  password: string,
): Promise<MatrixCreds> {
  const { userId, serverName } = parseMxid(mxidInput);
  const homeserverUrl = await discoverHomeserver(serverName);

  // A throwaway client just for the login call.
  const tmp = createClient({ baseUrl: homeserverUrl });
  const res = await tmp.login('m.login.password', {
    identifier: { type: 'm.id.user', user: userId },
    password,
    initial_device_display_name: 'WukkieMail',
  });

  return {
    homeserverUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
}

export function buildClient(creds: MatrixCreds): MatrixClient {
  // Explicit MemoryStore avoids any "store not initialised" surprises some
  // SDK versions have after a bare createClient(); we'll add an IndexedDB
  // store later for persistence.
  return createClient({
    baseUrl: creds.homeserverUrl,
    accessToken: creds.accessToken,
    userId: creds.userId,
    deviceId: creds.deviceId,
    store: new MemoryStore({ localStorage: window.localStorage }),
    // We don't enable crypto in v0 — read-only triage of plaintext rooms first.
    // Encrypted rooms will show "(encrypted)" placeholders until crypto lands.
  });
}
