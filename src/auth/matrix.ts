// Minimal Matrix authentication: mxid + password → access token.
// Homeserver discovered via /.well-known/matrix/client per the spec.
// Credentials persisted in localStorage; the client is rebuilt on reload.

import { createClient, MemoryStore, type MatrixClient } from 'matrix-js-sdk';
import { IndexedDBStore } from 'matrix-js-sdk/lib/store/indexeddb.js';

export interface MatrixCreds {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

const LEGACY_STORAGE_KEY = 'wukkiemail.matrix.creds.v1';
const SLOT_INDEX_KEY = 'wukkiemail.matrix.slots';
const ACTIVE_SLOT_KEY = 'wukkiemail.matrix.activeSlot';
const slotKey = (slot: string) => `wukkiemail.matrix.creds.v1.${slot}`;

// One-shot migration: if a single-slot creds blob is still in localStorage
// from before multi-account, move it to a userId-keyed slot.
function migrateLegacyIfPresent(): void {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return;
    const creds = JSON.parse(raw) as MatrixCreds;
    const slot = creds.userId;
    if (slot) {
      localStorage.setItem(slotKey(slot), raw);
      localStorage.setItem(SLOT_INDEX_KEY, JSON.stringify([slot]));
      localStorage.setItem(ACTIVE_SLOT_KEY, slot);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* leave legacy in place */ }
}

export function listSlots(): string[] {
  migrateLegacyIfPresent();
  try {
    const raw = localStorage.getItem(SLOT_INDEX_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

export function getActiveSlot(): string | null {
  migrateLegacyIfPresent();
  const slot = localStorage.getItem(ACTIVE_SLOT_KEY);
  return slot && listSlots().includes(slot) ? slot : (listSlots()[0] ?? null);
}

export function setActiveSlot(slot: string): void {
  localStorage.setItem(ACTIVE_SLOT_KEY, slot);
}

export function loadCreds(slot?: string): MatrixCreds | null {
  migrateLegacyIfPresent();
  const target = slot ?? getActiveSlot();
  if (!target) return null;
  try {
    const raw = localStorage.getItem(slotKey(target));
    return raw ? (JSON.parse(raw) as MatrixCreds) : null;
  } catch { return null; }
}

export function saveCreds(c: MatrixCreds): void {
  const slot = c.userId;
  localStorage.setItem(slotKey(slot), JSON.stringify(c));
  const slots = new Set(listSlots());
  slots.add(slot);
  localStorage.setItem(SLOT_INDEX_KEY, JSON.stringify([...slots]));
  if (!localStorage.getItem(ACTIVE_SLOT_KEY)) setActiveSlot(slot);
}

export function clearCreds(slot?: string): void {
  const target = slot ?? getActiveSlot();
  if (!target) return;
  localStorage.removeItem(slotKey(target));
  const slots = listSlots().filter((s) => s !== target);
  localStorage.setItem(SLOT_INDEX_KEY, JSON.stringify(slots));
  if (getActiveSlot() === target) {
    if (slots[0]) setActiveSlot(slots[0]);
    else localStorage.removeItem(ACTIVE_SLOT_KEY);
  }
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

// Build a client backed by IndexedDB so the next page load is fast.
// Order is load-bearing: IndexedDBStore.startup() MUST be called AFTER
// the store is assigned to a client (createClient does that), otherwise
// the SDK throws "must be called after assigning it to the client".
//
// URL flags for debugging:
//   ?nostore — skip IndexedDB, use MemoryStore
//   ?reset   — delete the IndexedDB before building
export async function buildClient(creds: MatrixCreds): Promise<MatrixClient> {
  const params = new URLSearchParams(window.location.search);
  const dbName = `wukkiemail:matrix:${creds.userId}`;
  if (params.has('reset')) {
    // eslint-disable-next-line no-console
    console.warn('[wukkiemail] ?reset — deleting IndexedDB', dbName);
    try { window.indexedDB.deleteDatabase(dbName); } catch (e) { console.warn(e); }
  }

  let store: IndexedDBStore | MemoryStore;
  if (params.has('nostore')) {
    // eslint-disable-next-line no-console
    console.warn('[wukkiemail] ?nostore — using MemoryStore');
    store = new MemoryStore({ localStorage: window.localStorage });
  } else {
    store = new IndexedDBStore({
      indexedDB: window.indexedDB,
      localStorage: window.localStorage,
      dbName,
    });
  }

  const client = createClient({
    baseUrl: creds.homeserverUrl,
    accessToken: creds.accessToken,
    userId: creds.userId,
    deviceId: creds.deviceId,
    store,
    cryptoCallbacks: {
      // SDK calls this when it needs to decrypt SSSS secrets (cross-signing
      // private keys, key backup). bootstrapEncryption / verifyWithRecoveryKey
      // stash a Uint8Array on window._wukkieKey; we return it keyed by the
      // server's SSSS default key id.
      getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => {
        const stash = (window as unknown as { _wukkieKey?: Uint8Array })._wukkieKey;
        if (!stash) return null;
        const keyId = Object.keys(keys)[0];
        if (!keyId) return null;
        return [keyId, stash] as [string, Uint8Array];
      },
    },
  });

  // Now that the store has been linked to a client, hydrate it. A corrupt
  // IndexedDB throws "Query failed: UnknownError" on startup; rather than
  // permanently falling back to MemoryStore (which forces a full re-sync on
  // EVERY reload), delete the broken DB and rebuild it once — that restores
  // persistence so subsequent loads hydrate from cache instantly. Only if the
  // rebuild also fails do we use MemoryStore.
  if (store instanceof IndexedDBStore) {
    try {
      await store.startup();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] IndexedDB startup failed — rebuilding the local store', e);
      try {
        // Close the failed store's connection first, or deleteDatabase is
        // blocked and the "fresh" store just reopens the same broken DB.
        try { await (store as unknown as { destroy?: () => Promise<void> }).destroy?.(); } catch { /* ignore */ }
        await new Promise<void>((resolve) => {
          const req = window.indexedDB.deleteDatabase(dbName);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
        const fresh = new IndexedDBStore({
          indexedDB: window.indexedDB,
          localStorage: window.localStorage,
          dbName,
        });
        (client as unknown as { store: IndexedDBStore }).store = fresh;
        await fresh.startup();
        // eslint-disable-next-line no-console
        console.info('[wukkiemail] local store rebuilt; persistence restored');
      } catch (e2) {
        // eslint-disable-next-line no-console
        console.warn('[wukkiemail] store rebuild failed, using MemoryStore (no persistence)', e2);
        const mem = new MemoryStore({ localStorage: window.localStorage });
        (client as unknown as { store: MemoryStore }).store = mem;
      }
    }
  }

  return client;
}
