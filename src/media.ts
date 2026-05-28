// Decrypt Matrix encrypted attachments (m.image/file in E2EE rooms) in the
// browser with Web Crypto. The SDK fork doesn't bundle a decryptAttachment
// helper, so we implement the (small) spec ourselves: AES-CTR-256 with the
// per-file JWK key + IV, optional SHA-256 integrity check.

export interface EncryptedFile {
  url: string;                 // mxc:// of the ciphertext
  v?: string;
  key: { kty: string; k: string; alg: string; ext?: boolean; key_ops?: string[] };
  iv: string;                  // base64 (unpadded ok)
  hashes: Record<string, string>; // { sha256: base64 }
}

function b64ToBytes(b64: string): Uint8Array {
  // Accept standard and url-safe base64, padded or not.
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

// Decrypt the ciphertext per the encrypted file's key/iv. Verifies the
// sha256 hash when present. Returns the plaintext bytes.
export async function decryptAttachment(ciphertext: ArrayBuffer, file: EncryptedFile): Promise<ArrayBuffer> {
  if (file.hashes?.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', ciphertext);
    if (bytesToB64(digest).replace(/=+$/, '') !== file.hashes.sha256.replace(/=+$/, '')) {
      throw new Error('attachment hash mismatch');
    }
  }
  const keyBytes = b64ToBytes(file.key.k) as unknown as BufferSource;
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['decrypt']);
  const iv = b64ToBytes(file.iv) as unknown as BufferSource; // 16-byte counter block
  return crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, cryptoKey, ciphertext);
}
