import type { Database } from '../../db/client.js';
import { buildCalendarEventCopy } from '../calendar/copy.js';
import { saveGoogleEventId } from '../calendar/repository.js';
import type { CalendarSync } from '../calendar/sync.js';
import type { EmailSender } from '../../shared/email.js';
import { describeUnknownError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logging.js';

import { claimDueNotifications, markFailed, markSent, type OutboxRow } from './outbox-store.js';
import { loadRenderContext, type RenderContext } from './render-context.js';
import { renderNotification, type NotificationSide } from './templates.js';

/** Which side of the appointment a row's recipient is on — the one thing that decides which of
 *  the two templates for a shared type like `booking_confirmation` gets used. */
function sideFor(
  row: OutboxRow,
  doctorId: string,
  patientId: string,
): NotificationSide | undefined {
  if (row.recipientId === patientId) return 'patient';
  if (row.recipientId === doctorId) return 'doctor';
  return undefined;
}

async function sendEmail(
  sender: EmailSender,
  row: OutboxRow,
  side: NotificationSide,
  context: RenderContext,
): Promise<void> {
  const email = renderNotification(row.type, side, context);
  const recipient =
    side === 'patient'
      ? { email: context.patientEmail, name: context.patientName }
      : { email: context.doctorEmail, name: context.doctorName };

  await sender.send({
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
    idempotencyKey: row.id,
  });
}

/**
 * Creates or deletes one person's own copy of the calendar event, depending on which type of row
 * this is. `booking_confirmation` is the only type this app queues on the calendar channel that
 * means "create" - everything else that reaches here (`cancellation` today) means "delete".
 */
async function syncCalendar(
  database: Database,
  calendarSync: CalendarSync,
  row: OutboxRow,
  side: NotificationSide,
  context: RenderContext,
): Promise<void> {
  if (row.type === 'cancellation') {
    const eventId = side === 'patient' ? context.googleEventIdPatient : context.googleEventIdDoctor;
    if (eventId) {
      await calendarSync.deleteEvent(row.recipientId, eventId);
    }
    return;
  }

  const copy = buildCalendarEventCopy(side, context);
  const eventId = await calendarSync.upsertEvent(row.recipientId, {
    appointmentId: context.appointmentId,
    summary: copy.summary,
    description: copy.description,
    start: context.slot.start,
    end: context.slot.end,
  });

  if (eventId) {
    await saveGoogleEventId(database, context.appointmentId, side, eventId);
  }
}

async function processOne(
  database: Database,
  sender: EmailSender,
  calendarSync: CalendarSync,
  row: OutboxRow,
  logger: Logger,
): Promise<void> {
  try {
    if (!row.appointmentId) {
      throw new Error('This notification has no appointment to render - nothing to send.');
    }

    const context = await loadRenderContext(database, row.appointmentId);
    if (!context) {
      throw new Error(`Appointment ${row.appointmentId} no longer exists.`);
    }

    const side = sideFor(row, context.doctorId, context.patientId);
    if (!side) {
      throw new Error(
        `Recipient ${row.recipientId} is neither the doctor nor the patient on appointment ${row.appointmentId}.`,
      );
    }

    if (row.channel === 'email') {
      await sendEmail(sender, row, side, context);
    } else {
      await syncCalendar(database, calendarSync, row, side, context);
    }

    await markSent(database, row.id);
  } catch (error) {
    const message = describeUnknownError(error);
    await markFailed(database, row, message);
    logger.warn(
      { outboxId: row.id, type: row.type, err: error },
      `Notification send failed: ${message}`,
    );
  }
}

/**
 * One full drain tick: claim whatever is due, send each one, record the outcome. Failures in one
 * row never stop the rest of the batch — `processOne` catches its own errors so a single bad row
 * cannot wedge the whole tick.
 */
export async function drainOutboxOnce(
  database: Database,
  sender: EmailSender,
  calendarSync: CalendarSync,
  logger: Logger,
): Promise<{ processed: number }> {
  const rows = await claimDueNotifications(database);

  for (const row of rows) {
    await processOne(database, sender, calendarSync, row, logger);
  }

  if (rows.length > 0) {
    logger.info({ count: rows.length }, `Outbox tick processed ${rows.length} notification(s)`);
  }

  return { processed: rows.length };
}
