import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { googleOauthTokens } from '../../../src/db/schema.js';
import {
  deleteGoogleTokens,
  getValidAccessToken,
  hasGoogleTokens,
  saveGoogleTokens,
} from '../../../src/modules/calendar/tokens.js';
import type { GoogleOAuthConfig, GoogleTokenSet } from '../../../src/providers/google-oauth.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createPatient } from '../../helpers/fixtures.js';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const OAUTH_CONFIG: GoogleOAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:4000/auth/google/callback',
};

let database: Database;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tokenSet(overrides: Partial<GoogleTokenSet> = {}): GoogleTokenSet {
  return {
    accessToken: 'a-real-access-token',
    refreshToken: 'a-real-refresh-token',
    expiresInSeconds: 3600,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('saveGoogleTokens / getValidAccessToken', () => {
  it('stores tokens encrypted, and a still-fresh one is returned with no network call at all', async () => {
    const userId = await createPatient(database);
    await saveGoogleTokens(database, userId, tokenSet(), ENCRYPTION_KEY);

    const [row] = await database.db
      .select()
      .from(googleOauthTokens)
      .where(eq(googleOauthTokens.userId, userId));
    expect(row?.accessTokenEncrypted).not.toContain('a-real-access-token');
    expect(row?.refreshTokenEncrypted).not.toContain('a-real-refresh-token');

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const accessToken = await getValidAccessToken(database, OAUTH_CONFIG, userId, ENCRYPTION_KEY);

    expect(accessToken).toBe('a-real-access-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to save a connection with no refresh token - access_type=offline should always produce one', async () => {
    const userId = await createPatient(database);

    await expect(
      saveGoogleTokens(database, userId, tokenSet({ refreshToken: undefined }), ENCRYPTION_KEY),
    ).rejects.toThrow(/did not return a refresh token/);
  });

  it('returns undefined for a user who has never connected - a normal outcome, not an error', async () => {
    const userId = await createPatient(database);

    await expect(
      getValidAccessToken(database, OAUTH_CONFIG, userId, ENCRYPTION_KEY),
    ).resolves.toBeUndefined();
  });

  it('refreshes an expired token, and persists the new access token and expiry', async () => {
    const userId = await createPatient(database);
    await saveGoogleTokens(database, userId, tokenSet({ expiresInSeconds: -60 }), ENCRYPTION_KEY);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { access_token: 'a-refreshed-token', expires_in: 3600 }),
        ),
    );

    const accessToken = await getValidAccessToken(database, OAUTH_CONFIG, userId, ENCRYPTION_KEY);

    expect(accessToken).toBe('a-refreshed-token');
    const [row] = await database.db
      .select()
      .from(googleOauthTokens)
      .where(eq(googleOauthTokens.userId, userId));
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The refresh token itself is untouched by a refresh - only exchange ever sets it.
    expect(row?.refreshTokenEncrypted).not.toContain('a-refreshed-token');
  });

  it('surfaces a revoked grant as a real, clearly worded error rather than a silent skip', async () => {
    const userId = await createPatient(database);
    await saveGoogleTokens(database, userId, tokenSet({ expiresInSeconds: -60 }), ENCRYPTION_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' })),
    );

    await expect(
      getValidAccessToken(database, OAUTH_CONFIG, userId, ENCRYPTION_KEY),
    ).rejects.toThrow(/revoked or has expired/);
  });
});

describe('hasGoogleTokens', () => {
  it('is false before connecting and true after', async () => {
    const userId = await createPatient(database);

    expect(await hasGoogleTokens(database, userId)).toBe(false);

    await saveGoogleTokens(database, userId, tokenSet(), ENCRYPTION_KEY);
    expect(await hasGoogleTokens(database, userId)).toBe(true);
  });
});

describe('deleteGoogleTokens', () => {
  it('removes the row and hands back the still-decryptable access token for a best-effort revoke', async () => {
    const userId = await createPatient(database);
    await saveGoogleTokens(database, userId, tokenSet(), ENCRYPTION_KEY);

    const accessToken = await deleteGoogleTokens(database, userId, ENCRYPTION_KEY);

    expect(accessToken).toBe('a-real-access-token');
    expect(await hasGoogleTokens(database, userId)).toBe(false);
  });

  it('returns undefined for a user who was never connected, without erroring', async () => {
    const userId = await createPatient(database);

    await expect(deleteGoogleTokens(database, userId, ENCRYPTION_KEY)).resolves.toBeUndefined();
  });
});
