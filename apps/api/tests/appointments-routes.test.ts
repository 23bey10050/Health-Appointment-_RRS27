import type { Appointment, HoldResponse } from '@health/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';

import { createTestDatabase, resetDatabase } from './helpers/database.js';
import { addWorkingHours, createDoctor } from './helpers/fixtures.js';
import { createUserWithToken } from './helpers/roles.js';
import { buildTestServer } from './helpers/test-server.js';

let database: Database;
let app: FastifyInstance;
let patient: { id: string; token: string };
let secondPatient: { id: string; token: string };
let doctorToken: string;
let adminToken: string;
let doctorId: string;

// 2026-09-01 is a Tuesday (Postgres EXTRACT(DOW ...) = 2), the same fixed date the availability
// and service-level booking suites already confirmed against the running database.
const SLOT_START = '2026-09-01T09:00:00.000Z';

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
  app = await buildTestServer({ db: database });

  patient = await createUserWithToken(database, 'patient');
  secondPatient = await createUserWithToken(database, 'patient');
  doctorToken = (await createUserWithToken(database, 'doctor')).token;
  adminToken = (await createUserWithToken(database, 'admin')).token;

  doctorId = await createDoctor(database, { timezone: 'UTC', slotDurationMins: 20 });
  await addWorkingHours(database, doctorId, [
    { dayOfWeek: 2, startTime: '09:00', endTime: '10:00' },
  ]);
});

afterEach(async () => {
  await app.close();
});

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function holdTheSlot(token: string, start = SLOT_START) {
  return app.inject({
    method: 'POST',
    url: '/appointments/hold',
    headers: authed(token),
    payload: { doctorId, start },
  });
}

describe('POST /appointments/hold', () => {
  it('holds a real available slot for a patient', async () => {
    const response = await holdTheSlot(patient.token);

    expect(response.statusCode).toBe(201);
    const body = response.json<HoldResponse>();
    expect(body).toMatchObject({ doctorId, start: SLOT_START });
    expect(body.holdId).toEqual(expect.any(String));
  });

  it('blocks a doctor account - only patients book for themselves', async () => {
    const response = await holdTheSlot(doctorToken);
    expect(response.statusCode).toBe(403);
  });

  it('blocks an admin too - booking core is a patient action', async () => {
    const response = await holdTheSlot(adminToken);
    expect(response.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/appointments/hold',
      payload: { doctorId, start: SLOT_START },
    });
    expect(response.statusCode).toBe(401);
  });

  it('409s a slot someone else already holds', async () => {
    await holdTheSlot(patient.token);

    const response = await holdTheSlot(secondPatient.token);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('404s a doctor id that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/appointments/hold',
      headers: authed(patient.token),
      payload: { doctorId: '00000000-0000-4000-8000-00000000ffff', start: SLOT_START },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a start value more than the booking horizon out', async () => {
    const farFuture = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();

    const response = await holdTheSlot(patient.token, farFuture);

    expect(response.statusCode).toBe(400);
  });

  it('lets only one of twenty simultaneous holds on the same slot win', async () => {
    // This is the concurrency proof the plan asks for at the HTTP layer: not just that the
    // exclusion constraint rejects a second insert (Phase 1 already proved that directly against
    // Postgres), but that the whole hold endpoint, exercised the way twenty real patients tapping
    // "book" at once would exercise it, produces exactly one winner and nineteen clean 409s - never
    // a 500, never two winners.
    const patients = await Promise.all(
      Array.from({ length: 20 }, () => createUserWithToken(database, 'patient')),
    );

    const responses = await Promise.all(patients.map((p) => holdTheSlot(p.token)));

    const succeeded = responses.filter((response) => response.statusCode === 201);
    const conflicted = responses.filter((response) => response.statusCode === 409);

    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(19);
    for (const response of conflicted) {
      expect(response.json<{ error: { code: string } }>().error.code).toBe('SLOT_UNAVAILABLE');
    }
  });
});

describe('POST /appointments/:holdId/confirm', () => {
  it('books the appointment and returns it with names attached', async () => {
    const hold = (await holdTheSlot(patient.token)).json<HoldResponse>();

    const response = await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(patient.token),
      payload: { symptoms: 'Persistent headache for three days, worse in the mornings.' },
    });

    expect(response.statusCode).toBe(201);
    const appointment = response.json<Appointment>();
    expect(appointment.status).toBe('confirmed');
    expect(appointment.doctorId).toBe(doctorId);
    expect(appointment.patientId).toBe(patient.id);
  });

  it('rejects symptoms that are too short to be a real description', async () => {
    const hold = (await holdTheSlot(patient.token)).json<HoldResponse>();

    const response = await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(patient.token),
      payload: { symptoms: 'no' },
    });

    expect(response.statusCode).toBe(400);
  });

  it("404s when a different patient tries to confirm someone else's hold", async () => {
    const hold = (await holdTheSlot(patient.token)).json<HoldResponse>();

    const response = await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(secondPatient.token),
      payload: { symptoms: 'trying to steal this slot from someone else' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('a confirmed hold cannot be confirmed again', async () => {
    const hold = (await holdTheSlot(patient.token)).json<HoldResponse>();
    await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(patient.token),
      payload: { symptoms: 'the first, successful confirmation' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(patient.token),
      payload: { symptoms: 'trying again after it already went through' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /appointments/mine and /appointments/:id', () => {
  async function bookOne(): Promise<Appointment> {
    const hold = (await holdTheSlot(patient.token)).json<HoldResponse>();
    const response = await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(patient.token),
      payload: { symptoms: 'A routine checkup for an ongoing condition.' },
    });
    return response.json<Appointment>();
  }

  it("lists only the caller's own appointments", async () => {
    await bookOne();

    const response = await app.inject({
      method: 'GET',
      url: '/appointments/mine',
      headers: authed(secondPatient.token),
    });

    expect(response.json<Appointment[]>()).toEqual([]);
  });

  it('a doctor account cannot call /appointments/mine at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/appointments/mine',
      headers: authed(doctorToken),
    });
    expect(response.statusCode).toBe(403);
  });

  it('the owner can fetch it by id, a stranger gets 404, an admin can too', async () => {
    const appointment = await bookOne();

    const asOwner = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: authed(patient.token),
    });
    const asStranger = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: authed(secondPatient.token),
    });
    const asAdmin = await app.inject({
      method: 'GET',
      url: `/appointments/${appointment.id}`,
      headers: authed(adminToken),
    });

    expect(asOwner.statusCode).toBe(200);
    expect(asStranger.statusCode).toBe(404);
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe('DELETE /appointments/:id', () => {
  async function bookOne(): Promise<Appointment> {
    const hold = (await holdTheSlot(patient.token)).json<HoldResponse>();
    const response = await app.inject({
      method: 'POST',
      url: `/appointments/${hold.holdId}/confirm`,
      headers: authed(patient.token),
      payload: { symptoms: 'A routine checkup for an ongoing condition.' },
    });
    return response.json<Appointment>();
  }

  it('cancels, and the freed slot can be held by someone else right away', async () => {
    const appointment = await bookOne();

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/appointments/${appointment.id}`,
      headers: authed(patient.token),
      payload: { reason: 'Feeling better, no longer needed' },
    });
    const rebooked = await holdTheSlot(secondPatient.token);

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<Appointment>().status).toBe('cancelled');
    expect(rebooked.statusCode).toBe(201);
  });

  it('works with no body at all - a reason is optional', async () => {
    const appointment = await bookOne();

    const response = await app.inject({
      method: 'DELETE',
      url: `/appointments/${appointment.id}`,
      headers: authed(patient.token),
    });

    expect(response.statusCode).toBe(200);
  });

  it('409s cancelling something already cancelled', async () => {
    const appointment = await bookOne();
    await app.inject({
      method: 'DELETE',
      url: `/appointments/${appointment.id}`,
      headers: authed(patient.token),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/appointments/${appointment.id}`,
      headers: authed(patient.token),
    });

    expect(response.statusCode).toBe(409);
  });

  it('a stranger gets 404, not a hint that the appointment exists', async () => {
    const appointment = await bookOne();

    const response = await app.inject({
      method: 'DELETE',
      url: `/appointments/${appointment.id}`,
      headers: authed(secondPatient.token),
    });

    expect(response.statusCode).toBe(404);
  });
});
