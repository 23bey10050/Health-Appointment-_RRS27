import type { FastifyInstance } from 'fastify';

import { loadConfig, type AppConfig } from '../../src/config/env.js';
import type { Database, DatabasePingResult } from '../../src/db/client.js';
import { buildServer } from '../../src/server.js';

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://health:health@localhost:5432/health_appointment_test',
  CORS_ORIGINS: 'http://localhost:5173',
} satisfies NodeJS.ProcessEnv;

export function buildTestConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

/**
 * A database that answers whatever the test tells it to.
 *
 * The HTTP layer only ever asks the database two things at this stage, so a stand-in is enough to
 * cover both the happy path and the outage path. Tests that need real SQL behaviour — the
 * double-booking constraint above all — will use a real Postgres instead; faking that one would
 * be testing nothing.
 */
export function createStubDatabase(
  ping: DatabasePingResult = { ok: true, latencyMs: 1 },
): Database {
  return {
    pool: undefined as unknown as Database['pool'],
    ping: () => Promise.resolve(ping),
    close: () => Promise.resolve(),
  };
}

export async function buildTestServer(
  options: { db?: Database; env?: NodeJS.ProcessEnv } = {},
): Promise<FastifyInstance> {
  return buildServer({
    config: buildTestConfig(options.env),
    db: options.db ?? createStubDatabase(),
  });
}
