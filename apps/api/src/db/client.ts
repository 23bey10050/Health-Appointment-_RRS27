import pg from 'pg';

import type { AppConfig } from '../config/env.js';
import { describeUnknownError } from '../shared/errors.js';

const { Pool } = pg;

export interface DatabasePingResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * The narrow view of the database that the rest of the app is allowed to hold.
 *
 * Routes depend on this interface rather than on a `pg.Pool`, which is what lets a test hand the
 * server a stand-in and check the HTTP layer without starting Postgres.
 */
export interface Database {
  readonly pool: pg.Pool;
  ping(timeoutMs?: number): Promise<DatabasePingResult>;
  close(): Promise<void>;
}

export function createDatabase(config: AppConfig): Database {
  const pool = new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    // Neon hangs up connections that sit unused. Dropping ours a little sooner than it drops
    // theirs means we never hand a query a socket that is already dead on the other end.
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
    // A query that has been running this long is not going to finish usefully, and holding the
    // connection open just starves the next request.
    statement_timeout: 15_000,
    query_timeout: 15_000,
    application_name: 'health-appointment-api',
    ssl: needsTls(config.database.url) ? { rejectUnauthorized: true } : undefined,
  });

  // A pooled connection can die quietly in the background, for example when the database restarts.
  // node-postgres reports that as an error event, and an unhandled one takes the whole process
  // down. Swallowing it here is correct: the pool discards the bad socket and opens a new one on
  // the next query.
  pool.on('error', (error) => {
    process.emitWarning(`Idle database connection dropped: ${describeUnknownError(error)}`);
  });

  return {
    pool,

    async ping(timeoutMs = 3000): Promise<DatabasePingResult> {
      const startedAt = performance.now();
      try {
        await withTimeout(pool.query('SELECT 1'), timeoutMs);
        return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
      } catch (error) {
        return { ok: false, error: describeUnknownError(error) };
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Local Postgres in Docker speaks plain TCP; every hosted provider we use requires TLS. Deciding
 * from the URL keeps one code path for both instead of another environment variable to get wrong.
 */
function needsTls(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'disable') {
      return false;
    }
    return url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Database did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
