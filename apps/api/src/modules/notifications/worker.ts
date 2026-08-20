import type { Database } from '../../db/client.js';
import type { EmailSender } from '../../shared/email.js';
import { describeUnknownError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logging.js';

import { claimDueNotifications, markFailed, markSent, type OutboxRow } from './outbox-store.js';
import { loadRenderContext } from './render-context.js';
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

async function processOne(
  database: Database,
  sender: EmailSender,
  row: OutboxRow,
  logger: Logger,
): Promise<void> {
  try {
    if (row.channel !== 'email') {
      // Nothing queues a 'calendar' row yet - that is Phase 7 - so reaching this branch today
      // would itself be a bug elsewhere, not a real outcome to plan around beyond failing clearly.
      throw new Error(`No sender implemented for channel "${row.channel}".`);
    }
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
  logger: Logger,
): Promise<{ processed: number }> {
  const rows = await claimDueNotifications(database);

  for (const row of rows) {
    await processOne(database, sender, row, logger);
  }

  if (rows.length > 0) {
    logger.info({ count: rows.length }, `Outbox tick processed ${rows.length} notification(s)`);
  }

  return { processed: rows.length };
}
