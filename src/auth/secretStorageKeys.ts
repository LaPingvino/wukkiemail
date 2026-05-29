// Secret Storage (4S) key cache + crypto callbacks — mirrors Wally's proven
// implementation (cinny-wally/src/client/secretStorageKeys.js). The SDK calls
// getSecretStorageKey whenever it needs to decrypt a 4S secret (cross-signing
// private keys, key backup key); cacheSecretStorageKey lets the SDK stash a key
// it derived itself (e.g. from a passphrase). Keys are held in memory, keyed by
// their 4S key id — so getSecretStorageKey can return the right one when the
// server offers several.

const secretStorageKeys = new Map<string, Uint8Array>();

export function storePrivateKey(keyId: string, privateKey: Uint8Array): void {
  if (!(privateKey instanceof Uint8Array)) throw new Error('Unable to store: privateKey is invalid.');
  secretStorageKeys.set(keyId, privateKey);
}

function hasPrivateKey(keyId: string): boolean {
  return secretStorageKeys.get(keyId) instanceof Uint8Array;
}

export function clearSecretStorageKeys(): void {
  secretStorageKeys.clear();
}

async function getSecretStorageKey(
  { keys }: { keys: Record<string, unknown> },
): Promise<[string, Uint8Array] | null> {
  const keyId = Object.keys(keys).find(hasPrivateKey);
  if (!keyId) return null;
  return [keyId, secretStorageKeys.get(keyId)!];
}

function cacheSecretStorageKey(keyId: string, _info: unknown, privateKey: Uint8Array): void {
  secretStorageKeys.set(keyId, privateKey);
}

export const cryptoCallbacks = {
  getSecretStorageKey,
  cacheSecretStorageKey,
};
