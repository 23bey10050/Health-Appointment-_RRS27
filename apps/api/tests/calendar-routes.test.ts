import type { GoogleConnectUrlResponse } from '@health/contracts';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/client.js';
import { hasGoogleTokens } from '../src/modules/calendar/tokens.js';

import { createTestDatabase, resetDatabase } from './helpers/database.js';
import { createUserWithToken } from './helpers/roles.js';
import { buildTestServer } from './helpers/test-server.js';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:4000/auth/google/callback',
  GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let database: Database;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('when Google Calendar sync is not configured at all', () => {
  let app: FastifyInstance;
  let patient: { id: string; token: string };

  beforeEach(async () => {
    await resetDatabase(database);
    app = await buildTestServer({ db: database });
    patient = await createUserWithToken(database, 'patient');
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /connect answers 503 rather than crashing on a missing client id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/connect',
      headers: { authorization: `Bearer ${patient.token}` },
    });

    expect(response.statusCode).toBe(503);
  });

  it('GET /status still works - reporting not connected is always meaningful, configured or not', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/status',
      headers: { authorization: `Bearer ${patient.token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ connected: false });
  });
});

describe('when Google Calendar sync is configured', () => {
  let app: FastifyInstance;
  let patient: { id: string; token: string };

  beforeEach(async () => {
    await resetDatabase(database);
    app = await buildTestServer({ db: database, env: GOOGLE_ENV });
    patient = await createUserWithToken(database, 'patient');
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /connect requires a signed-in caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/google/connect' });

    expect(response.statusCode).toBe(401);
  });

  it('GET /connect returns a real-looking Google consent URL for a signed-in caller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/connect',
      headers: { authorization: `Bearer ${patient.token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<GoogleConnectUrlResponse>();
    expect(new URL(body.url).hostname).toBe('accounts.google.com');
  });

  it('GET /callback with no code or state shows a plain HTML cancellation page', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/google/callback' });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('cancelled');
  });

  it('GET /callback with a forged state shows a plain HTML failure page, not a raw JSON error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=abc&state=not-a-real-state',
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('a real connect-then-callback round trip stores the connection', async () => {
    const connectResponse = await app.inject({
      method: 'GET',
      url: '/auth/google/connect',
      headers: { authorization: `Bearer ${patient.token}` },
    });
    const state = new URL(connectResponse.json<GoogleConnectUrlResponse>().url).searchParams.get('state');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'a-real-access-token',
          refresh_token: 'a-real-refresh-token',
          expires_in: 3600,
          scope: 'calendar.events',
        }),
      ),
    );

    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=a-real-code&state=${state}`,
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.body).toContain('connected');
    expect(await hasGoogleTokens(database, patient.id)).toBe(true);
  });

  it('status flips to connected after connecting, and disconnect flips it back', async () => {
    const connectResponse = await app.inject({
      method: 'GET',
      url: '/auth/google/connect',
      headers: { authorization: `Bearer ${patient.token}` },
    });
    const state = new URL(connectResponse.json<GoogleConnectUrlResponse>().url).searchParams.get('state');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'token',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'calendar.events',
        }),
      ),
    );
    await app.inject({ method: 'GET', url: `/auth/google/callback?code=a-code&state=${state}` });

    const connectedStatus = await app.inject({
      method: 'GET',
      url: '/auth/google/status',
      headers: { authorization: `Bearer ${patient.token}` },
    });
    expect(connectedStatus.json()).toEqual({ connected: true });

    const disconnectResponse = await app.inject({
      method: 'POST',
      url: '/auth/google/disconnect',
      headers: { authorization: `Bearer ${patient.token}` },
    });
    expect(disconnectResponse.statusCode).toBe(200);
    expect(disconnectResponse.json()).toEqual({ disconnected: true });

    const finalStatus = await app.inject({
      method: 'GET',
      url: '/auth/google/status',
      headers: { authorization: `Bearer ${patient.token}` },
    });
    expect(finalStatus.json()).toEqual({ connected: false });
  });
});
