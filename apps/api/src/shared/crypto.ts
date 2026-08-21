import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
/** 12 bytes is the length GCM is actually designed around - a longer IV gets hashed down to this
 *  size internally anyway, so there is no benefit to picking anything else. */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts one secret string (a Google access or refresh token) for storage.
 *
 * The output packs the random IV, the GCM auth tag, and the ciphertext into one base64 string, in
 * that order, so a row in `google_oauth_tokens` only ever needs one text column per token - there
 * is nothing to reconstruct at read time beyond slicing this same string back apart.
 */
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptSecret(encrypted: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** AES-256 needs exactly 32 key bytes - checked here on every call rather than only once at boot,
 *  since a config test wants to see this fail loudly for a bad key too, not just a running server. */
function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}.`,
    );
  }
  return key;
}
