import { loadConfig } from '../../src/config/env.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { PG_ERROR } from '../../src/db/errors.js';

export const TEST_DATABASE_NAME = 'health_appointment_test';

/**
 * Where the tests expect Postgres. Overridable so the same suite can run against a throwaway
 * database in CI without editing anything.
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  `postgresql://health:health@localhost:5432/${TEST_DATABASE_NAME}`;

/** The same server, but pointed at the built-in `postgres` database so we can CREATE DATABASE. */
export function adminConnectionString(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

export function createTestDatabase(): Database {
  return createDatabase(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      // A small pool on purpose. The concurrency test fires many requests at once, and a pool that
      // is smaller than the burst is a more honest rehearsal of the free tier.
      DATABASE_POOL_MAX: '10',
      JWT_ACCESS_SECRET: 'test-suite-secret-not-for-real-use-ever',
    }),
  );
}

/**
 * Empties every table between tests.
 *
 * TRUNCATE with CASCADE rather than deleting rows one table at a time: it ignores foreign key
 * ordering, so adding a table later does not mean coming back to fix the order here.
 */
export async function resetDatabase(database: Database): Promise<void> {
  await database.pool.query(`
    TRUNCATE TABLE
      audit_log,
      google_oauth_tokens,
      medication_reminders,
      notification_outbox,
      slot_holds,
      appointments,
      doctor_leaves,
      doctor_working_hours,
      doctor_profiles,
      refresh_tokens,
      users
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Re-exported so tests read the error code exactly the way the application does. If the unwrapping
 * ever breaks, these tests break with it instead of quietly passing against a different reader.
 */
export { postgresErrorCode as sqlStateOf } from '../../src/db/errors.js';

export const EXCLUSION_VIOLATION = PG_ERROR.EXCLUSION_VIOLATION;
export const UNIQUE_VIOLATION = PG_ERROR.UNIQUE_VIOLATION;
