import type { AuditLogEntry, ListAuditLogResponse } from '@health/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { writeAuditEntry } from '../src/shared/audit.js';

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

describe('GET /admin/audit-log', () => {
  it('lists entries newest first, with the actor name joined in', async () => {
    const actor = await createUserWithToken(database, 'admin');
    await writeAuditEntry(database.db, {
      actorId: actor.id,
      action: 'doctor_leave_added',
      entityType: 'doctor',
      entityId: actor.id,
      metadata: { leaveDate: '2026-12-25' },
    });
    await writeAuditEntry(database.db, {
      actorId: actor.id,
      action: 'appointment_booked',
      entityType: 'appointment',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit-log',
      headers: authed(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ListAuditLogResponse>();
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.action)).toEqual([
      'appointment_booked',
      'doctor_leave_added',
    ]);
    expect(body.items[1]).toMatchObject({
      action: 'doctor_leave_added',
      actorName: expect.any(String),
      metadata: { leaveDate: '2026-12-25' },
    });
  });

  it('keeps a row with no actor at all, rather than dropping it from a join', async () => {
    await writeAuditEntry(database.db, { action: 'login_failed', entityType: 'auth' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit-log',
      headers: authed(adminToken),
    });

    const body = response.json<ListAuditLogResponse>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ actorId: null, actorName: null });
  });

  it('filters by action', async () => {
    const actor = await createUserWithToken(database, 'admin');
    await writeAuditEntry(database.db, {
      actorId: actor.id,
      action: 'appointment_booked',
      entityType: 'appointment',
    });
    await writeAuditEntry(database.db, {
      actorId: actor.id,
      action: 'appointment_cancelled',
      entityType: 'appointment',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit-log?action=appointment_cancelled',
      headers: authed(adminToken),
    });

    const body = response.json<ListAuditLogResponse>();
    expect(body.items.map((item: AuditLogEntry) => item.action)).toEqual(['appointment_cancelled']);
  });

  it('filters by actorId', async () => {
    const first = await createUserWithToken(database, 'admin');
    const second = await createUserWithToken(database, 'admin');
    await writeAuditEntry(database.db, {
      actorId: first.id,
      action: 'appointment_booked',
      entityType: 'appointment',
    });
    await writeAuditEntry(database.db, {
      actorId: second.id,
      action: 'appointment_booked',
      entityType: 'appointment',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/admin/audit-log?actorId=${first.id}`,
      headers: authed(adminToken),
    });

    const body = response.json<ListAuditLogResponse>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.actorId).toBe(first.id);
  });

  it('paginates and reports the true total, not just the page size', async () => {
    const actor = await createUserWithToken(database, 'admin');
    for (let i = 0; i < 5; i += 1) {
      await writeAuditEntry(database.db, {
        actorId: actor.id,
        action: 'appointment_booked',
        entityType: 'appointment',
      });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit-log?page=2&pageSize=2',
      headers: authed(adminToken),
    });

    const body = response.json<ListAuditLogResponse>();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.page).toBe(2);
  });

  it('blocks a patient with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit-log',
      headers: authed(patientToken),
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/audit-log' });
    expect(response.statusCode).toBe(401);
  });
});
