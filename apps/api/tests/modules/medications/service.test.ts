import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { medicationReminders } from '../../../src/db/schema.js';
import { scheduleMedicationReminders } from '../../../src/modules/medications/service.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createConfirmedAppointment, createDoctor, createPatient, slotAt } from '../../helpers/fixtures.js';

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

async function bookedAppointment(patientTimezone = 'Asia/Kolkata'): Promise<{
  appointmentId: string;
  patientId: string;
}> {
  const doctorId = await createDoctor(database);
  const patientId = await createPatient(database, { timezone: patientTimezone });
  const appointmentId = await createConfirmedAppointment(database, { doctorId, patientId, slot: slotAt(9) });
  return { appointmentId, patientId };
}

describe('scheduleMedicationReminders', () => {
  it('creates exactly timesPerDay times durationDays reminders for one drug', async () => {
    const { appointmentId, patientId } = await bookedAppointment();

    await database.transaction((tx) =>
      scheduleMedicationReminders(tx, {
        appointmentId,
        patientId,
        patientTimezone: 'Asia/Kolkata',
        prescription: [{ drug: 'Ibuprofen', dosage: '400mg', timesPerDay: 3, durationDays: 5 }],
      }),
    );

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows).toHaveLength(15);
  });

  it('creates a separate schedule for each drug in a multi-drug prescription', async () => {
    const { appointmentId, patientId } = await bookedAppointment();

    await database.transaction((tx) =>
      scheduleMedicationReminders(tx, {
        appointmentId,
        patientId,
        patientTimezone: 'Asia/Kolkata',
        prescription: [
          { drug: 'Ibuprofen', dosage: '400mg', timesPerDay: 3, durationDays: 5 },
          { drug: 'Cetirizine', dosage: '10mg', timesPerDay: 1, durationDays: 5 },
        ],
      }),
    );

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows.filter((r) => r.drugName === 'Ibuprofen')).toHaveLength(15);
    expect(rows.filter((r) => r.drugName === 'Cetirizine')).toHaveLength(5);
  });

  it('carries the dosage and instructions through onto every reminder row', async () => {
    const { appointmentId, patientId } = await bookedAppointment();

    await database.transaction((tx) =>
      scheduleMedicationReminders(tx, {
        appointmentId,
        patientId,
        patientTimezone: 'Asia/Kolkata',
        prescription: [
          { drug: 'Ibuprofen', dosage: '400mg', timesPerDay: 1, durationDays: 2, instructions: 'Take after food' },
        ],
      }),
    );

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows.every((r) => r.dosage === '400mg' && r.instructions === 'Take after food')).toBe(true);
  });

  it('does nothing for an empty prescription', async () => {
    const { appointmentId, patientId } = await bookedAppointment();

    await database.transaction((tx) =>
      scheduleMedicationReminders(tx, {
        appointmentId,
        patientId,
        patientTimezone: 'Asia/Kolkata',
        prescription: [],
      }),
    );

    const rows = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    expect(rows).toHaveLength(0);
  });

  it("uses the patient's own timezone, not the server's, to decide the schedule's instants", async () => {
    const { appointmentId, patientId } = await bookedAppointment();

    await database.transaction((tx) =>
      scheduleMedicationReminders(tx, {
        appointmentId,
        patientId,
        patientTimezone: 'Pacific/Auckland',
        prescription: [{ drug: 'Ibuprofen', dosage: '400mg', timesPerDay: 1, durationDays: 1 }],
      }),
    );

    const [row] = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.appointmentId, appointmentId));
    // 09:00 in Auckland (UTC+12 or +13 depending on the date) is always well before 09:00 UTC.
    expect(row?.scheduledAt.getUTCHours()).not.toBe(9);
  });
});
