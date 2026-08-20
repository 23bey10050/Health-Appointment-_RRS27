import type { NotificationChannel, NotificationType } from '@health/contracts';

import type { DbTransaction } from '../db/client.js';
import { notificationOutbox } from '../db/schema.js';

/** Runs inside either a plain Db or a transaction — both expose the same `.insert(...)`. */
type Writable = Pick<DbTransaction, 'insert'>;

export interface QueuedNotification {
  appointmentId?: string;
  recipientId: string;
  channel: NotificationChannel;
  type: NotificationType;
  payload: Record<string, unknown>;
  /** Lets a later phase's dispatcher insert the same logical message twice without duplicating it. */
  dedupeKey?: string;
}

/**
 * Writes one row to the notification outbox — a promise to send something, not the sending itself.
 *
 * This is the transactional outbox pattern: called from inside the same transaction as the booking,
 * cancellation, or other event that made the notification necessary, so the two either both commit
 * or neither does. Nothing drains this table yet — that worker is Phase 5 — so today these rows
 * simply sit `queued` until then. That is fine and is the whole point: the *promise* to notify
 * someone is durable from the moment the appointment exists, independent of whether the sender has
 * been built yet.
 */
export async function queueNotification(
  db: Writable,
  notification: QueuedNotification,
): Promise<void> {
  await db
    .insert(notificationOutbox)
    .values({
      appointmentId: notification.appointmentId,
      recipientId: notification.recipientId,
      channel: notification.channel,
      type: notification.type,
      payload: notification.payload,
      dedupeKey: notification.dedupeKey,
    })
    .onConflictDoNothing({ target: notificationOutbox.dedupeKey });
}
