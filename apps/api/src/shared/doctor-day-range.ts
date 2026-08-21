import { sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../db/client.js';

interface DayRangeRow extends Record<string, unknown> {
  range_start: string;
  range_end: string;
}

/**
 * Turns "from this calendar date to that one" into the real UTC instants a doctor's own local
 * days actually start and end at — the same `AT TIME ZONE` conversion the availability engine and
 * the leave cascade both already rely on, so a doctor's schedule query and a leave day's own
 * "which appointments does this affect" question can never quietly disagree about what "that
 * day" means for someone not in UTC.
 *
 * Returns undefined for a doctor id that does not exist - unreachable in the one place this is
 * actually called (a doctor's own id, taken straight from their own access token), but a plain
 * undefined is cheaper for that caller to handle than inventing a fake time range would be.
 */
export async function resolveDoctorDayRange(
  db: Db | DbTransaction,
  doctorId: string,
  from: string,
  to: string,
): Promise<{ start: Date; end: Date } | undefined> {
  const result = await db.execute<DayRangeRow>(sql`
    SELECT
      (${from}::date AT TIME ZONE u.timezone) AS range_start,
      ((${to}::date + 1) AT TIME ZONE u.timezone) AS range_end
    FROM users u
    WHERE u.id = ${doctorId}
  `);

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return { start: new Date(row.range_start), end: new Date(row.range_end) };
}
