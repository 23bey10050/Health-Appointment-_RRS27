import { and, asc, count, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { notificationOutbox } from '../../db/schema.js';

const BATCH_SIZE = 20;
const MAX_BACKOFF_SECONDS = 30 * 60;
/** How long a claimed row is protected from being picked up again while we work on it. Long
 *  enough to cover a slow Brevo call comfortably, short enough that a crash mid-send is retried
 *  the same tick or two later rather than stuck for the whole 30-minute backoff cap. */
const PROCESSING_LEASE_SECONDS = 120;

export type OutboxRow = typeof notificationOutbox.$inferSelect;

/**
 * Claims up to `BATCH_SIZE` due rows for this worker tick and hands them back — without holding
 * any database lock for the time it then takes to actually send each one.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets two overlapping ticks (a slow tick still running when the
 * next one starts) run safely side by side: the second tick simply skips whatever the first is
 * already holding, rather than blocking on it or double-claiming it. That lock only needs to last
 * long enough to read the rows and push `next_attempt_at` forward by a short lease — not for the
 * whole time it then takes to call Brevo, which is why this whole function is one short
 * transaction and every actual send happens afterwards, lock-free.
 */
export async function claimDueNotifications(database: Database): Promise<OutboxRow[]> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(notificationOutbox)
      .where(
        and(
          inArray(notificationOutbox.status, ['queued', 'failed']),
          lte(notificationOutbox.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(notificationOutbox.createdAt))
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    if (rows.length === 0) {
      return [];
    }

    await tx
      .update(notificationOutbox)
      .set({ nextAttemptAt: new Date(Date.now() + PROCESSING_LEASE_SECONDS * 1000) })
      .where(
        inArray(
          notificationOutbox.id,
          rows.map((row) => row.id),
        ),
      );

    return rows;
  });
}

export async function markSent(database: Database, id: string): Promise<void> {
  await database.db
    .update(notificationOutbox)
    .set({ status: 'sent', sentAt: new Date(), lastError: null })
    .where(eq(notificationOutbox.id, id));
}

/**
 * Records a failed send and decides what happens next: another attempt after a growing delay, or
 * — once `maxAttempts` is used up — a move to `dead_letter`, where it stops retrying itself and
 * waits for a human to look at it on the admin dashboard.
 */
export async function markFailed(
  database: Database,
  row: OutboxRow,
  errorMessage: string,
): Promise<void> {
  const attempts = row.attempts + 1;

  if (attempts >= row.maxAttempts) {
    await database.db
      .update(notificationOutbox)
      .set({ status: 'dead_letter', attempts, lastError: errorMessage })
      .where(eq(notificationOutbox.id, row.id));
    return;
  }

  const backoffSeconds = Math.min(2 ** attempts * 30, MAX_BACKOFF_SECONDS);
  await database.db
    .update(notificationOutbox)
    .set({
      status: 'failed',
      attempts,
      lastError: errorMessage,
      nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
    })
    .where(eq(notificationOutbox.id, row.id));
}

/** The at-a-glance counts behind the "Notification Health" tab's summary strip - one number per
 *  status, always all four keys present even when a status currently has nothing in it. */
export async function countByStatus(
  database: Database,
): Promise<{ queued: number; sent: number; failed: number; dead_letter: number }> {
  const rows = await database.db
    .select({ status: notificationOutbox.status, total: count() })
    .from(notificationOutbox)
    .groupBy(notificationOutbox.status);

  const counts = { queued: 0, sent: 0, failed: 0, dead_letter: 0 };
  for (const row of rows) {
    counts[row.status] = row.total;
  }
  return counts;
}

export async function listDeadLetters(database: Database): Promise<OutboxRow[]> {
  return database.db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.status, 'dead_letter'))
    .orderBy(asc(notificationOutbox.createdAt));
}

/**
 * Gives a dead-lettered row a clean slate rather than counting against the attempts it already
 * used up. A human clicking "retry" on the admin dashboard is making a fresh decision to try
 * again, usually after fixing whatever was actually wrong (a bad address, an expired API key) — it
 * should get the same five attempts a brand new notification gets, not fail permanently after one.
 */
export async function retryDeadLetter(database: Database, id: string): Promise<boolean> {
  const updated = await database.db
    .update(notificationOutbox)
    .set({ status: 'queued', attempts: 0, lastError: null, nextAttemptAt: new Date() })
    .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.status, 'dead_letter')))
    .returning({ id: notificationOutbox.id });

  return updated.length > 0;
}
