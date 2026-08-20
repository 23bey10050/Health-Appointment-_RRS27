import { describe, expect, it, vi } from 'vitest';

import {
  hashRefreshToken,
  issueRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../../../src/modules/auth/tokens.js';

const SECRET = 'a-test-secret-that-is-long-enough-to-be-real';

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips the subject and role', () => {
    const { token } = signAccessToken(
      { sub: 'user-123', role: 'doctor' },
      { secret: SECRET, ttlSeconds: 900 },
    );

    const result = verifyAccessToken(token, SECRET);

    expect(result).toEqual({ valid: true, payload: { sub: 'user-123', role: 'doctor' } });
  });

  it('reports the expiry instant consistently with the ttl given', () => {
    const before = Date.now();
    const { expiresAt } = signAccessToken(
      { sub: 'user-1', role: 'patient' },
      { secret: SECRET, ttlSeconds: 60 },
    );
    const after = Date.now();

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);
  });

  it('refuses a token signed with a different secret', () => {
    const { token } = signAccessToken(
      { sub: 'user-1', role: 'admin' },
      { secret: SECRET, ttlSeconds: 900 },
    );

    const result = verifyAccessToken(token, 'a-completely-different-secret-value');

    expect(result).toEqual({ valid: false, reason: 'invalid' });
  });

  it('refuses a token that has expired', () => {
    vi.useFakeTimers();
    try {
      const { token } = signAccessToken(
        { sub: 'user-1', role: 'patient' },
        { secret: SECRET, ttlSeconds: 1 },
      );

      vi.advanceTimersByTime(2000);

      expect(verifyAccessToken(token, SECRET)).toEqual({ valid: false, reason: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses garbage that is not a token at all', () => {
    expect(verifyAccessToken('not-a-real-token', SECRET)).toEqual({
      valid: false,
      reason: 'invalid',
    });
    expect(verifyAccessToken('', SECRET)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects a token signed with none/HS512, refusing to trust the algorithm the token claims', () => {
    // A minimal forged JWT using the "none" algorithm - the classic JWT library footgun where an
    // attacker strips the signature and hopes the verifier trusts the header's own claim.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'attacker', role: 'admin' })).toString(
      'base64url',
    );
    const forged = `${header}.${payload}.`;

    expect(verifyAccessToken(forged, SECRET)).toEqual({ valid: false, reason: 'invalid' });
  });
});

describe('issueRefreshToken', () => {
  it('produces a token whose hash matches hashRefreshToken', () => {
    const issued = issueRefreshToken(30);

    expect(issued.tokenHash).toBe(hashRefreshToken(issued.token));
  });

  it('sets the expiry the requested number of days out', () => {
    const before = Date.now();
    const issued = issueRefreshToken(7);
    const after = Date.now();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(after + sevenDaysMs);
  });

  it('never issues the same token twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => issueRefreshToken(30).token));

    expect(seen.size).toBe(200);
  });
});

describe('hashRefreshToken', () => {
  it('is deterministic, since it has to be looked up again later', () => {
    expect(hashRefreshToken('same-input')).toBe(hashRefreshToken('same-input'));
  });

  it('is sensitive to every character, so a near-miss token cannot pass', () => {
    expect(hashRefreshToken('token-value-a')).not.toBe(hashRefreshToken('token-value-b'));
  });
});
