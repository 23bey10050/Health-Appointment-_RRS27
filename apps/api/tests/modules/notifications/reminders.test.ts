import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { appointments, notificationOutbox } from '../../../src/db/schema.js';
import { slotOf } from '../../../src/db/types/time-range.js';
import { queueDueReminders } from '../../../src/modules/notifications/reminders.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createConfirmedAppointment, createDoctor, createPatient } from '../../helpers/fixtures.js';

let database: Database;
let doctorId: string;
let patientId: string;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
  doctorId = await createDoctor(database);
  patientId = await createPatient(database);
});

async function bookIn(hoursFromNow: number): Promise<string> {
  const start = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  return createConfirmedAppointment(database, { doctorId, patientId, slot: slotOf(start, 20) });
}

async function outboxTypesFor(appointmentId: string): Promise<string[]> {
  const rows = await database.db
    .select({ type: notificationOutbox.type })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.appointmentId, appointmentId));
  return rows.map((row) => row.type);
}

describe('queueDueReminders', () => {
  it('queues a 24-hour reminder for an appointment well inside that window', async () => {
    const appointmentId = await bookIn(20);

    const counts = await queueDueReminders(database);

    expect(counts.queued24h).toBe(1);
    expect(await outboxTypesFor(appointmentId)).toEqual(['reminder_24h']);
  });

  it('queues a 1-hour reminder for an appointment inside that closer window instead', async () => {
    const appointmentId = await bookIn(0.5);

    const counts = await queueDueReminders(database);

    expect(counts.queued1h).toBe(1);
    expect(await outboxTypesFor(appointmentId)).toEqual(['reminder_1h']);
  });

  it('does not queue either reminder for an appointment far in the future', async () => {
    const appointmentId = await bookIn(48);

    await queueDueReminders(database);

    expect(await outboxTypesFor(appointmentId)).toEqual([]);
  });

  it('does not queue a reminder for an appointment that already happened', async () => {
    const appointmentId = await bookIn(-2);

    await queueDueReminders(database);

    expect(await outboxTypesFor(appointmentId)).toEqual([]);
  });

  it('never queues both reminders for the same appointment from one tick', async () => {
    // Inside the 24h window at the moment this tick runs.
    const appointmentId = await bookIn(20);

    await queueDueReminders(database);

    const types = await outboxTypesFor(appointmentId);
    expect(types).toHaveLength(1);
  });

  it('is safe to run again and again - the dedupe key stops a duplicate reminder', async () => {
    const appointmentId = await bookIn(20);

    await queueDueReminders(database);
    await queueDueReminders(database);
    await queueDueReminders(database);

    expect(await outboxTypesFor(appointmentId)).toEqual(['reminder_24h']);
  });

  it('ignores a cancelled appointment even if its old slot is inside the window', async () => {
    const appointmentId = await bookIn(20);
    await database.db
      .update(appointments)
      .set({ status: 'cancelled' })
      .where(eq(appointments.id, appointmentId));

    await queueDueReminders(database);

    expect(await outboxTypesFor(appointmentId)).toEqual([]);
  });

  it('addresses the reminder to the patient, not the doctor', async () => {
    const appointmentId = await bookIn(20);

    await queueDueReminders(database);

    const [row] = await database.db
      .select({ recipientId: notificationOutbox.recipientId })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, appointmentId));
    expect(row?.recipientId).toBe(patientId);
  });
});
