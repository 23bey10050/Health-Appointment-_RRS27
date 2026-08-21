import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../../src/config/env.js';
import type { Database } from '../../../src/db/client.js';
import {
  buildCalendarSync,
  eventIdFor,
  GoogleCalendarSync,
  NoopCalendarSync,
} from '../../../src/modules/calendar/sync.js';
import { saveGoogleTokens } from '../../../src/modules/calendar/tokens.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createPatient } from '../../helpers/fixtures.js';
import { buildTestConfig } from '../../helpers/test-server.js';

const ENCRYPTION_KEY = randomBytes(32).toString('base64');

const event = {
  appointmentId: '11111111-2222-3333-4444-555555555555',
  summary: 'Appointment with Dr Anand Mehta',
  description: 'Cardiology appointment.',
  start: new Date('2026-09-01T03:30:00.000Z'),
  end: new Date('2026-09-01T03:50:00.000Z'),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('eventIdFor', () => {
  it('strips the hyphens, leaving only the lowercase hex characters Google requires', () => {
    expect(eventIdFor('11111111-2222-3333-4444-555555555555')).toBe(
      '11111111222233334444555555555555',
    );
  });

  it('is deterministic - the same appointment always produces the same id', () => {
    expect(eventIdFor(event.appointmentId)).toBe(eventIdFor(event.appointmentId));
  });
});

describe('NoopCalendarSync', () => {
  it('never creates a real event and never throws on delete', async () => {
    const sync = new NoopCalendarSync();

    await expect(sync.upsertEvent('some-user', event)).resolves.toBeUndefined();
    await expect(sync.deleteEvent('some-user', 'some-event-id')).resolves.toBeUndefined();
  });
});

describe('buildCalendarSync', () => {
  function configWith(google: Partial<AppConfig['google']>): AppConfig {
    return {
      ...buildTestConfig(),
      google: {
        clientId: undefined,
        clientSecret: undefined,
        redirectUri: undefined,
        tokenEncryptionKey: undefined,
        ...google,
      },
    };
  }

  it('builds a NoopCalendarSync when nothing is configured', () => {
    const database = {} as Database;
    expect(buildCalendarSync(database, configWith({}))).toBeInstanceOf(NoopCalendarSync);
  });

  it('builds a NoopCalendarSync when only some of the four values are set', () => {
    const database = {} as Database;
    expect(
      buildCalendarSync(database, configWith({ clientId: 'id', clientSecret: 'secret' })),
    ).toBeInstanceOf(NoopCalendarSync);
  });

  it('builds a real GoogleCalendarSync once all four are set', () => {
    const database = {} as Database;
    expect(
      buildCalendarSync(
        database,
        configWith({
          clientId: 'id',
          clientSecret: 'secret',
          redirectUri: 'http://localhost:4000/auth/google/callback',
          tokenEncryptionKey: ENCRYPTION_KEY,
        }),
      ),
    ).toBeInstanceOf(GoogleCalendarSync);
  });
});

describe('GoogleCalendarSync', () => {
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

  const oauthConfig = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'http://localhost:4000/auth/google/callback',
  };

  it('returns undefined, not an error, for a user who has never connected', async () => {
    const sync = new GoogleCalendarSync(database, oauthConfig, ENCRYPTION_KEY);
    const userId = await createPatient(database);

    await expect(sync.upsertEvent(userId, event)).resolves.toBeUndefined();
  });

  it('creates the event once the user has connected, using the deterministic appointment-derived id', async () => {
    const sync = new GoogleCalendarSync(database, oauthConfig, ENCRYPTION_KEY);
    const userId = await createPatient(database);
    await saveGoogleTokens(
      database,
      userId,
      {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresInSeconds: 3600,
        scope: 'calendar.events',
      },
      ENCRYPTION_KEY,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: eventIdFor(event.appointmentId) }));
    vi.stubGlobal('fetch', fetchMock);

    const eventId = await sync.upsertEvent(userId, event);

    expect(eventId).toBe(eventIdFor(event.appointmentId));
  });

  it('deletes nothing and does not throw for a user who has never connected', async () => {
    const sync = new GoogleCalendarSync(database, oauthConfig, ENCRYPTION_KEY);
    const userId = await createPatient(database);

    await expect(sync.deleteEvent(userId, 'some-event-id')).resolves.toBeUndefined();
  });
});
