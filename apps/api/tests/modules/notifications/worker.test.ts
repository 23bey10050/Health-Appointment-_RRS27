import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { notificationOutbox } from '../../../src/db/schema.js';
import type { EmailMessage, EmailSender } from '../../../src/shared/email.js';
import { queueNotification } from '../../../src/shared/outbox.js';
import { drainOutboxOnce } from '../../../src/modules/notifications/worker.js';
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

function fakeSender(): { sender: EmailSender; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sender: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    sent,
  };
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function bookedAppointment(): Promise<{
  appointmentId: string;
  doctorId: string;
  patientId: string;
}> {
  const doctorId = await createDoctor(database);
  const patientId = await createPatient(database);
  const appointmentId = await createConfirmedAppointment(database, {
    doctorId,
    patientId,
    slot: slotAt(9),
  });
  return { appointmentId, doctorId, patientId };
}

describe('drainOutboxOnce', () => {
  it('sends a queued notification and marks it sent', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { sender, sent } = fakeSender();

    const result = await drainOutboxOnce(database, sender, silentLogger());

    expect(result.processed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to.email).toEqual(expect.any(String));
    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('sent');
  });

  it('works out which side of the appointment the recipient is on', async () => {
    const { appointmentId, doctorId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: doctorId,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { sender, sent } = fakeSender();

    await drainOutboxOnce(database, sender, silentLogger());

    // The doctor's own copy talks about the patient, not about "your appointment".
    expect(sent[0]?.subject).toMatch(/New appointment/);
  });

  it('a bad row fails cleanly and does not stop the rest of the batch', async () => {
    // A row whose recipient is neither side of its own appointment - a data integrity problem
    // that has to fail loudly, but must not take the rest of the tick's batch down with it.
    const { appointmentId: firstAppointment } = await bookedAppointment();
    const unrelatedPerson = await createPatient(database);
    await queueNotification(database.db, {
      appointmentId: firstAppointment,
      recipientId: unrelatedPerson,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId: firstAppointment },
    });
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { sender, sent } = fakeSender();

    const result = await drainOutboxOnce(database, sender, silentLogger());

    expect(result.processed).toBe(2);
    // Only the good row actually produced an email.
    expect(sent).toHaveLength(1);
    const rows = await database.db.select().from(notificationOutbox);
    const statuses = rows.map((row) => row.status).sort();
    expect(statuses).toEqual(['failed', 'sent']);
  });

  it('does nothing, quietly, when there is nothing due', async () => {
    const { sender, sent } = fakeSender();

    const result = await drainOutboxOnce(database, sender, silentLogger());

    expect(result.processed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a sender that throws marks the row failed rather than crashing the tick', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const failingSender: EmailSender = {
      send: () => Promise.reject(new Error('Brevo is down')),
    };

    await expect(drainOutboxOnce(database, failingSender, silentLogger())).resolves.toEqual({
      processed: 1,
    });

    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('Brevo is down');
  });

  it('a recipient who is neither the doctor nor the patient fails clearly instead of guessing', async () => {
    const { appointmentId } = await bookedAppointment();
    const someoneElse = await createPatient(database);
    await queueNotification(database.db, {
      appointmentId,
      recipientId: someoneElse,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { sender, sent } = fakeSender();

    await drainOutboxOnce(database, sender, silentLogger());

    expect(sent).toHaveLength(0);
    const [row] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientId, someoneElse));
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/neither the doctor nor the patient/);
  });
});
