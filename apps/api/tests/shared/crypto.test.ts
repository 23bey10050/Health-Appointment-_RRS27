import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../../src/shared/crypto.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plain string', () => {
    const encrypted = encryptSecret('a-real-google-refresh-token', KEY);

    expect(encrypted).not.toContain('a-real-google-refresh-token');
    expect(decryptSecret(encrypted, KEY)).toBe('a-real-google-refresh-token');
  });

  it('produces a different ciphertext each time, even for the same plaintext', () => {
    // The random IV is what makes this true - two encryptions of the same secret must never look
    // identical in storage, or an attacker with read access to the table could spot repeats.
    const first = encryptSecret('same-token', KEY);
    const second = encryptSecret('same-token', KEY);

    expect(first).not.toBe(second);
    expect(decryptSecret(first, KEY)).toBe('same-token');
    expect(decryptSecret(second, KEY)).toBe('same-token');
  });

  it('refuses to decrypt with the wrong key', () => {
    const encrypted = encryptSecret('a-real-google-refresh-token', KEY);

    expect(() => decryptSecret(encrypted, OTHER_KEY)).toThrow();
  });

  it('rejects a key that does not decode to exactly 32 bytes', () => {
    const shortKey = Buffer.from('too-short').toString('base64');

    expect(() => encryptSecret('anything', shortKey)).toThrow(/32 bytes/);
  });
});
