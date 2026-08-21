import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { medicationReminders, notificationOutbox } from '../../../src/db/schema.js';
import { queueDueMedicationReminders } from '../../../src/modules/medications/dispatcher.js';
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

describe('queueDueMedicationReminders', () => {
  it('queues a due reminder into the outbox and marks it queued', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    const [reminder] = await database.db
      .insert(medicationReminders)
      .values({
        appointmentId,
        patientId,
        drugName: 'Ibuprofen',
        dosage: '400mg',
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: medicationReminders.id });

    const result = await queueDueMedicationReminders(database);

    expect(result.queued).toBe(1);
    const [outboxRow] = await database.db.select().from(notificationOutbox);
    expect(outboxRow?.channel).toBe('email');
    expect(outboxRow?.type).toBe('medication_reminder');
    expect(outboxRow?.recipientId).toBe(patientId);
    expect(outboxRow?.payload).toEqual({ medicationReminderId: reminder!.id });

    const [reminderRow] = await database.db
      .select()
      .from(medicationReminders)
      .where(eq(medicationReminders.id, reminder!.id));
    expect(reminderRow?.queuedAt).not.toBeNull();
  });

  it('leaves a reminder that is not due yet alone', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await database.db.insert(medicationReminders).values({
      appointmentId,
      patientId,
      drugName: 'Ibuprofen',
      scheduledAt: new Date(Date.now() + 60 * 60_000),
    });

    const result = await queueDueMedicationReminders(database);

    expect(result.queued).toBe(0);
    expect(await database.db.select().from(notificationOutbox)).toHaveLength(0);
  });

  it('never queues the same reminder twice, even if called again before it is sent', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await database.db.insert(medicationReminders).values({
      appointmentId,
      patientId,
      drugName: 'Ibuprofen',
      scheduledAt: new Date(Date.now() - 60_000),
    });

    await queueDueMedicationReminders(database);
    const second = await queueDueMedicationReminders(database);

    expect(second.queued).toBe(0);
    expect(await database.db.select().from(notificationOutbox)).toHaveLength(1);
  });

  it('does nothing, quietly, when nothing is due', async () => {
    const result = await queueDueMedicationReminders(database);

    expect(result.queued).toBe(0);
  });
});
