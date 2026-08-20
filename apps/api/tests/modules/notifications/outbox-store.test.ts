import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { notificationOutbox } from '../../../src/db/schema.js';
import {
  claimDueNotifications,
  listDeadLetters,
  markFailed,
  markSent,
  retryDeadLetter,
  type OutboxRow,
} from '../../../src/modules/notifications/outbox-store.js';
import { queueNotification } from '../../../src/shared/outbox.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createPatient } from '../../helpers/fixtures.js';

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

async function queueOne(overrides: { dedupeKey?: string } = {}): Promise<string> {
  const patientId = await createPatient(database);
  await queueNotification(database.db, {
    recipientId: patientId,
    channel: 'email',
    type: 'booking_confirmation',
    payload: {},
    dedupeKey: overrides.dedupeKey,
  });
  const [row] = await database.db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.recipientId, patientId));
  if (!row) throw new Error('fixture insert failed');
  return row.id;
}

async function fetchRow(id: string): Promise<OutboxRow> {
  const [row] = await database.db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, id));
  if (!row) throw new Error(`row ${id} not found`);
  return row;
}

describe('claimDueNotifications', () => {
  it('claims a freshly queued row', async () => {
    await queueOne();

    const claimed = await claimDueNotifications(database);

    expect(claimed).toHaveLength(1);
  });

  it('does not claim a row whose next_attempt_at is still in the future', async () => {
    const id = await queueOne();
    await database.db
      .update(notificationOutbox)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(notificationOutbox.id, id));

    const claimed = await claimDueNotifications(database);

    expect(claimed).toHaveLength(0);
  });

  it('does not claim a sent or dead-lettered row', async () => {
    const sentId = await queueOne();
    await markSent(database, sentId);
    const deadId = await queueOne();
    await database.db
      .update(notificationOutbox)
      .set({ status: 'dead_letter' })
      .where(eq(notificationOutbox.id, deadId));

    const claimed = await claimDueNotifications(database);

    expect(claimed).toHaveLength(0);
  });

  it('protects a claimed row from being claimed again immediately', async () => {
    await queueOne();

    const firstClaim = await claimDueNotifications(database);
    const secondClaim = await claimDueNotifications(database);

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(0);
  });

  it('claims oldest first', async () => {
    const first = await queueOne();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await queueOne();

    const claimed = await claimDueNotifications(database);

    expect(claimed.map((row) => row.id)).toEqual([first, second]);
  });
});

describe('markSent', () => {
  it('marks the row sent and records when', async () => {
    const id = await queueOne();

    await markSent(database, id);

    const row = await fetchRow(id);
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
  });

  it('clears any previous error', async () => {
    const id = await queueOne();
    await markFailed(database, await fetchRow(id), 'a transient problem');

    await markSent(database, id);

    const row = await fetchRow(id);
    expect(row.lastError).toBeNull();
  });
});

describe('markFailed', () => {
  it('schedules a retry with growing backoff, one attempt at a time', async () => {
    const id = await queueOne();
    let row = await fetchRow(id);

    await markFailed(database, row, 'first failure');
    row = await fetchRow(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    const firstDelayMs = row.nextAttemptAt.getTime() - Date.now();
    expect(firstDelayMs).toBeGreaterThan(50_000);
    expect(firstDelayMs).toBeLessThan(70_000); // ~60s: min(2^1 * 30, 1800)

    await markFailed(database, row, 'second failure');
    row = await fetchRow(id);
    expect(row.attempts).toBe(2);
    const secondDelayMs = row.nextAttemptAt.getTime() - Date.now();
    expect(secondDelayMs).toBeGreaterThan(110_000);
    expect(secondDelayMs).toBeLessThan(130_000); // ~120s: min(2^2 * 30, 1800)
  });

  it('records the error message on every failed attempt', async () => {
    const id = await queueOne();
    const row = await fetchRow(id);

    await markFailed(database, row, 'Brevo did not like this one');

    const updated = await fetchRow(id);
    expect(updated.lastError).toBe('Brevo did not like this one');
  });

  it('moves to dead_letter once max_attempts is used up, not before', async () => {
    const id = await queueOne();
    let row = await fetchRow(id);

    // maxAttempts defaults to 5 - four failures still leaves it retryable.
    for (let i = 0; i < 4; i += 1) {
      await markFailed(database, row, `failure ${i + 1}`);
      row = await fetchRow(id);
      expect(row.status).toBe('failed');
    }

    await markFailed(database, row, 'failure 5');
    row = await fetchRow(id);
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(5);
  });

  it('caps the backoff rather than letting it grow forever', async () => {
    const id = await queueOne();
    let row = await fetchRow(id);
    // Push attempts up manually to check the cap kicks in well before it would naturally.
    await database.db
      .update(notificationOutbox)
      .set({ attempts: 10, maxAttempts: 20 })
      .where(eq(notificationOutbox.id, id));
    row = await fetchRow(id);

    await markFailed(database, row, 'still failing');

    const updated = await fetchRow(id);
    const delayMs = updated.nextAttemptAt.getTime() - Date.now();
    // 30 minutes, not 2^11 * 30s (which would be many hours).
    expect(delayMs).toBeLessThanOrEqual(30 * 60_000 + 5000);
  });
});

describe('listDeadLetters', () => {
  it('lists only dead-lettered rows, oldest first', async () => {
    const queuedId = await queueOne();
    const deadId = await queueOne();
    await database.db
      .update(notificationOutbox)
      .set({ status: 'dead_letter' })
      .where(eq(notificationOutbox.id, deadId));

    const rows = await listDeadLetters(database);

    expect(rows.map((row) => row.id)).toEqual([deadId]);
    expect(rows.map((row) => row.id)).not.toContain(queuedId);
  });
});

describe('retryDeadLetter', () => {
  it('resets a dead-lettered row to a fresh queued state', async () => {
    const id = await queueOne();
    await database.db
      .update(notificationOutbox)
      .set({ status: 'dead_letter', attempts: 5, lastError: 'gave up' })
      .where(eq(notificationOutbox.id, id));

    const retried = await retryDeadLetter(database, id);

    expect(retried).toBe(true);
    const row = await fetchRow(id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
  });

  it('does nothing to a row that is not dead-lettered', async () => {
    const id = await queueOne();

    const retried = await retryDeadLetter(database, id);

    expect(retried).toBe(false);
    const row = await fetchRow(id);
    expect(row.status).toBe('queued');
  });

  it('reports false for an id that does not exist', async () => {
    const retried = await retryDeadLetter(database, '00000000-0000-4000-8000-00000000ffff');

    expect(retried).toBe(false);
  });
});
