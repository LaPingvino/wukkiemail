// Bridges MatrixRTC encryption keys to LiveKit's E2EE worker.
// Ported verbatim from cinny-wally (features/call/MatrixKeyProvider.ts) — it's
// our own code, so no fighting. MatrixRTCSession emits EncryptionKeyChanged
// with per-participant keys; this feeds them to LiveKit's E2EE system.
import { BaseKeyProvider } from 'livekit-client';

export class MatrixKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 256 });
  }

  // LiveKit's E2EE worker calls deriveKeys() (HKDF) on the key material, so we
  // must import as HKDF key material (deriveBits/deriveKey), NOT AES-GCM — the
  // latter fails silently in the worker.
  async setEncryptionKey(key: Uint8Array, keyIndex: number, participantIdentity: string): Promise<void> {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key as BufferSource,
        'HKDF',
        false,
        ['deriveBits', 'deriveKey'],
      );
      this.onSetEncryptionKey(cryptoKey, participantIdentity, keyIndex);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[wukkiemail] failed to import call encryption key', e);
    }
  }
}
