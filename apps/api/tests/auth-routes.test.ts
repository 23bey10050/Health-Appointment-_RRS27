import type { AuthResponse } from '@health/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { requireAuth, requireRole } from '../src/modules/auth/guards.js';

import { createTestDatabase, resetDatabase } from './helpers/database.js';
import { buildTestServer } from './helpers/test-server.js';

let database: Database;
let app: FastifyInstance;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
  app = await buildTestServer({ db: database });

  // Test-only routes so the real Fastify request/reply lifecycle around the guards - header
  // parsing, decorators, the shared error handler - gets exercised too, not just the guard
  // functions in isolation. Registered here rather than in src/ because nothing in production ever
  // needs an endpoint whose only job is announcing who called it.
  app.get('/test-only/whoami', { preHandler: requireAuth }, (request) => ({
    id: request.user?.id,
    role: request.user?.role,
  }));
  app.get('/test-only/admin-area', { preHandler: requireRole('admin') }, () => ({ ok: true }));
});

afterEach(async () => {
  await app.close();
});

const VALID_PASSWORD = 'a perfectly good passphrase';

function register(overrides: Partial<Record<string, unknown>> = {}) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: 'asha@example.test',
      password: VALID_PASSWORD,
      fullName: 'Asha Verma',
      ...overrides,
    },
  });
}

describe('POST /auth/register', () => {
  it('creates a patient account and signs them straight in', async () => {
    const response = await register();

    expect(response.statusCode).toBe(201);
    const body = response.json<AuthResponse>();
    expect(body.user).toMatchObject({
      email: 'asha@example.test',
      role: 'patient',
      fullName: 'Asha Verma',
    });
    expect(body.tokens.accessToken).toEqual(expect.any(String));
    expect(body.tokens.refreshToken).toEqual(expect.any(String));
  });

  it('ignores any role the client tries to send - everyone who registers is a patient', async () => {
    const response = await register({ role: 'admin' });

    expect(response.statusCode).toBe(201);
    expect(response.json<AuthResponse>().user.role).toBe('patient');
  });

  it('refuses a second account on the same email', async () => {
    await register();
    const response = await register();

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'EMAIL_ALREADY_REGISTERED',
    );
  });

  it('treats an email as the same address regardless of capitalisation', async () => {
    await register({ email: 'Asha@Example.test' });
    const response = await register({ email: 'ASHA@EXAMPLE.TEST' });

    expect(response.statusCode).toBe(409);
  });

  it('rejects a password below the minimum length before touching the database', async () => {
    const response = await register({ password: 'short' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a missing full name', async () => {
    const response = await register({ fullName: '' });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await register();
  });

  it('signs in with the right password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'asha@example.test', password: VALID_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AuthResponse>().user.email).toBe('asha@example.test');
  });

  it('gives the exact same error for a wrong password as for an email that does not exist', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'asha@example.test', password: 'the wrong password entirely' },
    });
    const noSuchAccount = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody-has-this-email@example.test', password: 'anything at all' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchAccount.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_CREDENTIALS' }) }),
    );
    // Not just the same code - the exact same body shape, minus the request id, which is the
    // whole point: nothing in the response can be used to tell the two failures apart.
    const stripId = (body: { error: { requestId: string } }) => {
      const { requestId: _requestId, ...rest } = body.error;
      return rest;
    };
    expect(stripId(wrongPassword.json())).toEqual(stripId(noSuchAccount.json()));
  });
});

describe('POST /auth/refresh', () => {
  async function registerAndGetTokens() {
    const response = await register();
    return response.json<AuthResponse>().tokens;
  }

  it('exchanges a valid refresh token for a new pair of tokens', async () => {
    const tokens = await registerAndGetTokens();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<AuthResponse>();
    // The refresh token must always change - reusing the old one is the whole attack this rotation
    // scheme defends against. The access token is not asserted the same way: it is a JWT signed
    // from the same claims a second apart, so an identical token is not a bug here, just two
    // encodings of the same fact ("this user, this role") arriving within the same clock second.
    expect(body.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(body.tokens.accessToken).toEqual(expect.any(String));
  });

  it('refuses to reuse a refresh token that was already rotated away', async () => {
    const tokens = await registerAndGetTokens();
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });

    const reused = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });

    expect(reused.statusCode).toBe(401);
    expect(reused.json<{ error: { code: string } }>().error.code).toBe('SESSION_REVOKED');
  });

  it('revokes the whole session on reuse, so even the newest token stops working', async () => {
    const original = await registerAndGetTokens();
    const rotatedOnce = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: original.refreshToken },
    });
    const newTokens = rotatedOnce.json<AuthResponse>().tokens;

    // Presenting the old, already-used token again is the attack signal - and it should burn the
    // brand new token too, since we cannot tell which of the two copies belongs to the attacker.
    await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: original.refreshToken },
    });

    const tryNewToken = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: newTokens.refreshToken },
    });

    expect(tryNewToken.statusCode).toBe(401);
    expect(tryNewToken.json<{ error: { code: string } }>().error.code).toBe('SESSION_REVOKED');
  });

  it('lets only one of two simultaneous refreshes of the same token win', async () => {
    const tokens = await registerAndGetTokens();

    // Fired together rather than awaited one at a time, so they genuinely race inside Postgres -
    // this is the same proof shape as the Phase 1 double-booking test, aimed at the row lock in
    // findRefreshTokenForUpdate instead of the appointments exclusion constraint.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: tokens.refreshToken },
      }),
      app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: tokens.refreshToken },
      }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort();
    // The winner gets a fresh pair of tokens; the loser is told its session was revoked, exactly
    // as if a thief had raced the real user - which, from the server's point of view, is what a
    // second simultaneous use of the same refresh token always looks like.
    expect(statusCodes).toEqual([200, 401]);
  });

  it('rejects a refresh token that was never issued', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'this-was-never-issued-by-anyone' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('POST /auth/logout', () => {
  it('accepts the current refresh token and logs it out', async () => {
    const registerResponse = await register();
    const { refreshToken } = registerResponse.json<AuthResponse>().tokens;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ loggedOut: true });
  });

  it('is idempotent - logging out twice, or with a token that never existed, still just succeeds', async () => {
    const registerResponse = await register();
    const { refreshToken } = registerResponse.json<AuthResponse>().tokens;

    await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });
    const second = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    });
    const neverIssued = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'never-issued-at-all' },
    });

    expect(second.statusCode).toBe(200);
    expect(neverIssued.statusCode).toBe(200);
  });

  it('a logged-out token can no longer be refreshed', async () => {
    const registerResponse = await register();
    const { refreshToken } = registerResponse.json<AuthResponse>().tokens;
    await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('role-based access, through the real request lifecycle', () => {
  it('rejects a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/test-only/whoami' });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a real access token and exposes who it belongs to', async () => {
    const registerResponse = await register();
    const { accessToken } = registerResponse.json<AuthResponse>().tokens;

    const response = await app.inject({
      method: 'GET',
      url: '/test-only/whoami',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: 'patient' });
  });

  it('blocks a patient from an admin-only route with 403', async () => {
    const registerResponse = await register();
    const { accessToken } = registerResponse.json<AuthResponse>().tokens;

    const response = await app.inject({
      method: 'GET',
      url: '/test-only/admin-area',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('rate limiting on credential-guessing endpoints', () => {
  it('slows down repeated login attempts from one caller', async () => {
    await register();

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'asha@example.test', password: 'guess number whatever' },
        }),
      ),
    );

    const limited = attempts.filter((response) => response.statusCode === 429);
    // The limit is 8 per 5 minutes; sending 10 at once must trip it, without pinning the test to
    // the exact configured number in case that gets tuned later.
    expect(limited.length).toBeGreaterThan(0);
  });
});
