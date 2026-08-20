import type { DeadLetterNotification } from '@health/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { notificationOutbox } from '../src/db/schema.js';
import { queueNotification } from '../src/shared/outbox.js';

import { createTestDatabase, resetDatabase } from './helpers/database.js';
import { createUserWithToken } from './helpers/roles.js';
import { buildTestServer } from './helpers/test-server.js';

let database: Database;
let app: FastifyInstance;
let adminToken: string;
let patientToken: string;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
  app = await buildTestServer({ db: database });
  adminToken = (await createUserWithToken(database, 'admin')).token;
  patientToken = (await createUserWithToken(database, 'patient')).token;
});

afterEach(async () => {
  await app.close();
});

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createDeadLetter(): Promise<string> {
  const patient = await createUserWithToken(database, 'patient');
  await queueNotification(database.db, {
    recipientId: patient.id,
    channel: 'email',
    type: 'booking_confirmation',
    payload: {},
  });
  const [row] = await database.db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.recipientId, patient.id));
  if (!row) throw new Error('fixture insert failed');

  await database.db
    .update(notificationOutbox)
    .set({ status: 'dead_letter', attempts: 5, lastError: 'gave up after 5 tries' })
    .where(eq(notificationOutbox.id, row.id));

  return row.id;
}

describe('GET /admin/notifications/dead-letter', () => {
  it('lists dead-lettered notifications for an admin', async () => {
    const id = await createDeadLetter();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/notifications/dead-letter',
      headers: authed(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<DeadLetterNotification[]>();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id, attempts: 5, lastError: 'gave up after 5 tries' });
  });

  it('blocks a patient with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/notifications/dead-letter',
      headers: authed(patientToken),
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/notifications/dead-letter' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/notifications/:id/retry', () => {
  it('resets a dead-lettered notification back to queued', async () => {
    const id = await createDeadLetter();

    const response = await app.inject({
      method: 'POST',
      url: `/admin/notifications/${id}/retry`,
      headers: authed(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ retried: true });

    const listAfter = await app.inject({
      method: 'GET',
      url: '/admin/notifications/dead-letter',
      headers: authed(adminToken),
    });
    expect(listAfter.json<DeadLetterNotification[]>()).toEqual([]);
  });

  it('404s for an id that was never dead-lettered', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/notifications/00000000-0000-4000-8000-00000000ffff/retry',
      headers: authed(adminToken),
    });
    expect(response.statusCode).toBe(404);
  });

  it('blocks a patient with 403', async () => {
    const id = await createDeadLetter();

    const response = await app.inject({
      method: 'POST',
      url: `/admin/notifications/${id}/retry`,
      headers: authed(patientToken),
    });
    expect(response.statusCode).toBe(403);
  });
});
