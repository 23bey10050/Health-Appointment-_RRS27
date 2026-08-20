import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { healthResponseSchema, readinessResponseSchema } from '@health/contracts';

import { buildTestServer, createStubDatabase } from './helpers/test-server.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('reports the process as alive without touching the database', async () => {
    // If this stub is ever called the promise rejects, which is how we prove the liveness probe
    // stays useful during a database outage.
    const unreachableDb = createStubDatabase();
    unreachableDb.ping = () => Promise.reject(new Error('database should not be queried'));

    app = await buildTestServer({ db: unreachableDb });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toMatchObject({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns 200 when the database answers', async () => {
    app = await buildTestServer({ db: createStubDatabase({ ok: true, latencyMs: 4 }) });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(response.json())).toEqual({
      status: 'ok',
      checks: { database: { ok: true, latencyMs: 4 } },
    });
  });

  it('returns 503 and names the problem when the database is down', async () => {
    app = await buildTestServer({
      db: createStubDatabase({ ok: false, error: 'connection refused' }),
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { ok: false, error: 'connection refused' } },
    });
  });
});

describe('unknown routes', () => {
  it('answers with the standard error envelope rather than Fastify default', async () => {
    app = await buildTestServer();

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(body.error.requestId).toEqual(expect.any(String));
  });
});
