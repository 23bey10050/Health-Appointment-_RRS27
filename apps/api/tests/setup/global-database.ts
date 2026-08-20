import pg from 'pg';

import { runMigrations } from '../../src/db/migrator.js';
import { describeUnknownError } from '../../src/shared/errors.js';
import {
  TEST_DATABASE_NAME,
  TEST_DATABASE_URL,
  adminConnectionString,
} from '../helpers/database.js';

/**
 * Runs once before the whole test suite: makes sure a test database exists and is migrated.
 *
 * These tests talk to a real Postgres on purpose. The thing being tested — an exclusion constraint
 * that rejects overlapping bookings — lives entirely inside the database. A mock would only prove
 * that the mock was written to agree with the test.
 */
export async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminConnectionString() });

  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach Postgres for the test database.\n` +
        `  Start it with:  npm run db:up\n` +
        `  Reason: ${describeUnknownError(error)}`,
      { cause: error },
    );
  }

  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DATABASE_NAME,
    ]);

    if (rowCount === 0) {
      // The database name cannot be a bound parameter in CREATE DATABASE, so it is quoted as an
      // identifier instead. It comes from our own constant, never from user input.
      await admin.query(`CREATE DATABASE ${quoteIdentifier(TEST_DATABASE_NAME)}`);
    }
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });

  try {
    await runMigrations(pool, {
      logger: { info: () => undefined, warn: () => undefined },
    });
  } finally {
    await pool.end();
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
