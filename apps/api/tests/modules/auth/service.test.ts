import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import type { Database } from '../../../src/db/client.js';
import { auditLog, users } from '../../../src/db/schema.js';
import {
  login,
  logout,
  refreshSession,
  registerPatient,
} from '../../../src/modules/auth/service.js';
import { AppError } from '../../../src/shared/errors.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';

let database: Database;
let config: AppConfig;

beforeAll(() => {
  database = createTestDatabase();
  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://health:health@localhost:5432/health_appointment_test',
    JWT_ACCESS_SECRET: 'test-suite-secret-not-for-real-use-ever',
  });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
});

async function auditActions(): Promise<string[]> {
  const rows = await database.db.select({ action: auditLog.action }).from(auditLog);
  return rows.map((row) => row.action);
}

/**
 * These tests exist because of a real bug found while building this module: writing an audit entry
 * and then throwing to report a failure, both inside the same `database.transaction(...)`, rolled
 * the audit entry back along with everything else the throw was meant to reject. The HTTP-level
 * tests in auth-routes.test.ts prove the status codes are right; these prove the side effect that
 * bug actually destroyed - a durable row in `audit_log` - really lands.
 */
describe('every login attempt is recorded, including failed ones', () => {
  it('writes login_failed when the email does not exist, and the transaction still commits', async () => {
    await expect(
      login(database, config, { email: 'nobody@example.test', password: 'whatever this is' }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await auditActions()).toEqual(['login_failed']);
  });

  it('writes login_failed with the wrong-password reason, distinct from no-such-account', async () => {
    await registerPatient(database, config, {
      email: 'asha@example.test',
      password: 'the correct passphrase',
      fullName: 'Asha Verma',
    });

    await expect(
      login(database, config, { email: 'asha@example.test', password: 'not the right one' }),
    ).rejects.toBeInstanceOf(AppError);

    const [entry] = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'login_failed'));
    expect(entry?.metadata).toMatchObject({ reason: 'wrong_password' });
  });

  it('refuses a deactivated account and still writes the attempt', async () => {
    const registered = await registerPatient(database, config, {
      email: 'inactive@example.test',
      password: 'a perfectly fine passphrase',
      fullName: 'Inactive Person',
    });
    await database.db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, registered.user.id));

    await expect(
      login(database, config, {
        email: 'inactive@example.test',
        password: 'a perfectly fine passphrase',
      }),
    ).rejects.toBeInstanceOf(AppError);

    const [entry] = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'login_failed'));
    expect(entry?.metadata).toMatchObject({ reason: 'account_inactive' });
  });

  it('writes login_succeeded for the real thing', async () => {
    await registerPatient(database, config, {
      email: 'bilal@example.test',
      password: 'a perfectly fine passphrase',
      fullName: 'Bilal Ahmed',
    });

    await login(database, config, {
      email: 'bilal@example.test',
      password: 'a perfectly fine passphrase',
    });

    expect(await auditActions()).toEqual(['user_registered', 'login_succeeded']);
  });
});

describe('refresh token reuse is recorded and actually revokes the family', () => {
  it('writes refresh_token_reuse_detected and the revocation survives the rejection', async () => {
    const registered = await registerPatient(database, config, {
      email: 'chitra@example.test',
      password: 'a perfectly fine passphrase',
      fullName: 'Chitra Rao',
    });

    const rotated = await refreshSession(database, config, registered.refreshToken);
    // Reusing the original token is the attack signal.
    await expect(refreshSession(database, config, registered.refreshToken)).rejects.toBeInstanceOf(
      AppError,
    );

    expect(await auditActions()).toEqual([
      'user_registered',
      'token_refreshed',
      'refresh_token_reuse_detected',
    ]);

    // The real proof: the token issued by the ONE successful rotation must also be dead, because
    // the family revocation has to have actually committed, not been rolled back with the throw.
    await expect(refreshSession(database, config, rotated.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });
});

describe('logout is recorded exactly once, never for a token that was not there', () => {
  it('writes user_logged_out for a real session', async () => {
    const registered = await registerPatient(database, config, {
      email: 'dev@example.test',
      password: 'a perfectly fine passphrase',
      fullName: 'Dev Patel',
    });

    await logout(database, registered.refreshToken);

    expect(await auditActions()).toEqual(['user_registered', 'user_logged_out']);
  });

  it('writes nothing for a token that never existed', async () => {
    await logout(database, 'this-token-was-never-issued');

    expect(await auditActions()).toEqual([]);
  });
});
