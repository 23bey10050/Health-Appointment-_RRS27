import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  unknownUserPasswordHash,
  verifyPassword,
} from '../../src/shared/password.js';

describe('hashPassword / verifyPassword', () => {
  it('produces a hash that verifies against the original password', async () => {
    const passwordHash = await hashPassword('a reasonably long passphrase');

    await expect(verifyPassword(passwordHash, 'a reasonably long passphrase')).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const passwordHash = await hashPassword('a reasonably long passphrase');

    await expect(verifyPassword(passwordHash, 'not the right one')).resolves.toBe(false);
  });

  it('never produces the same hash twice, because each call gets a fresh salt', async () => {
    const first = await hashPassword('same password both times');
    const second = await hashPassword('same password both times');

    expect(first).not.toBe(second);
  });

  it('writes the algorithm as argon2id, the OWASP-recommended choice', async () => {
    const passwordHash = await hashPassword('whatever the password is');

    expect(passwordHash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('unknownUserPasswordHash', () => {
  it('is a real hash that nothing will ever match', async () => {
    const dummy = await unknownUserPasswordHash();

    expect(dummy.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(dummy, 'literally anything')).resolves.toBe(false);
  });

  it('is computed once and reused, not re-hashed on every call', async () => {
    const first = await unknownUserPasswordHash();
    const second = await unknownUserPasswordHash();

    // Same string back both times is what proves it was cached rather than hashed twice - two
    // fresh hashes of the same input would differ, since hashPassword salts every call.
    expect(first).toBe(second);
  });
});
