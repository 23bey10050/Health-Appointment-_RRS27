import { createHash, randomBytes } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { UserRole } from '@health/contracts';

/** What an access token asserts about its holder. Nothing more — no email, no name. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Builds a short-lived, self-contained access token.
 *
 * "Self-contained" is the point: verifying one is pure math against the secret, no database round
 * trip. That is what lets an authenticated request stay fast even under load — the cost of a
 * lookup only shows up once, at login, not on every single request afterwards.
 */
export function signAccessToken(
  payload: AccessTokenPayload,
  options: { secret: string; ttlSeconds: number },
): SignedAccessToken {
  const token = jwt.sign(payload, options.secret, {
    expiresIn: options.ttlSeconds,
    algorithm: 'HS256',
  });

  return {
    token,
    expiresAt: new Date(Date.now() + options.ttlSeconds * 1000),
  };
}

export type AccessTokenVerification =
  { valid: true; payload: AccessTokenPayload } | { valid: false; reason: 'expired' | 'invalid' };

export function verifyAccessToken(token: string, secret: string): AccessTokenVerification {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });

    if (typeof decoded !== 'object' || decoded === null) {
      return { valid: false, reason: 'invalid' };
    }

    const { sub, role } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof role !== 'string') {
      return { valid: false, reason: 'invalid' };
    }

    return { valid: true, payload: { sub, role: role as UserRole } };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, reason: 'expired' };
    }
    // Wrong secret, malformed token, wrong algorithm - all the same to the caller: not usable.
    return { valid: false, reason: 'invalid' };
  }
}

export interface IssuedRefreshToken {
  /** The raw token. Sent to the client once and never stored anywhere in this form. */
  token: string;
  /** What gets stored instead, so a stolen database export is not a stolen set of live sessions. */
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Generates an opaque refresh token — random bytes, not a JWT.
 *
 * A refresh token has to be revocable the instant we decide to revoke it, and a JWT cannot be
 * un-issued once handed out; it stays valid until it expires no matter what the database says. An
 * opaque token sidesteps that entirely: the database row it looks up *is* the authority on whether
 * it still works, which is exactly what rotation-with-reuse-detection needs.
 */
export function issueRefreshToken(ttlDays: number): IssuedRefreshToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
  };
}

/**
 * Hashes a refresh token for lookup and storage.
 *
 * Plain SHA-256, not Argon2. Argon2 is for secrets a human might have picked, where an attacker can
 * try a dictionary of likely guesses. A refresh token is 256 bits from a cryptographic random
 * source — there is no dictionary to try, so a slow hash would only slow down every legitimate
 * refresh for no real security gain.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
