import { eq } from 'drizzle-orm';

import type { AppConfig } from '../../config/env.js';
import type { Database, DbTransaction } from '../../db/client.js';
import { PG_ERROR, isPostgresError } from '../../db/errors.js';
import { users } from '../../db/schema.js';
import { writeAuditEntry } from '../../shared/audit.js';
import { ConflictError, UnauthorizedError } from '../../shared/errors.js';

import { hashPassword, unknownUserPasswordHash, verifyPassword } from '../../shared/password.js';
import {
  createRefreshTokenFamily,
  findRefreshTokenForUpdate,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
} from './refresh-token-store.js';
import { signAccessToken, type AccessTokenPayload } from './tokens.js';

export interface RequestContext {
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthenticatedResult {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: AccessTokenPayload['role'];
  };
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * The one place credentials become "invalid". Every rejection in login funnels through this so an
 * attacker gets the exact same status code, error code, and message whether the email does not
 * exist, the account is deactivated, or the password is simply wrong.
 */
function invalidCredentials(): UnauthorizedError {
  return new UnauthorizedError('INVALID_CREDENTIALS', 'That email or password is not correct.');
}

async function issueTokens(
  tx: DbTransaction,
  config: AppConfig,
  user: { id: string; email: string; fullName: string; role: AccessTokenPayload['role'] },
  request?: RequestContext,
): Promise<AuthenticatedResult> {
  const access = signAccessToken(
    { sub: user.id, role: user.role },
    { secret: config.auth.jwtAccessSecret, ttlSeconds: config.auth.accessTokenTtlSeconds },
  );
  const refresh = await createRefreshTokenFamily(
    tx,
    user.id,
    config.auth.refreshTokenTtlDays,
    request,
  );

  return {
    user,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}

/**
 * Creates a patient account and signs them straight in.
 *
 * There is no `role` parameter here, ever. Every account this function can produce is a patient —
 * that is the entire security model for who gets to be a doctor or an admin, and it only works if
 * nothing upstream can override it.
 */
export async function registerPatient(
  database: Database,
  config: AppConfig,
  input: { email: string; password: string; fullName: string; phone?: string; timezone?: string },
  request?: RequestContext,
): Promise<AuthenticatedResult> {
  const passwordHash = await hashPassword(input.password);

  try {
    return await database.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          role: 'patient',
          fullName: input.fullName,
          phone: input.phone,
          timezone: input.timezone,
        })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          role: users.role,
        });

      if (!created) {
        throw new Error('Insert returned no row for a new user.');
      }

      await writeAuditEntry(tx, {
        actorId: created.id,
        action: 'user_registered',
        entityType: 'user',
        entityId: created.id,
      });

      return issueTokens(tx, config, created, request);
    });
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw new ConflictError(
        'EMAIL_ALREADY_REGISTERED',
        'An account with that email already exists.',
        { cause: error },
      );
    }
    throw error;
  }
}

type LoginOutcome = { ok: true; result: AuthenticatedResult } | { ok: false };

/**
 * A transaction that throws gets rolled back — that is Drizzle's contract, and it is correct: it
 * is how a half-finished write is guaranteed never to stick. The trap is that a *failed login is
 * itself a write*, the audit entry recording that it happened, and throwing to report "login
 * failed" back up to the route would roll that very entry away. So this function never throws
 * inside the transaction; it writes whatever needs writing, returns a plain outcome describing what
 * happened, and only the caller — after the transaction has committed — turns a failure outcome
 * into the error the route actually raises.
 */
export async function login(
  database: Database,
  config: AppConfig,
  input: { email: string; password: string },
  request?: RequestContext,
): Promise<AuthenticatedResult> {
  const outcome = await database.transaction(async (tx): Promise<LoginOutcome> => {
    const [account] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);

    if (!account || !account.isActive) {
      // Runs the same Argon2 verify a real match would run, against a hash nobody's password will
      // ever match, so a non-existent email takes the same wall-clock time to reject as a wrong
      // password does. The result is discarded on purpose — only the timing matters here.
      await verifyPassword(await unknownUserPasswordHash(), input.password);

      await writeAuditEntry(tx, {
        action: 'login_failed',
        entityType: 'user',
        entityId: account?.id,
        metadata: { reason: account ? 'account_inactive' : 'no_such_account' },
      });
      return { ok: false };
    }

    const passwordMatches = await verifyPassword(account.passwordHash, input.password);
    if (!passwordMatches) {
      await writeAuditEntry(tx, {
        actorId: account.id,
        action: 'login_failed',
        entityType: 'user',
        entityId: account.id,
        metadata: { reason: 'wrong_password' },
      });
      return { ok: false };
    }

    await writeAuditEntry(tx, {
      actorId: account.id,
      action: 'login_succeeded',
      entityType: 'user',
      entityId: account.id,
    });

    return { ok: true, result: await issueTokens(tx, config, account, request) };
  });

  if (!outcome.ok) {
    throw invalidCredentials();
  }
  return outcome.result;
}

type RefreshOutcome =
  { ok: true; result: AuthenticatedResult } | { ok: false; code: string; message: string };

/**
 * Same shape as `login`, and for the same reason: the reuse-detected branch has to *write* a family
 * revocation, and if this function threw from inside `database.transaction(...)` to report that
 * failure, Drizzle would roll the transaction back — undoing the very revocation the whole point of
 * this code path was to make stick. Every branch below returns a plain outcome instead; only the
 * caller, once the transaction has committed, turns a failure outcome into a thrown error.
 */
export async function refreshSession(
  database: Database,
  config: AppConfig,
  refreshToken: string,
  request?: RequestContext,
): Promise<AuthenticatedResult> {
  const outcome = await database.transaction(async (tx): Promise<RefreshOutcome> => {
    const lookup = await findRefreshTokenForUpdate(tx, refreshToken);

    if (lookup.outcome === 'not_found') {
      return {
        ok: false,
        code: 'INVALID_REFRESH_TOKEN',
        message: 'That refresh token is not recognised.',
      };
    }

    if (lookup.outcome === 'reused') {
      // A token that was already used (or already revoked) has been presented again. That is what
      // token theft looks like from here, so every token this session ever produced is burned, not
      // just the one in front of us.
      await revokeRefreshTokenFamily(tx, lookup.row.familyId, 'reuse_detected');
      await writeAuditEntry(tx, {
        actorId: lookup.row.userId,
        action: 'refresh_token_reuse_detected',
        entityType: 'refresh_token_family',
        entityId: lookup.row.familyId,
      });
      return {
        ok: false,
        code: 'SESSION_REVOKED',
        message: 'Your session is no longer valid. Please sign in again.',
      };
    }

    if (lookup.outcome === 'expired') {
      return {
        ok: false,
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Your session has expired. Please sign in again.',
      };
    }

    const [account] = await tx.select().from(users).where(eq(users.id, lookup.row.userId)).limit(1);

    if (!account || !account.isActive) {
      // The account behind this session was deactivated after the token was issued. Burn the whole
      // family rather than quietly refusing just this once, so a disabled account cannot keep
      // getting fresh access tokens by retrying.
      await revokeRefreshTokenFamily(tx, lookup.row.familyId, 'account_inactive');
      return {
        ok: false,
        code: 'SESSION_REVOKED',
        message: 'Your session is no longer valid. Please sign in again.',
      };
    }

    const rotated = await rotateRefreshToken(
      tx,
      lookup.row,
      config.auth.refreshTokenTtlDays,
      request,
    );

    await writeAuditEntry(tx, {
      actorId: account.id,
      action: 'token_refreshed',
      entityType: 'refresh_token_family',
      entityId: lookup.row.familyId,
    });

    const access = signAccessToken(
      { sub: account.id, role: account.role },
      { secret: config.auth.jwtAccessSecret, ttlSeconds: config.auth.accessTokenTtlSeconds },
    );

    return {
      ok: true,
      result: {
        user: account,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: rotated.token,
        refreshTokenExpiresAt: rotated.expiresAt,
      },
    };
  });

  if (!outcome.ok) {
    throw new UnauthorizedError(outcome.code, outcome.message);
  }
  return outcome.result;
}

/**
 * Logging out is intentionally quiet about whether the token existed. An expired session, a token
 * from a device that already logged out, and a token that never existed all end the same way: the
 * caller is logged out and gets no clue which case it was.
 */
export async function logout(database: Database, refreshToken: string): Promise<void> {
  await database.transaction(async (tx) => {
    const lookup = await findRefreshTokenForUpdate(tx, refreshToken);

    if (lookup.outcome === 'valid') {
      await revokeRefreshToken(tx, lookup.row.id, 'logout');
      await writeAuditEntry(tx, {
        actorId: lookup.row.userId,
        action: 'user_logged_out',
        entityType: 'refresh_token',
        entityId: lookup.row.id,
      });
    }
  });
}
