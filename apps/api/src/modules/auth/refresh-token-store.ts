import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import type { DbTransaction } from '../../db/client.js';
import { refreshTokens } from '../../db/schema.js';
import { hashRefreshToken, issueRefreshToken, type IssuedRefreshToken } from './tokens.js';

export interface StoredRefreshTokenContext {
  userId: string;
  familyId: string;
}

export type RefreshLookup =
  | { outcome: 'valid'; row: typeof refreshTokens.$inferSelect }
  | { outcome: 'reused'; row: typeof refreshTokens.$inferSelect }
  | { outcome: 'expired'; row: typeof refreshTokens.$inferSelect }
  | { outcome: 'not_found' };

/**
 * Creates the first refresh token of a new session — a fresh family of its own.
 *
 * "Family" is the unit reuse detection works on: every token born from rotating this one shares the
 * `familyId`, so a single stolen-and-reused token can revoke every descendant it has, not just
 * itself.
 */
export async function createRefreshTokenFamily(
  tx: DbTransaction,
  userId: string,
  ttlDays: number,
  request?: { userAgent?: string; ipAddress?: string },
): Promise<IssuedRefreshToken & StoredRefreshTokenContext> {
  const issued = issueRefreshToken(ttlDays);
  const familyId = randomUUID();

  await tx.insert(refreshTokens).values({
    userId,
    familyId,
    tokenHash: issued.tokenHash,
    expiresAt: issued.expiresAt,
    userAgent: request?.userAgent,
    ipAddress: request?.ipAddress,
  });

  return { ...issued, userId, familyId };
}

/**
 * Looks up a presented refresh token and locks its row for the rest of the transaction.
 *
 * The row lock (`FOR UPDATE`) is what closes a real race: if the same refresh token is presented
 * twice within milliseconds — a slow network causing a client to retry, or an actual thief racing
 * the real user — the second lookup blocks until the first transaction commits or rolls back,
 * instead of both reading "not yet used" and both successfully rotating.
 */
export async function findRefreshTokenForUpdate(
  tx: DbTransaction,
  token: string,
): Promise<RefreshLookup> {
  const tokenHash = hashRefreshToken(token);

  const [row] = await tx
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .for('update')
    .limit(1);

  if (!row) {
    return { outcome: 'not_found' };
  }

  if (row.revokedAt !== null || row.usedAt !== null) {
    return { outcome: 'reused', row };
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return { outcome: 'expired', row };
  }

  return { outcome: 'valid', row };
}

/**
 * Retires one token and issues its replacement in the same family.
 *
 * Marking the old row `usedAt` (rather than deleting it) is what makes reuse detectable at all —
 * a deleted row would make a stolen-then-reused token look identical to a token nobody has ever
 * seen, and `findRefreshTokenForUpdate` would report `not_found` for both.
 */
export async function rotateRefreshToken(
  tx: DbTransaction,
  current: typeof refreshTokens.$inferSelect,
  ttlDays: number,
  request?: { userAgent?: string; ipAddress?: string },
): Promise<IssuedRefreshToken & StoredRefreshTokenContext> {
  await tx
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(eq(refreshTokens.id, current.id));

  const issued = issueRefreshToken(ttlDays);

  await tx.insert(refreshTokens).values({
    userId: current.userId,
    familyId: current.familyId,
    tokenHash: issued.tokenHash,
    expiresAt: issued.expiresAt,
    userAgent: request?.userAgent,
    ipAddress: request?.ipAddress,
  });

  return { ...issued, userId: current.userId, familyId: current.familyId };
}

/**
 * Revokes every still-live token in a family in one statement.
 *
 * Called for exactly one reason: a token that was already used (or already revoked) has just been
 * presented again. That is what token theft looks like from the server's side — either the thief
 * used it before the real user's next request arrived, or the real user's device is presenting a
 * copy the thief already burned. Either way, every token descended from that session stops working,
 * and the legitimate user finds out the next time they try to use one, by being asked to log in
 * again rather than by a quiet compromise.
 */
export async function revokeRefreshTokenFamily(
  tx: DbTransaction,
  familyId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/** Revokes exactly one token, the ordinary "the user clicked log out" path. */
export async function revokeRefreshToken(
  tx: DbTransaction,
  tokenId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(eq(refreshTokens.id, tokenId));
}
