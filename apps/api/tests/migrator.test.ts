import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MigrationError, runMigrations } from '../src/db/migrator.js';

import { adminConnectionString } from './helpers/database.js';

/**
 * The migrator gets its own throwaway database.
 *
 * These tests deliberately create tables, tamper with migration files and re-run everything, which
 * is not something to do to the database the other tests are using.
 */
const SANDBOX_DATABASE = 'health_appointment_migrator_test';

let sandboxUrl: string;
let pool: pg.Pool;
let folders: string[] = [];

const silentLogger = { info: () => undefined, warn: () => undefined };

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${SANDBOX_DATABASE}"`);
    await admin.query(`CREATE DATABASE "${SANDBOX_DATABASE}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminConnectionString());
  url.pathname = `/${SANDBOX_DATABASE}`;
  sandboxUrl = url.toString();
  pool = new pg.Pool({ connectionString: sandboxUrl, max: 4 });
});

afterAll(async () => {
  await pool.end();

  const admin = new pg.Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${SANDBOX_DATABASE}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

afterEach(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
  folders = [];
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});

async function migrationFolder(files: Record<string, string>): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'migrations-'));
  folders.push(folder);
  await Promise.all(
    Object.entries(files).map(([name, sql]) => writeFile(join(folder, name), sql, 'utf8')),
  );
  return folder;
}

describe('runMigrations', () => {
  it('applies files in filename order, not the order the filesystem returns them', async () => {
    // Written out of order on purpose. The second file depends on the table the first one creates,
    // so a migrator that trusted directory order would fail here roughly half the time.
    const directory = await migrationFolder({
      '0002_add_column.sql': 'ALTER TABLE widgets ADD COLUMN label TEXT;',
      '0001_create_table.sql': 'CREATE TABLE widgets (id INT PRIMARY KEY);',
    });

    const result = await runMigrations(pool, { logger: silentLogger, directory });

    expect(result.applied.map((entry) => entry.version)).toEqual([
      '0001_create_table',
      '0002_add_column',
    ]);
  });

  it('does nothing on a second run', async () => {
    const directory = await migrationFolder({
      '0001_create_table.sql': 'CREATE TABLE widgets (id INT PRIMARY KEY);',
    });

    await runMigrations(pool, { logger: silentLogger, directory });
    const second = await runMigrations(pool, { logger: silentLogger, directory });

    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toEqual(['0001_create_table']);
  });

  it('refuses to run a migration that was edited after it was applied', async () => {
    const directory = await migrationFolder({
      '0001_create_table.sql': 'CREATE TABLE widgets (id INT PRIMARY KEY);',
    });
    await runMigrations(pool, { logger: silentLogger, directory });

    // Someone "fixes" a migration that already ran on another machine. Left unchecked this is how
    // two environments end up with quietly different schemas.
    await writeFile(
      join(directory, '0001_create_table.sql'),
      'CREATE TABLE widgets (id INT PRIMARY KEY, extra TEXT);',
      'utf8',
    );

    await expect(runMigrations(pool, { logger: silentLogger, directory })).rejects.toThrow(
      MigrationError,
    );
  });

  it('ignores a line-ending change, which is not a real edit', async () => {
    const directory = await migrationFolder({
      '0001_create_table.sql': 'CREATE TABLE widgets (\nid INT PRIMARY KEY\n);',
    });
    await runMigrations(pool, { logger: silentLogger, directory });

    // What a Windows checkout of the very same file looks like.
    await writeFile(
      join(directory, '0001_create_table.sql'),
      'CREATE TABLE widgets (\r\nid INT PRIMARY KEY\r\n);',
      'utf8',
    );

    const second = await runMigrations(pool, { logger: silentLogger, directory });
    expect(second.alreadyApplied).toEqual(['0001_create_table']);
  });

  it('rolls a failed migration back completely', async () => {
    const directory = await migrationFolder({
      // The first statement works, the second is nonsense. Without a transaction the table would
      // survive and the migration would be recorded as neither applied nor clean.
      '0001_broken.sql': 'CREATE TABLE widgets (id INT); SELECT this_function_does_not_exist();',
    });

    await expect(runMigrations(pool, { logger: silentLogger, directory })).rejects.toThrow(
      MigrationError,
    );

    const { rows } = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.widgets') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(false);

    const recorded = await pool.query('SELECT 1 FROM schema_migrations');
    expect(recorded.rowCount).toBe(0);
  });

  it('lets a fixed migration run cleanly after a failure', async () => {
    const directory = await migrationFolder({
      '0001_broken.sql': 'CREATE TABLE widgets (id INT); SELECT this_function_does_not_exist();',
    });
    await expect(runMigrations(pool, { logger: silentLogger, directory })).rejects.toThrow();

    await writeFile(join(directory, '0001_broken.sql'), 'CREATE TABLE widgets (id INT);', 'utf8');

    const result = await runMigrations(pool, { logger: silentLogger, directory });
    expect(result.applied.map((entry) => entry.version)).toEqual(['0001_broken']);
  });

  it('lets only one of two simultaneous runs do the work', async () => {
    const directory = await migrationFolder({
      '0001_create_table.sql': 'CREATE TABLE widgets (id INT PRIMARY KEY);',
    });

    // Two app instances booting together. The advisory lock is what stops both from trying to
    // create the same table and one of them crashing.
    const [first, second] = await Promise.all([
      runMigrations(pool, { logger: silentLogger, directory }),
      runMigrations(pool, { logger: silentLogger, directory }),
    ]);

    const totalApplied = first.applied.length + second.applied.length;
    expect(totalApplied).toBe(1);
  });

  it('says so plainly when the folder holds no migrations', async () => {
    const directory = await migrationFolder({ 'README.txt': 'nothing to see here' });

    await expect(runMigrations(pool, { logger: silentLogger, directory })).rejects.toThrow(
      /No \.sql migration files found/,
    );
  });

  it('says so plainly when the folder does not exist', async () => {
    await expect(
      runMigrations(pool, {
        logger: silentLogger,
        directory: join(tmpdir(), 'nope-does-not-exist'),
      }),
    ).rejects.toThrow(/Cannot read migrations folder/);
  });
});
