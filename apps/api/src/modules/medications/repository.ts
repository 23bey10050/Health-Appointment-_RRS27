import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

import type { Database, Db, DbTransaction } from '../../db/client.js';
import { medicationReminders, users } from '../../db/schema.js';

type Executor = Db | DbTransaction;

interface ScheduledAtRow extends Record<string, unknown> {
  scheduled_at: string;
}

/**
 * Expands one drug's schedule into concrete UTC instants, one query, entirely inside Postgres.
 *
 * `startDate` and `timesOfDay` are both still "naive" - a calendar date and a set of clock times
 * with no timezone attached. `AT TIME ZONE` is what turns each `(date + time)` combination into a
 * real instant correctly, the same conversion the availability engine already relies on for the
 * same reason: Postgres's own IANA timezone database knows about daylight saving changes, so a
 * five-day course that happens to cross a DST boundary still lands on the same clock time every
 * day in the patient's own zone, not the same UTC offset.
 */
export async function expandScheduleTimes(
  db: Executor,
  input: { startDate: string; durationDays: number; timesOfDay: readonly string[]; timezone: string },
): Promise<Date[]> {
  // Drizzle's `sql` template spreads a bare JS array across several placeholders instead of
  // binding it as one array parameter the way node-postgres itself would - passed straight
  // through, a one-element array silently becomes a scalar and `unnest(...::time[])` fails to
  // parse it. A plain Postgres array-literal string sidesteps that entirely: `{08:00:00,20:00:00}`
  // is one ordinary string parameter, and `::time[]` on the Postgres side is what actually turns
  // it into an array - the values are always this function's own `HH:MM:00` output, never
  // anything with a comma or brace in it, so building the literal by hand here is safe.
  const timesOfDayLiteral = `{${input.timesOfDay.join(',')}}`;

  const result = await db.execute<ScheduledAtRow>(sql`
    SELECT
      ((${input.startDate}::date + day_offset) + time_of_day) AT TIME ZONE ${input.timezone} AS scheduled_at
    FROM generate_series(0, ${input.durationDays - 1}) AS day_offset,
         unnest(${timesOfDayLiteral}::time[]) AS time_of_day
    ORDER BY scheduled_at
  `);

  return result.rows.map((row) => new Date(row.scheduled_at));
}

export interface NewReminder {
  appointmentId: string;
  patientId: string;
  drugName: string;
  dosage: string | undefined;
  instructions: string | undefined;
  scheduledAt: Date;
}

/** Skips a row whose (appointment, drug, time) triple already exists rather than erroring - the
 *  unique constraint from the Phase 1 migration is what makes re-running this for the same
 *  prescription harmless instead of something this function has to guard against itself. */
export async function insertReminders(tx: DbTransaction, reminders: readonly NewReminder[]): Promise<void> {
  if (reminders.length === 0) {
    return;
  }
  await tx
    .insert(medicationReminders)
    .values(
      reminders.map((reminder) => ({
        appointmentId: reminder.appointmentId,
        patientId: reminder.patientId,
        drugName: reminder.drugName,
        dosage: reminder.dosage,
        instructions: reminder.instructions,
        scheduledAt: reminder.scheduledAt,
      })),
    )
    .onConflictDoNothing();
}

export async function findUserTimezone(tx: DbTransaction, userId: string): Promise<string> {
  const [row] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) {
    throw new Error(`User ${userId} was expected to exist but does not.`);
  }
  return row.timezone;
}

const DISPATCH_BATCH_SIZE = 100;

export type DueMedicationReminder = typeof medicationReminders.$inferSelect;

/** The dispatcher's own claim step - `FOR UPDATE SKIP LOCKED` so two overlapping ticks (a slow one
 *  still running when the next fires) never queue the same reminder twice, the same guarantee the
 *  outbox's own claim step relies on. */
export async function claimDueMedicationReminders(tx: DbTransaction): Promise<DueMedicationReminder[]> {
  return tx
    .select()
    .from(medicationReminders)
    .where(and(lte(medicationReminders.scheduledAt, new Date()), isNull(medicationReminders.queuedAt)))
    .orderBy(asc(medicationReminders.scheduledAt))
    .limit(DISPATCH_BATCH_SIZE)
    .for('update', { skipLocked: true });
}

export async function markReminderQueued(tx: DbTransaction, reminderId: string): Promise<void> {
  await tx
    .update(medicationReminders)
    .set({ queuedAt: new Date() })
    .where(eq(medicationReminders.id, reminderId));
}

export async function findMedicationReminderById(
  database: Database,
  reminderId: string,
): Promise<DueMedicationReminder | undefined> {
  const [row] = await database.db
    .select()
    .from(medicationReminders)
    .where(eq(medicationReminders.id, reminderId))
    .limit(1);
  return row;
}
