import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { appointments, medicationReminders, notificationOutbox } from '../../../src/db/schema.js';
import { saveGoogleEventId } from '../../../src/modules/calendar/repository.js';
import type { CalendarEventDetails, CalendarSync } from '../../../src/modules/calendar/sync.js';
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

/** None of these tests queue a 'calendar' channel row, so this never actually gets called - it
 *  only needs to exist to satisfy `drainOutboxOnce`'s signature. */
function unusedCalendarSync(): CalendarSync {
  return {
    upsertEvent: () => Promise.resolve(undefined),
    deleteEvent: () => Promise.resolve(),
  };
}

interface FakeCalendarSync {
  calendarSync: CalendarSync;
  upsertCalls: { userId: string; event: CalendarEventDetails }[];
  deleteCalls: { userId: string; eventId: string }[];
}

function fakeCalendarSync(
  behavior: {
    /** false simulates a recipient who has never connected Google - upsertEvent resolves to
     *  undefined, exactly like the real GoogleCalendarSync does for that case. Defaults to true,
     *  since most tests here care about the connected path. */
    connected?: boolean;
    eventId?: string;
    upsertError?: Error;
  } = {},
): FakeCalendarSync {
  const connected = behavior.connected ?? true;
  const upsertCalls: { userId: string; event: CalendarEventDetails }[] = [];
  const deleteCalls: { userId: string; eventId: string }[] = [];
  return {
    calendarSync: {
      upsertEvent: (userId, event) => {
        upsertCalls.push({ userId, event });
        if (behavior.upsertError) {
          return Promise.reject(behavior.upsertError);
        }
        return Promise.resolve(connected ? (behavior.eventId ?? 'fake-google-event-id') : undefined);
      },
      deleteEvent: (userId, eventId) => {
        deleteCalls.push({ userId, eventId });
        return Promise.resolve();
      },
    },
    upsertCalls,
    deleteCalls,
  };
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

    const result = await drainOutboxOnce(database, sender, unusedCalendarSync(), silentLogger());

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

    await drainOutboxOnce(database, sender, unusedCalendarSync(), silentLogger());

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

    const result = await drainOutboxOnce(database, sender, unusedCalendarSync(), silentLogger());

    expect(result.processed).toBe(2);
    // Only the good row actually produced an email.
    expect(sent).toHaveLength(1);
    const rows = await database.db.select().from(notificationOutbox);
    const statuses = rows.map((row) => row.status).sort();
    expect(statuses).toEqual(['failed', 'sent']);
  });

  it('does nothing, quietly, when there is nothing due', async () => {
    const { sender, sent } = fakeSender();

    const result = await drainOutboxOnce(database, sender, unusedCalendarSync(), silentLogger());

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

    await expect(drainOutboxOnce(database, failingSender, unusedCalendarSync(), silentLogger())).resolves.toEqual({
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

    await drainOutboxOnce(database, sender, unusedCalendarSync(), silentLogger());

    expect(sent).toHaveLength(0);
    const [row] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientId, someoneElse));
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/neither the doctor nor the patient/);
  });
});

describe('drainOutboxOnce - calendar channel', () => {
  it('creates an event and records the returned id on the appointment', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'calendar',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { calendarSync, upsertCalls } = fakeCalendarSync({ eventId: 'a-real-event-id' });

    const result = await drainOutboxOnce(database, fakeSender().sender, calendarSync, silentLogger());

    expect(result.processed).toBe(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.userId).toBe(patientId);
    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('sent');
    const [appointment] = await database.db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appointment?.googleEventIdPatient).toBe('a-real-event-id');
  });

  it("a recipient who has not connected Google produces no event, and still counts as sent - not an error", async () => {
    const { appointmentId, doctorId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: doctorId,
      channel: 'calendar',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { calendarSync } = fakeCalendarSync({ connected: false });

    await drainOutboxOnce(database, fakeSender().sender, calendarSync, silentLogger());

    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('sent');
    const [appointment] = await database.db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appointment?.googleEventIdDoctor).toBeNull();
  });

  it('deletes the event on cancellation using the id recorded when it was created', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await saveGoogleEventId(database, appointmentId, 'patient', 'the-existing-event-id');
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'calendar',
      type: 'cancellation',
      payload: { appointmentId },
    });
    const { calendarSync, deleteCalls } = fakeCalendarSync();

    await drainOutboxOnce(database, fakeSender().sender, calendarSync, silentLogger());

    expect(deleteCalls).toEqual([{ userId: patientId, eventId: 'the-existing-event-id' }]);
    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('sent');
  });

  it('does nothing on cancellation when that side never had an event created', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'calendar',
      type: 'cancellation',
      payload: { appointmentId },
    });
    const { calendarSync, deleteCalls } = fakeCalendarSync();

    await drainOutboxOnce(database, fakeSender().sender, calendarSync, silentLogger());

    expect(deleteCalls).toHaveLength(0);
    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('sent');
  });

  it('a revoked Google connection fails the row cleanly, with the real reason recorded, like any other failure', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'calendar',
      type: 'booking_confirmation',
      payload: { appointmentId },
    });
    const { calendarSync } = fakeCalendarSync({
      upsertError: new Error('Google Calendar access has been revoked or has expired. Reconnect to restore it.'),
    });

    await drainOutboxOnce(database, fakeSender().sender, calendarSync, silentLogger());

    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/revoked or has expired/);
  });
});

describe('drainOutboxOnce - medication_reminder', () => {
  it("sends the specific drug and dose this reminder is about, not just something about the appointment", async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    const [reminder] = await database.db
      .insert(medicationReminders)
      .values({
        appointmentId,
        patientId,
        drugName: 'Cetirizine',
        dosage: '10mg',
        instructions: 'Take once in the morning',
        scheduledAt: new Date(),
      })
      .returning({ id: medicationReminders.id });
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'email',
      type: 'medication_reminder',
      payload: { medicationReminderId: reminder!.id },
    });
    const { sender, sent } = fakeSender();

    const result = await drainOutboxOnce(database, sender, unusedCalendarSync(), silentLogger());

    expect(result.processed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Cetirizine');
    expect(sent[0]?.text).toContain('10mg');
    expect(sent[0]?.text).toContain('Take once in the morning');
    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('sent');
  });

  it('fails cleanly, without crashing the tick, when the row it points at no longer exists', async () => {
    const { appointmentId, patientId } = await bookedAppointment();
    await queueNotification(database.db, {
      appointmentId,
      recipientId: patientId,
      channel: 'email',
      type: 'medication_reminder',
      payload: { medicationReminderId: '00000000-0000-4000-8000-000000000000' },
    });

    await drainOutboxOnce(database, fakeSender().sender, unusedCalendarSync(), silentLogger());

    const [row] = await database.db.select().from(notificationOutbox);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/no longer exists/);
  });
});
