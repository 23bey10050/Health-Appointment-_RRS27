import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildTestServer } from './helpers/test-server.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /openapi.json', () => {
  it('serves a real OpenAPI document generated from the route schemas, not a stale hand-written one', async () => {
    app = await buildTestServer();

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(body.openapi).toMatch(/^3\./);
    // A handful of routes from different modules - proof this covers the whole API, not just
    // whichever plugin happened to register first.
    expect(Object.keys(body.paths)).toEqual(
      expect.arrayContaining(['/health', '/auth/login', '/appointments/hold', '/admin/audit-log/']),
    );
  });

  it('needs no authentication - the document itself is not a secret', async () => {
    app = await buildTestServer();

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
  });
});
