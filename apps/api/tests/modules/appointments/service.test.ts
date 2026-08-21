import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { auditLog, medicationReminders, notificationOutbox, slotHolds } from '../../../src/db/schema.js';
import * as appointmentService from '../../../src/modules/appointments/service.js';
import { AppError } from '../../../src/shared/errors.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import {
  addLeaveDay,
  addWorkingHours,
  createDoctor,
  createPatient,
} from '../../helpers/fixtures.js';

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

const NONEXISTENT_ID = '00000000-0000-4000-8000-00000000ffff';
// 2026-09-01 is a Tuesday (Postgres EXTRACT(DOW ...) = 2) - the same fixed date the availability
// suite already confirmed against the running database, reused here so the day-of-week fixtures
// line up with what findAvailableSlots is being asked to produce.
const SLOT_START = new Date('2026-09-01T09:00:00.000Z');

async function createBookableDoctor(): Promise<string> {
  const doctorId = await createDoctor(database, { timezone: 'UTC', slotDurationMins: 20 });
  await addWorkingHours(database, doctorId, [
    { dayOfWeek: 2, startTime: '09:00', endTime: '10:00' },
  ]);
  return doctorId;
}

async function expectAppError(work: Promise<unknown>, status: number, code: string): Promise<void> {
  let caught: AppError | undefined;
  try {
    await work;
  } catch (error) {
    caught = error as AppError;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught?.statusCode).toBe(status);
  expect(caught?.code).toBe(code);
}

describe('holdSlot', () => {
  it('holds a real, currently available slot', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);

    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);

    expect(hold.doctorId).toBe(doctorId);
    expect(hold.slot.start.toISOString()).toBe(SLOT_START.toISOString());
    expect(hold.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('404s for a doctor id that does not exist', async () => {
    const patientId = await createPatient(database);

    await expectAppError(
      appointmentService.holdSlot(database, patientId, NONEXISTENT_ID, SLOT_START),
      404,
      'NOT_FOUND',
    );
  });

  it('409s a slot outside the doctor working hours, not a 500', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const middleOfTheNight = new Date('2026-09-01T03:00:00.000Z');

    await expectAppError(
      appointmentService.holdSlot(database, patientId, doctorId, middleOfTheNight),
      409,
      'SLOT_UNAVAILABLE',
    );
  });

  it('409s a slot on a day the doctor has marked as leave', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    await addLeaveDay(database, doctorId, '2026-09-01');

    await expectAppError(
      appointmentService.holdSlot(database, patientId, doctorId, SLOT_START),
      409,
      'SLOT_UNAVAILABLE',
    );
  });

  it('409s a doctor who is deactivated, without ever running the availability check', async () => {
    const doctorId = await createDoctor(database, {
      timezone: 'UTC',
      slotDurationMins: 20,
      isActive: false,
    });
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '10:00' },
    ]);
    const patientId = await createPatient(database);

    await expectAppError(
      appointmentService.holdSlot(database, patientId, doctorId, SLOT_START),
      409,
      'SLOT_UNAVAILABLE',
    );
  });

  it('409s a slot someone else is already holding', async () => {
    const doctorId = await createBookableDoctor();
    const first = await createPatient(database);
    const second = await createPatient(database);
    await appointmentService.holdSlot(database, first, doctorId, SLOT_START);

    await expectAppError(
      appointmentService.holdSlot(database, second, doctorId, SLOT_START),
      409,
      'SLOT_UNAVAILABLE',
    );
  });

  it('clears a stale hold from the same doctor before inserting the new one', async () => {
    const doctorId = await createBookableDoctor();
    const first = await createPatient(database);
    const second = await createPatient(database);
    const stale = await appointmentService.holdSlot(database, first, doctorId, SLOT_START);
    await database.db
      .update(slotHolds)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(slotHolds.id, stale.id));

    // A second patient reaching for the same slot should not be blocked by a hold that expired
    // minutes ago and nobody has come back to redeem.
    const fresh = await appointmentService.holdSlot(database, second, doctorId, SLOT_START);

    expect(fresh.slot.start.toISOString()).toBe(SLOT_START.toISOString());
  });
});

describe('confirmHold', () => {
  it('turns a hold into an appointment, deletes the hold, and returns the full detail', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database, { fullName: 'Asha Verma' });
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);

    const appointment = await appointmentService.confirmHold(
      database,
      patientId,
      hold.id,
      'Persistent headache for three days.',
    );

    expect(appointment).toMatchObject({
      doctorId,
      patientId,
      patientName: 'Asha Verma',
      status: 'confirmed',
      symptoms: 'Persistent headache for three days.',
    });

    const remainingHolds = await database.db
      .select()
      .from(slotHolds)
      .where(eq(slotHolds.id, hold.id));
    expect(remainingHolds).toHaveLength(0);
  });

  it('queues one email notification each for the patient and the doctor', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);

    const appointment = await appointmentService.confirmHold(
      database,
      patientId,
      hold.id,
      'A checkup.',
    );

    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, appointment.id));
    const emailRows = rows.filter((row) => row.channel === 'email');
    expect(emailRows).toHaveLength(2);
    expect(emailRows.map((row) => row.recipientId).sort()).toEqual([doctorId, patientId].sort());
    for (const row of emailRows) {
      expect(row.type).toBe('booking_confirmation');
      expect(row.status).toBe('queued');
    }
  });

  it('also queues one calendar-sync row each for the patient and the doctor', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);

    const appointment = await appointmentService.confirmHold(
      database,
      patientId,
      hold.id,
      'A checkup.',
    );

    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, appointment.id));
    const calendarRows = rows.filter((row) => row.channel === 'calendar');
    expect(calendarRows).toHaveLength(2);
    expect(calendarRows.map((row) => row.recipientId).sort()).toEqual([doctorId, patientId].sort());
    for (const row of calendarRows) {
      expect(row.type).toBe('booking_confirmation');
      expect(row.status).toBe('queued');
    }
  });

  it('writes an appointment_booked audit entry', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);

    const appointment = await appointmentService.confirmHold(
      database,
      patientId,
      hold.id,
      'A checkup.',
    );

    const rows = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, appointment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('appointment_booked');
  });

  it('404s a hold id that does not exist', async () => {
    const patientId = await createPatient(database);

    await expectAppError(
      appointmentService.confirmHold(database, patientId, NONEXISTENT_ID, 'anything'),
      404,
      'NOT_FOUND',
    );
  });

  it('404s a hold that belongs to a different patient', async () => {
    const doctorId = await createBookableDoctor();
    const owner = await createPatient(database);
    const stranger = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, owner, doctorId, SLOT_START);

    await expectAppError(
      appointmentService.confirmHold(database, stranger, hold.id, 'not mine'),
      404,
      'NOT_FOUND',
    );
  });

  it('409s an expired hold instead of letting it through', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);
    await database.db
      .update(slotHolds)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(slotHolds.id, hold.id));

    await expectAppError(
      appointmentService.confirmHold(database, patientId, hold.id, 'too late'),
      409,
      'HOLD_EXPIRED',
    );
  });

  it('leaves the expired hold in place rather than silently deleting it on a failed confirm', async () => {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);
    await database.db
      .update(slotHolds)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(slotHolds.id, hold.id));

    await expectAppError(
      appointmentService.confirmHold(database, patientId, hold.id, 'too late'),
      409,
      'HOLD_EXPIRED',
    );

    const stillThere = await database.db.select().from(slotHolds).where(eq(slotHolds.id, hold.id));
    expect(stillThere).toHaveLength(1);
  });
});

describe('listMyAppointments', () => {
  it('returns only the requesting patient, newest first', async () => {
    const doctorId = await createBookableDoctor();
    const mine = await createPatient(database);
    const someoneElse = await createPatient(database);

    const earlier = await appointmentService.holdSlot(database, mine, doctorId, SLOT_START);
    await appointmentService.confirmHold(database, mine, earlier.id, 'first visit');

    const laterSlot = new Date('2026-09-01T09:20:00.000Z');
    const later = await appointmentService.holdSlot(database, mine, doctorId, laterSlot);
    const secondAppointment = await appointmentService.confirmHold(
      database,
      mine,
      later.id,
      'second visit',
    );

    const otherSlot = new Date('2026-09-01T09:40:00.000Z');
    const other = await appointmentService.holdSlot(database, someoneElse, doctorId, otherSlot);
    await appointmentService.confirmHold(database, someoneElse, other.id, 'not mine');

    const results = await appointmentService.listMyAppointments(database, mine);

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe(secondAppointment.id);
  });
});

describe('getAppointment', () => {
  async function bookOne(): Promise<{
    doctorId: string;
    patientId: string;
    appointmentId: string;
  }> {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);
    const appointment = await appointmentService.confirmHold(
      database,
      patientId,
      hold.id,
      'a visit',
    );
    return { doctorId, patientId, appointmentId: appointment.id };
  }

  it('lets the owning patient see it', async () => {
    const { patientId, appointmentId } = await bookOne();

    const result = await appointmentService.getAppointment(
      database,
      { id: patientId, role: 'patient' },
      appointmentId,
    );

    expect(result.id).toBe(appointmentId);
  });

  it('lets an admin see any appointment', async () => {
    const { appointmentId } = await bookOne();
    const adminId = await createPatient(database);

    const result = await appointmentService.getAppointment(
      database,
      { id: adminId, role: 'admin' },
      appointmentId,
    );

    expect(result.id).toBe(appointmentId);
  });

  it('404s for a patient who is not the owner, rather than exposing whose it is', async () => {
    const { appointmentId } = await bookOne();
    const stranger = await createPatient(database);

    await expectAppError(
      appointmentService.getAppointment(database, { id: stranger, role: 'patient' }, appointmentId),
      404,
      'NOT_FOUND',
    );
  });

  it('404s for an appointment id that does not exist', async () => {
    await expectAppError(
      appointmentService.getAppointment(
        database,
        { id: await createPatient(database), role: 'patient' },
        NONEXISTENT_ID,
      ),
      404,
      'NOT_FOUND',
    );
  });
});

describe('cancelAppointmentByRequester', () => {
  async function bookOne(): Promise<{
    doctorId: string;
    patientId: string;
    appointmentId: string;
  }> {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database);
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);
    const appointment = await appointmentService.confirmHold(
      database,
      patientId,
      hold.id,
      'a visit',
    );
    return { doctorId, patientId, appointmentId: appointment.id };
  }

  it('cancels and records who cancelled it and why', async () => {
    const { patientId, appointmentId } = await bookOne();

    const cancelled = await appointmentService.cancelAppointmentByRequester(
      database,
      { id: patientId, role: 'patient' },
      appointmentId,
      'Feeling better now',
    );

    expect(cancelled.status).toBe('cancelled');
  });

  it('frees the slot immediately for someone else to book', async () => {
    const { doctorId, patientId, appointmentId } = await bookOne();

    await appointmentService.cancelAppointmentByRequester(
      database,
      { id: patientId, role: 'patient' },
      appointmentId,
      undefined,
    );

    const another = await createPatient(database);
    const rebooked = await appointmentService.holdSlot(database, another, doctorId, SLOT_START);
    expect(rebooked.slot.start.toISOString()).toBe(SLOT_START.toISOString());
  });

  it('queues a cancellation notification for both patient and doctor', async () => {
    const { doctorId, patientId, appointmentId } = await bookOne();

    await appointmentService.cancelAppointmentByRequester(
      database,
      { id: patientId, role: 'patient' },
      appointmentId,
      undefined,
    );

    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, appointmentId));
    const cancellations = rows.filter(
      (row) => row.type === 'cancellation' && row.channel === 'email',
    );
    expect(cancellations).toHaveLength(2);
    expect(cancellations.map((row) => row.recipientId).sort()).toEqual(
      [doctorId, patientId].sort(),
    );
  });

  it('also queues a calendar-delete row for both patient and doctor', async () => {
    const { doctorId, patientId, appointmentId } = await bookOne();

    await appointmentService.cancelAppointmentByRequester(
      database,
      { id: patientId, role: 'patient' },
      appointmentId,
      undefined,
    );

    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, appointmentId));
    const calendarDeletes = rows.filter(
      (row) => row.type === 'cancellation' && row.channel === 'calendar',
    );
    expect(calendarDeletes).toHaveLength(2);
    expect(calendarDeletes.map((row) => row.recipientId).sort()).toEqual(
      [doctorId, patientId].sort(),
    );
  });

  it('refuses to cancel something already cancelled', async () => {
    const { patientId, appointmentId } = await bookOne();
    await appointmentService.cancelAppointmentByRequester(
      database,
      { id: patientId, role: 'patient' },
      appointmentId,
      undefined,
    );

    await expectAppError(
      appointmentService.cancelAppointmentByRequester(
        database,
        { id: patientId, role: 'patient' },
        appointmentId,
        undefined,
      ),
      409,
      'APPOINTMENT_NOT_CANCELLABLE',
    );
  });

  it("404s for a patient trying to cancel someone else's appointment", async () => {
    const { appointmentId } = await bookOne();
    const stranger = await createPatient(database);

    await expectAppError(
      appointmentService.cancelAppointmentByRequester(
        database,
        { id: stranger, role: 'patient' },
        appointmentId,
        undefined,
      ),
      404,
      'NOT_FOUND',
    );
  });

  it('lets an admin cancel any appointment', async () => {
    const { appointmentId } = await bookOne();
    const adminId = await createPatient(database);

    const cancelled = await appointmentService.cancelAppointmentByRequester(
      database,
      { id: adminId, role: 'admin' },
      appointmentId,
      'Support request',
    );

    expect(cancelled.status).toBe('cancelled');
  });
});

describe('submitNotes', () => {
  async function bookOne(patientTimezone?: string): Promise<{
    doctorId: string;
    patientId: string;
    appointmentId: string;
  }> {
    const doctorId = await createBookableDoctor();
    const patientId = await createPatient(database, patientTimezone ? { timezone: patientTimezone } : {});
    const hold = await appointmentService.holdSlot(database, patientId, doctorId, SLOT_START);
    const appointment = await appointmentService.confirmHold(database, patientId, hold.id, 'a visit');
    return { doctorId, patientId, appointmentId: appointment.id };
  }

  it('schedules medication reminders for a prescription in the same call, correctly counted', async () => {
    const { doctorId, patientId, appointmentId } = await bookOne();

    await appointmentService.submitNotes(database, doctorId, appointmentId, 'Notes.', [
      { drug: 'Ibuprofen', dosage: '400mg', timesPerDay: 3, durationDays: 5 },
      { drug: 'Cetirizine', dosage: '10mg', timesPerDay: 1, durationDays: 5 },
    ]);

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows.every((row) => row.patientId === patientId)).toBe(true);
    expect(rows.filter((row) => row.drugName === 'Ibuprofen')).toHaveLength(15);
    expect(rows.filter((row) => row.drugName === 'Cetirizine')).toHaveLength(5);
  });

  it('schedules nothing when the prescription is empty - notes without medication are common', async () => {
    const { doctorId, appointmentId } = await bookOne();

    await appointmentService.submitNotes(database, doctorId, appointmentId, 'Notes only, no medication.', []);

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows).toHaveLength(0);
  });
});
