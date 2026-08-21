import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import {
  buildConnectUrl,
  completeConnection,
  disconnect,
  getConnectionStatus,
} from '../../../src/modules/calendar/oauth-service.js';
import { signOAuthState } from '../../../src/modules/calendar/state-token.js';
import { hasGoogleTokens } from '../../../src/modules/calendar/tokens.js';
import type { GoogleOAuthConfig } from '../../../src/providers/google-oauth.js';
import { ForbiddenError } from '../../../src/shared/errors.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createPatient } from '../../helpers/fixtures.js';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const STATE_SECRET = 'a-secret-at-least-thirty-two-characters';
const OAUTH_CONFIG: GoogleOAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:4000/auth/google/callback',
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

beforeEach(async () => {
  await resetDatabase(database);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildConnectUrl', () => {
  it('produces a Google consent URL carrying a state signed for this user', () => {
    const url = new URL(buildConnectUrl(OAUTH_CONFIG, STATE_SECRET, 'user-123'));

    expect(url.hostname).toBe('accounts.google.com');
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
  });
});

describe('completeConnection', () => {
  it('exchanges the code and stores the tokens once the state checks out', async () => {
    const userId = await createPatient(database);
    const state = signOAuthState(userId, STATE_SECRET);
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

    await completeConnection(database, OAUTH_CONFIG, ENCRYPTION_KEY, STATE_SECRET, 'a-code', state);

    expect(await hasGoogleTokens(database, userId)).toBe(true);
  });

  it('refuses a forged or expired state with a ForbiddenError, before ever calling Google', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      completeConnection(
        database,
        OAUTH_CONFIG,
        ENCRYPTION_KEY,
        STATE_SECRET,
        'a-code',
        'not-a-real-state',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getConnectionStatus', () => {
  it('reports connected only after a real connection exists', async () => {
    const userId = await createPatient(database);

    expect(await getConnectionStatus(database, userId)).toEqual({ connected: false });

    const state = signOAuthState(userId, STATE_SECRET);
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
    await completeConnection(database, OAUTH_CONFIG, ENCRYPTION_KEY, STATE_SECRET, 'a-code', state);

    expect(await getConnectionStatus(database, userId)).toEqual({ connected: true });
  });
});

describe('disconnect', () => {
  it('deletes the local connection even when the best-effort revoke at Google fails', async () => {
    const userId = await createPatient(database);
    const state = signOAuthState(userId, STATE_SECRET);
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
    await completeConnection(database, OAUTH_CONFIG, ENCRYPTION_KEY, STATE_SECRET, 'a-code', state);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await disconnect(database, userId, ENCRYPTION_KEY);

    expect(await hasGoogleTokens(database, userId)).toBe(false);
  });

  it('is a harmless no-op for a user who was never connected', async () => {
    const userId = await createPatient(database);

    await expect(disconnect(database, userId, ENCRYPTION_KEY)).resolves.toBeUndefined();
  });
});
