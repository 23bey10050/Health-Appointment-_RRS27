import type {
  AvailabilityResponse,
  CreateLeaveResponse,
  Doctor,
  ListDoctorsResponse,
} from '@health/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { appointments, notificationOutbox } from '../src/db/schema.js';
import { signAccessToken } from '../src/modules/auth/tokens.js';

import { createTestDatabase, resetDatabase } from './helpers/database.js';
import {
  addWorkingHours,
  createConfirmedAppointment,
  createDoctor,
  createPatient,
  slotAt,
} from './helpers/fixtures.js';
import { createUserWithToken } from './helpers/roles.js';
import { buildTestConfig, buildTestServer } from './helpers/test-server.js';

let database: Database;
let app: FastifyInstance;
let adminToken: string;
let patientToken: string;
let doctorToken: string;

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
  doctorToken = (await createUserWithToken(database, 'doctor')).token;
});

afterEach(async () => {
  await app.close();
});

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

const newDoctorPayload = {
  email: 'newdoc@clinic.test',
  password: 'a perfectly good passphrase',
  fullName: 'Dr New Comer',
  specialization: 'Pediatrics',
};

describe('admin doctor management, role boundary', () => {
  it.each([
    ['patient', () => patientToken],
    ['doctor', () => doctorToken],
  ])('blocks a %s from creating a doctor, with 403', async (_label, getToken) => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(getToken()),
      payload: newDoctorPayload,
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects an unauthenticated request with 401, before any role check', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      payload: newDoctorPayload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('lets an admin create a doctor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: newDoctorPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Doctor>();
    expect(body).toMatchObject({
      fullName: 'Dr New Comer',
      specialization: 'Pediatrics',
      isActive: true,
    });
    expect(body.workingHours).toEqual([]);
  });
});

describe('GET /admin/doctors', () => {
  it('includes a deactivated doctor - the patient-facing search never would', async () => {
    await createDoctor(database, { specialization: 'Radiology', isActive: false });
    await createDoctor(database, { specialization: 'Radiology' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/doctors?specialization=Radiology',
      headers: authed(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ListDoctorsResponse>();
    expect(body.total).toBe(2);
    expect(body.items.some((item) => !item.isActive)).toBe(true);
  });

  it('blocks a patient and a doctor with 403 - the roster is admin-only', async () => {
    for (const token of [patientToken, doctorToken]) {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/doctors',
        headers: authed(token),
      });
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('POST /admin/doctors validation', () => {
  it('rejects a password below the shared minimum', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: { ...newDoctorPayload, password: 'short' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a missing specialization', async () => {
    const { specialization: _specialization, ...withoutSpecialization } = newDoctorPayload;

    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: withoutSpecialization,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a working hour where the end is not after the start', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: {
        ...newDoctorPayload,
        workingHours: [{ dayOfWeek: 1, startTime: '12:00', endTime: '09:00' }],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a doctor of the week outside 0-6', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: {
        ...newDoctorPayload,
        workingHours: [{ dayOfWeek: 7, startTime: '09:00', endTime: '12:00' }],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a duplicate email with 409, mapped from the database constraint', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: newDoctorPayload,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/doctors',
      headers: authed(adminToken),
      payload: { ...newDoctorPayload, fullName: 'A Different Name' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'EMAIL_ALREADY_REGISTERED',
    );
  });
});

describe('PATCH /admin/doctors/:id', () => {
  it('updates the profile and echoes the current working hours', async () => {
    const doctorId = await createDoctor(database, { specialization: 'General Medicine' });
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    ]);

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/doctors/${doctorId}`,
      headers: authed(adminToken),
      payload: { specialization: 'Endocrinology' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Doctor>();
    expect(body.specialization).toBe('Endocrinology');
    expect(body.workingHours).toHaveLength(1);
  });

  it('404s for a doctor id that does not exist', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/doctors/00000000-0000-4000-8000-00000000ffff',
      headers: authed(adminToken),
      payload: { bio: 'anything' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a body that changes nothing at all', async () => {
    const doctorId = await createDoctor(database);

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/doctors/${doctorId}`,
      headers: authed(adminToken),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('working hours', () => {
  it('adds a shift and then a patient can see it on the doctor detail page', async () => {
    const doctorId = await createDoctor(database);

    const created = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/working-hours`,
      headers: authed(adminToken),
      payload: { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
    });
    expect(created.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/doctors/${doctorId}`,
      headers: authed(patientToken),
    });
    expect(detail.json<Doctor>().workingHours).toHaveLength(1);
  });

  it('409s an overlapping shift', async () => {
    const doctorId = await createDoctor(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/working-hours`,
      headers: authed(adminToken),
      payload: { dayOfWeek: 2, startTime: '11:00', endTime: '14:00' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('WORKING_HOURS_OVERLAP');
  });

  it('deletes a shift, then a second delete of the same id 404s', async () => {
    const doctorId = await createDoctor(database);
    const created = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/working-hours`,
      headers: authed(adminToken),
      payload: { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
    });
    const shiftId = created.json<{ id: string }>().id;

    const first = await app.inject({
      method: 'DELETE',
      url: `/admin/doctors/${doctorId}/working-hours/${shiftId}`,
      headers: authed(adminToken),
    });
    const second = await app.inject({
      method: 'DELETE',
      url: `/admin/doctors/${doctorId}/working-hours/${shiftId}`,
      headers: authed(adminToken),
    });

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(404);
  });

  it('blocks a doctor account from adding a shift - only admins manage schedules', async () => {
    const doctorId = await createDoctor(database);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/working-hours`,
      headers: authed(doctorToken),
      payload: { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('leaves', () => {
  it('marks a leave day, lists it, then removes it', async () => {
    const doctorId = await createDoctor(database);

    const created = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
      payload: { leaveDate: '2026-12-25', reason: 'Holiday' },
    });
    expect(created.statusCode).toBe(201);
    const leaveId = created.json<{ id: string }>().id;

    const list = await app.inject({
      method: 'GET',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
    });
    expect(list.json<unknown[]>()).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/doctors/${doctorId}/leaves/${leaveId}`,
      headers: authed(adminToken),
    });
    expect(deleted.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
    });
    expect(listAfter.json<unknown[]>()).toHaveLength(0);
  });

  it('previews how many confirmed appointments a date would affect, before marking it', async () => {
    const doctorId = await createDoctor(database, { timezone: 'UTC' });
    const patientId = await createPatient(database);
    await createConfirmedAppointment(database, { doctorId, patientId, slot: slotAt(9) });
    await createConfirmedAppointment(database, { doctorId, patientId, slot: slotAt(14) });

    const preview = await app.inject({
      method: 'GET',
      url: `/admin/doctors/${doctorId}/leaves/preview?leaveDate=2026-09-01`,
      headers: authed(adminToken),
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ affectedAppointments: 2 });

    const stillBooked = await database.db
      .select({ status: appointments.status })
      .from(appointments);
    expect(stillBooked.every((row) => row.status === 'confirmed')).toBe(true);
  });

  it('409s a duplicate leave date for the same doctor', async () => {
    const doctorId = await createDoctor(database);
    await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
      payload: { leaveDate: '2026-12-25' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
      payload: { leaveDate: '2026-12-25' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('reports zero cancelled appointments for a leave day with nothing booked on it', async () => {
    const doctorId = await createDoctor(database);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
      payload: { leaveDate: '2026-12-25' },
    });

    expect(response.json<CreateLeaveResponse>().cancelledAppointments).toBe(0);
  });

  it('cancels every confirmed appointment that day, atomically, and reports the count', async () => {
    const doctorId = await createDoctor(database, { timezone: 'UTC' });
    const firstPatient = await createPatient(database);
    const secondPatient = await createPatient(database);
    const firstAppointment = await createConfirmedAppointment(database, {
      doctorId,
      patientId: firstPatient,
      slot: slotAt(9),
    });
    const secondAppointment = await createConfirmedAppointment(database, {
      doctorId,
      patientId: secondPatient,
      slot: slotAt(14),
    });
    // A confirmed appointment the same doctor has on a different day must be left alone.
    const untouchedAppointment = await createConfirmedAppointment(database, {
      doctorId,
      patientId: firstPatient,
      slot: {
        start: new Date('2026-09-02T09:00:00.000Z'),
        end: new Date('2026-09-02T09:20:00.000Z'),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
      payload: { leaveDate: '2026-09-01' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<CreateLeaveResponse>().cancelledAppointments).toBe(2);

    const rows = await database.db
      .select({ id: appointments.id, status: appointments.status })
      .from(appointments);
    const byId = new Map(rows.map((row) => [row.id, row.status]));
    expect(byId.get(firstAppointment)).toBe('cancelled');
    expect(byId.get(secondAppointment)).toBe('cancelled');
    expect(byId.get(untouchedAppointment)).toBe('confirmed');
  });

  it('queues a leave_conflict email and a calendar-delete for both sides, per cancelled appointment', async () => {
    const doctorId = await createDoctor(database, { timezone: 'UTC' });
    const patientId = await createPatient(database);
    const appointmentId = await createConfirmedAppointment(database, {
      doctorId,
      patientId,
      slot: slotAt(9),
    });

    await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
      payload: { leaveDate: '2026-09-01' },
    });

    const rows = await database.db
      .select({
        channel: notificationOutbox.channel,
        type: notificationOutbox.type,
        recipientId: notificationOutbox.recipientId,
      })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, appointmentId));

    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.channel === 'email' && row.type === 'leave_conflict')).toEqual([
      { channel: 'email', type: 'leave_conflict', recipientId: patientId },
    ]);
    const calendarDeletes = rows.filter((row) => row.channel === 'calendar');
    expect(calendarDeletes).toHaveLength(2);
    expect(calendarDeletes.every((row) => row.type === 'cancellation')).toBe(true);
    expect(calendarDeletes.map((row) => row.recipientId).sort()).toEqual(
      [doctorId, patientId].sort(),
    );
  });

  it('a failure anywhere in the transaction leaves zero partial state behind', async () => {
    const doctorId = await createDoctor(database, { timezone: 'UTC' });
    const patientId = await createPatient(database);
    await createConfirmedAppointment(database, { doctorId, patientId, slot: slotAt(9) });
    // A token, correctly signed, for a user id that was never actually created. createdByAdminId
    // ends up as both doctor_leaves.created_by and appointments.cancelled_by - two real foreign
    // keys - so this fails the transaction on a genuine constraint violation, not a mock standing
    // in for one.
    const testConfig = buildTestConfig();
    const impostorAdminToken = signAccessToken(
      { sub: '00000000-0000-4000-8000-999999999999', role: 'admin' },
      {
        secret: testConfig.auth.jwtAccessSecret,
        ttlSeconds: testConfig.auth.accessTokenTtlSeconds,
      },
    ).token;

    const response = await app.inject({
      method: 'POST',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(impostorAdminToken),
      payload: { leaveDate: '2026-09-01' },
    });

    expect(response.statusCode).toBe(500);
    const leaves = await app.inject({
      method: 'GET',
      url: `/admin/doctors/${doctorId}/leaves`,
      headers: authed(adminToken),
    });
    expect(leaves.json<unknown[]>()).toHaveLength(0);
    const [appointment] = await database.db
      .select({ status: appointments.status })
      .from(appointments);
    expect(appointment?.status).toBe('confirmed');
    const outboxRows = await database.db.select().from(notificationOutbox);
    expect(outboxRows).toHaveLength(0);
  });
});

describe('GET /doctors', () => {
  it('is reachable by every role, not just patients', async () => {
    for (const token of [adminToken, patientToken, doctorToken]) {
      const response = await app.inject({ method: 'GET', url: '/doctors', headers: authed(token) });
      expect(response.statusCode).toBe(200);
    }
  });

  it('paginates through the querystring', async () => {
    for (let i = 0; i < 3; i += 1) {
      await createDoctor(database, { specialization: 'Radiology' });
    }

    const response = await app.inject({
      method: 'GET',
      url: '/doctors?specialization=Radiology&page=2&pageSize=2',
      headers: authed(patientToken),
    });

    const body = response.json<ListDoctorsResponse>();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.page).toBe(2);
  });
});

describe('GET /doctors/:id/availability', () => {
  it('returns real slots for a doctor with a working shift', async () => {
    const doctorId = await createDoctor(database, { timezone: 'UTC', slotDurationMins: 30 });
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '10:00' },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/doctors/${doctorId}/availability?from=2026-09-01&to=2026-09-01`,
      headers: authed(patientToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<AvailabilityResponse>();
    expect(body.slots).toEqual([
      { start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:30:00.000Z' },
      { start: '2026-09-01T09:30:00.000Z', end: '2026-09-01T10:00:00.000Z' },
    ]);
  });

  it('rejects a range where "to" comes before "from"', async () => {
    const doctorId = await createDoctor(database);

    const response = await app.inject({
      method: 'GET',
      url: `/doctors/${doctorId}/availability?from=2026-09-05&to=2026-09-01`,
      headers: authed(patientToken),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a range wider than the cap, so the slot engine is never asked to expand years', async () => {
    const doctorId = await createDoctor(database);

    const response = await app.inject({
      method: 'GET',
      url: `/doctors/${doctorId}/availability?from=2026-01-01&to=2026-12-31`,
      headers: authed(patientToken),
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for a doctor id that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/doctors/00000000-0000-4000-8000-00000000ffff/availability?from=2026-09-01&to=2026-09-01',
      headers: authed(patientToken),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('self-service leaves, a doctor managing their own days off', () => {
  async function selfDoctor(): Promise<{ id: string; token: string }> {
    const id = await createDoctor(database, { timezone: 'UTC' });
    const testConfig = buildTestConfig();
    const token = signAccessToken(
      { sub: id, role: 'doctor' },
      {
        secret: testConfig.auth.jwtAccessSecret,
        ttlSeconds: testConfig.auth.accessTokenTtlSeconds,
      },
    ).token;
    return { id, token };
  }

  it('marks, lists, and removes a leave day for the caller own account - no doctor id in the URL at all', async () => {
    const doctor = await selfDoctor();

    const created = await app.inject({
      method: 'POST',
      url: '/doctors/me/leaves',
      headers: authed(doctor.token),
      payload: { leaveDate: '2026-12-25', reason: 'Family time' },
    });
    expect(created.statusCode).toBe(201);
    const leaveId = created.json<{ id: string }>().id;

    const list = await app.inject({
      method: 'GET',
      url: '/doctors/me/leaves',
      headers: authed(doctor.token),
    });
    expect(list.json<unknown[]>()).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/doctors/me/leaves/${leaveId}`,
      headers: authed(doctor.token),
    });
    expect(deleted.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: '/doctors/me/leaves',
      headers: authed(doctor.token),
    });
    expect(listAfter.json<unknown[]>()).toHaveLength(0);
  });

  it('blocks a patient and an admin - this is a doctor own view, not something to manage on their behalf', async () => {
    for (const token of [patientToken, adminToken]) {
      const response = await app.inject({
        method: 'GET',
        url: '/doctors/me/leaves',
        headers: authed(token),
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("never lets one doctor see or delete another doctor's own leave day", async () => {
    const doctorA = await selfDoctor();
    const doctorB = await selfDoctor();
    const created = await app.inject({
      method: 'POST',
      url: '/doctors/me/leaves',
      headers: authed(doctorA.token),
      payload: { leaveDate: '2026-12-25' },
    });
    const leaveId = created.json<{ id: string }>().id;

    const listAsB = await app.inject({
      method: 'GET',
      url: '/doctors/me/leaves',
      headers: authed(doctorB.token),
    });
    const deleteAsB = await app.inject({
      method: 'DELETE',
      url: `/doctors/me/leaves/${leaveId}`,
      headers: authed(doctorB.token),
    });

    expect(listAsB.json<unknown[]>()).toEqual([]);
    expect(deleteAsB.statusCode).toBe(404);
  });

  it('409s marking a date that is already a leave day for this doctor', async () => {
    const doctor = await selfDoctor();
    await app.inject({
      method: 'POST',
      url: '/doctors/me/leaves',
      headers: authed(doctor.token),
      payload: { leaveDate: '2026-12-25' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/doctors/me/leaves',
      headers: authed(doctor.token),
      payload: { leaveDate: '2026-12-25' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('the preview count matches the real cancellation count once the day is actually marked', async () => {
    const doctor = await selfDoctor();
    const patientId = await createPatient(database);
    await createConfirmedAppointment(database, { doctorId: doctor.id, patientId, slot: slotAt(9) });
    await createConfirmedAppointment(database, {
      doctorId: doctor.id,
      patientId,
      slot: slotAt(14),
    });

    const preview = await app.inject({
      method: 'GET',
      url: '/doctors/me/leaves/preview?leaveDate=2026-09-01',
      headers: authed(doctor.token),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ affectedAppointments: number }>().affectedAppointments).toBe(2);

    const stillConfirmed = await database.db
      .select({ status: appointments.status })
      .from(appointments);
    expect(stillConfirmed.every((row) => row.status === 'confirmed')).toBe(true);

    const created = await app.inject({
      method: 'POST',
      url: '/doctors/me/leaves',
      headers: authed(doctor.token),
      payload: { leaveDate: '2026-09-01' },
    });
    expect(created.json<CreateLeaveResponse>().cancelledAppointments).toBe(2);
  });

  it('rejects a preview call with no leaveDate at all', async () => {
    const doctor = await selfDoctor();

    const response = await app.inject({
      method: 'GET',
      url: '/doctors/me/leaves/preview',
      headers: authed(doctor.token),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/doctors/me/leaves' });

    expect(response.statusCode).toBe(401);
  });
});
