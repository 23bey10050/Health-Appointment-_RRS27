import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { medicationReminders } from '../../../src/db/schema.js';
import {
  claimDueMedicationReminders,
  expandScheduleTimes,
  findMedicationReminderById,
  findUserTimezone,
  insertReminders,
  markReminderQueued,
  type NewReminder,
} from '../../../src/modules/medications/repository.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import {
  createConfirmedAppointment,
  createDoctor,
  createPatient,
  slotAt,
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

describe('expandScheduleTimes', () => {
  it('produces one instant per day, at the requested local clock time', async () => {
    const times = await expandScheduleTimes(database.db, {
      startDate: '2026-08-21',
      durationDays: 5,
      timesOfDay: ['09:00:00'],
      timezone: 'Asia/Kolkata',
    });

    expect(times).toHaveLength(5);
    // 09:00 IST is 03:30 UTC, every day, since India has no daylight saving to complicate it.
    expect(times.map((t) => t.toISOString())).toEqual([
      '2026-08-21T03:30:00.000Z',
      '2026-08-22T03:30:00.000Z',
      '2026-08-23T03:30:00.000Z',
      '2026-08-24T03:30:00.000Z',
      '2026-08-25T03:30:00.000Z',
    ]);
  });

  it('produces exactly timesPerDay times durationDays instants for a multi-dose schedule', async () => {
    const times = await expandScheduleTimes(database.db, {
      startDate: '2026-08-21',
      durationDays: 5,
      timesOfDay: ['08:00:00', '14:00:00', '20:00:00'],
      timezone: 'Asia/Kolkata',
    });

    expect(times).toHaveLength(15);
  });

  it('keeps the same local clock time across a daylight-saving change, not the same UTC offset', async () => {
    // 2026-03-08 is when America/New_York springs forward from EST (UTC-5) to EDT (UTC-4). A
    // naive "always add five hours" implementation would put the last day's reminder an hour off
    // from the first two - this is exactly the "3am reminder" trap the plan warns about.
    const times = await expandScheduleTimes(database.db, {
      startDate: '2026-03-07',
      durationDays: 3,
      timesOfDay: ['09:00:00'],
      timezone: 'America/New_York',
    });

    expect(times.map((t) => t.toISOString())).toEqual([
      '2026-03-07T14:00:00.000Z', // 09:00 EST (UTC-5)
      '2026-03-08T13:00:00.000Z', // 09:00 EDT (UTC-4) - the DST day itself
      '2026-03-09T13:00:00.000Z', // 09:00 EDT (UTC-4)
    ]);
  });
});

async function bookedAppointment(): Promise<{ appointmentId: string; patientId: string }> {
  const doctorId = await createDoctor(database);
  const patientId = await createPatient(database);
  const appointmentId = await createConfirmedAppointment(database, {
    doctorId,
    patientId,
    slot: slotAt(9),
  });
  return { appointmentId, patientId };
}

describe('insertReminders', () => {
  it('inserts one row per instant', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    const reminders: NewReminder[] = [
      {
        appointmentId,
        patientId,
        drugName: 'Ibuprofen',
        dosage: '400mg',
        instructions: undefined,
        scheduledAt: new Date('2026-09-01T08:00:00.000Z'),
      },
      {
        appointmentId,
        patientId,
        drugName: 'Ibuprofen',
        dosage: '400mg',
        instructions: undefined,
        scheduledAt: new Date('2026-09-02T08:00:00.000Z'),
      },
    ];

    await database.transaction((tx) => insertReminders(tx, reminders));

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows).toHaveLength(2);
  });

  it('running it twice for the same schedule does not duplicate any row', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    const reminders: NewReminder[] = [
      {
        appointmentId,
        patientId,
        drugName: 'Ibuprofen',
        dosage: '400mg',
        instructions: undefined,
        scheduledAt: new Date('2026-09-01T08:00:00.000Z'),
      },
    ];

    await database.transaction((tx) => insertReminders(tx, reminders));
    await database.transaction((tx) => insertReminders(tx, reminders));

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows).toHaveLength(1);
  });

  it('does nothing, without erroring, for an empty list', async () => {
    await expect(database.transaction((tx) => insertReminders(tx, []))).resolves.toBeUndefined();
  });
});

describe('findUserTimezone', () => {
  it("returns the patient's own stored timezone", async () => {
    const patientId = await createPatient(database, { timezone: 'Europe/London' });

    await expect(database.transaction((tx) => findUserTimezone(tx, patientId))).resolves.toBe(
      'Europe/London',
    );
  });

  it('throws for a user id that does not exist', async () => {
    await expect(
      database.transaction((tx) => findUserTimezone(tx, '00000000-0000-4000-8000-000000000000')),
    ).rejects.toThrow();
  });
});

describe('claimDueMedicationReminders / markReminderQueued', () => {
  it('claims a reminder that is due and unqueued, and ignores one that is not due yet', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await database.db.insert(medicationReminders).values([
      { appointmentId, patientId, drugName: 'Due now', scheduledAt: new Date(Date.now() - 60_000) },
      {
        appointmentId,
        patientId,
        drugName: 'Not due yet',
        scheduledAt: new Date(Date.now() + 60 * 60_000),
      },
    ]);

    const due = await database.transaction((tx) => claimDueMedicationReminders(tx));

    expect(due.map((r) => r.drugName)).toEqual(['Due now']);
  });

  it('ignores a reminder that is due but already queued', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await database.db.insert(medicationReminders).values({
      appointmentId,
      patientId,
      drugName: 'Already queued',
      scheduledAt: new Date(Date.now() - 60_000),
      queuedAt: new Date(),
    });

    const due = await database.transaction((tx) => claimDueMedicationReminders(tx));

    expect(due).toHaveLength(0);
  });

  it('marking a reminder queued removes it from the next claim', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    const [row] = await database.db
      .insert(medicationReminders)
      .values({
        appointmentId,
        patientId,
        drugName: 'Due now',
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: medicationReminders.id });

    await database.transaction((tx) => markReminderQueued(tx, row!.id));

    const due = await database.transaction((tx) => claimDueMedicationReminders(tx));
    expect(due).toHaveLength(0);
  });
});

describe('findMedicationReminderById', () => {
  it('finds a reminder by id, and returns undefined for one that does not exist', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    const [row] = await database.db
      .insert(medicationReminders)
      .values({
        appointmentId,
        patientId,
        drugName: 'Cetirizine',
        dosage: '10mg',
        scheduledAt: new Date(),
      })
      .returning({ id: medicationReminders.id });

    const found = await findMedicationReminderById(database, row!.id);
    expect(found?.drugName).toBe('Cetirizine');

    const notFound = await findMedicationReminderById(
      database,
      '00000000-0000-4000-8000-000000000000',
    );
    expect(notFound).toBeUndefined();
  });
});
