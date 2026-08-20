import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { appointments } from '../../db/schema.js';
import { queueNotification } from '../../shared/outbox.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;

/**
 * Finds confirmed appointments whose start time falls inside a window and queues one reminder
 * each, keyed so a second discovery of the same appointment on a later tick is a silent no-op
 * rather than a duplicate email.
 *
 * The window is deliberately wide — "anywhere in the next 24 hours", not "in exactly 24 hours,
 * give or take a minute" — because this runs as a repeating poll, not a one-shot alarm. A narrow
 * window only fires correctly if a tick happens to land inside it; if the process was asleep
 * during a Render free-tier cold start, or a deploy restarted it, a narrow window could pass by
 * entirely unnoticed and the reminder would simply never go out. A wide window plus the dedupe key
 * means the very next tick after the process comes back always catches anything it missed, and
 * catches it exactly once.
 */
async function queueRemindersInWindow(
  database: Database,
  type: 'reminder_24h' | 'reminder_1h',
  windowStartMs: number,
  windowEndMs: number,
): Promise<number> {
  const now = Date.now();
  const windowStart = new Date(now + windowStartMs);
  const windowEnd = new Date(now + windowEndMs);

  const due = await database.db
    .select({ id: appointments.id, patientId: appointments.patientId })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'confirmed'),
        sql`lower(${appointments.slot}) > ${windowStart}`,
        sql`lower(${appointments.slot}) <= ${windowEnd}`,
      ),
    );

  for (const appointment of due) {
    await queueNotification(database.db, {
      appointmentId: appointment.id,
      recipientId: appointment.patientId,
      channel: 'email',
      type,
      payload: { appointmentId: appointment.id },
      dedupeKey: `${type}:${appointment.id}`,
    });
  }

  return due.length;
}

export interface ReminderCounts {
  queued24h: number;
  queued1h: number;
}

/**
 * One tick of the reminder scheduler. The two windows do not overlap — anything inside the next
 * hour belongs to the 1-hour reminder, not the 24-hour one — so an appointment can never receive
 * both from the same tick, though it will naturally receive the 24-hour one on an earlier tick and
 * the 1-hour one on a later one as time actually passes.
 */
export async function queueDueReminders(database: Database): Promise<ReminderCounts> {
  const queued24h = await queueRemindersInWindow(
    database,
    'reminder_24h',
    ONE_HOUR_MS,
    TWENTY_FOUR_HOURS_MS,
  );
  const queued1h = await queueRemindersInWindow(database, 'reminder_1h', 0, ONE_HOUR_MS);

  return { queued24h, queued1h };
}
