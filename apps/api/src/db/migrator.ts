import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type pg from 'pg';

import { describeUnknownError } from '../shared/errors.js';

/**
 * A number we picked to name our lock. Postgres advisory locks are just integers with no meaning of
 * their own, so any two processes agreeing on the same number end up waiting for each other. It has
 * to stay fixed forever, which is why it is written here and never generated.
 */
const MIGRATION_LOCK_KEY = 4_071_982_311;

export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface AppliedMigration {
  version: string;
  durationMs: number;
}

export interface MigrationResult {
  applied: AppliedMigration[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Applies every `.sql` file in the migrations folder that has not run yet.
 *
 * Three things make this safe to run whenever you like, including twice at once:
 *
 * 1. It takes a Postgres advisory lock first. If two copies of the app start together, the second
 *    waits for the first to finish rather than both trying to create the same table.
 * 2. Each file runs inside its own transaction, so a file that fails halfway leaves no trace and
 *    can simply be fixed and re-run.
 * 3. Each applied file's contents are hashed and stored. Editing a migration that already ran on
 *    another machine is caught here instead of turning into two databases that quietly disagree.
 */
export async function runMigrations(
  pool: pg.Pool,
  options: { logger: MigrationLogger; directory?: string },
): Promise<MigrationResult> {
  const directory = options.directory ?? join(import.meta.dirname, 'migrations');
  const files = await readMigrationFiles(directory);

  if (files.length === 0) {
    throw new MigrationError(`No .sql migration files found in ${directory}`);
  }

  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  try {
    // Held on this one connection until the finally block. Every other process asking for the same
    // key blocks here rather than racing us.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(client);

    const recorded = await readRecordedMigrations(client);

    for (const file of files) {
      const previous = recorded.get(file.version);

      if (previous) {
        if (previous !== file.checksum) {
          throw new MigrationError(
            `Migration ${file.version} has changed since it was applied. ` +
              'Applied migrations are history and must not be edited. ' +
              'Add a new migration file with the change instead.',
          );
        }
        result.alreadyApplied.push(file.version);
        continue;
      }

      options.logger.info(`Applying ${file.version}`);
      const startedAt = performance.now();

      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.version, file.checksum, Math.round(performance.now() - startedAt)],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(
          `Migration ${file.version} failed and was rolled back: ${describeUnknownError(error)}`,
          { cause: error },
        );
      }

      const durationMs = Math.round(performance.now() - startedAt);
      result.applied.push({ version: file.version, durationMs });
      options.logger.info(`Applied ${file.version} in ${durationMs}ms`);
    }

    return result;
  } finally {
    // Released even if a migration threw, otherwise the next run would hang forever waiting on a
    // lock held by a process that has already gone.
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}

interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  let names: string[];

  try {
    names = await readdir(directory);
  } catch (error) {
    throw new MigrationError(`Cannot read migrations folder ${directory}`, { cause: error });
  }

  // Sorted by name, which is why every file starts with a zero-padded number. Migrations depend on
  // the ones before them, so the order has to be the same on every machine and every run.
  const sqlFiles = names.filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    sqlFiles.map(async (name) => {
      const contents = await readFile(join(directory, name), 'utf8');
      return {
        version: name.replace(/\.sql$/, ''),
        // Line endings are normalised before hashing. Without this, the same file checked out on
        // Windows and on Linux would hash differently and look like it had been tampered with.
        checksum: createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex'),
        sql: contents,
      };
    }),
  );
}

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readRecordedMigrations(client: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}
