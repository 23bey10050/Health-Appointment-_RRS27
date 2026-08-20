import { sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../db/client.js';

export interface AvailabilitySlot {
  start: Date;
  end: Date;
}

// Both fields are `string`, not `Date`, even though Postgres reports their column type as
// timestamptz. node-postgres normally parses that type into a Date automatically, but Drizzle's
// db.execute() runs outside its typed column-mapping layer and does not apply that parsing for a
// raw SQL fragment like this one — confirmed by printing the actual value that comes back, which
// is Postgres's own text format ("2026-09-01 03:30:00+00"), not a Date. Parsed into Date below, by
// hand, in exactly one place, rather than trusted at every call site.
//
// An index signature is required here too, not just the two named fields — Drizzle's
// `db.execute<T>` constrains T to Record<string, unknown> so it can check the shape at the type
// level before a single row comes back.
interface SlotRow extends Record<string, unknown> {
  slot_start: string;
  slot_end: string;
}

/**
 * The whole availability grid for one doctor, over one calendar-date range, in a single round trip
 * to Postgres.
 *
 * Reading this bottom to top mirrors how it was built and checked, by hand, in `psql`, against real
 * seeded data (a doctor on leave, a booked appointment, a live hold) before a line of this file
 * existed — the shape below is exactly what that session confirmed correct.
 *
 * `doctor`   — the one row of context every later step needs: which doctor, how long their
 *              appointments run, and which IANA zone their working hours are written in.
 * `days`     — every calendar date in the requested range, one row each.
 * `active`   — the same dates with any the doctor has marked as leave removed.
 * `shifts`   — each active date crossed with whichever working-hours rows match that date's
 *              weekday (Postgres's `EXTRACT(DOW ...)` already agrees with our `day_of_week`
 *              column: 0 is Sunday).
 * `starts`   — each shift walked forward in slot-sized steps via `generate_series`. Note this stays
 *              a plain integer count, not a time value, until the very next step — a shift shorter
 *              than one slot correctly produces `generate_series(0, -1)`, which is empty, not an
 *              error, so a five-minute shift on a twenty-minute-slot doctor just yields no slots.
 * final SELECT — converts each candidate's clock time (still doctor-local, still naive) into a
 *              real instant with `AT TIME ZONE`, drops anything already in the past, and excludes
 *              anything overlapping a live appointment or an unexpired hold using the exact same
 *              `&&` range-overlap operator the database's own exclusion constraints use — so a
 *              slot this query calls free is a slot the constraint will actually accept.
 *
 * `doctorId`/`from`/`to` are interpolated straight into the tagged template rather than bound
 * through `sql.placeholder`, which exists for prepared statements meant to run many times with
 * different values. This query runs once per call with values already validated by the caller, so
 * a prepared statement would add ceremony without a real benefit — the interpolation below is still
 * a bound parameter under the hood, never string concatenation, so it is exactly as safe.
 */
export async function findAvailableSlots(
  db: Db | DbTransaction,
  doctorId: string,
  from: string,
  to: string,
): Promise<AvailabilitySlot[]> {
  const result = await db.execute<SlotRow>(sql`
    WITH doctor AS (
      SELECT dp.user_id, dp.slot_duration_mins, u.timezone
      FROM doctor_profiles dp
      JOIN users u ON u.id = dp.user_id
      WHERE dp.user_id = ${doctorId}
    ),
    days AS (
      SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS day
    ),
    active AS (
      SELECT d.day
      FROM days d, doctor doc
      WHERE NOT EXISTS (
        SELECT 1 FROM doctor_leaves dl
        WHERE dl.doctor_id = doc.user_id AND dl.leave_date = d.day
      )
    ),
    shifts AS (
      SELECT a.day, wh.start_time, wh.end_time, doc.slot_duration_mins, doc.timezone
      FROM active a
      CROSS JOIN doctor doc
      JOIN doctor_working_hours wh
        ON wh.doctor_id = doc.user_id
       AND wh.day_of_week = EXTRACT(DOW FROM a.day)::smallint
    ),
    starts AS (
      SELECT
        (s.day + s.start_time + (n * s.slot_duration_mins) * interval '1 minute') AS local_start,
        s.slot_duration_mins,
        s.timezone
      FROM shifts s
      CROSS JOIN LATERAL generate_series(
        0,
        floor(EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / (s.slot_duration_mins * 60))::int - 1
      ) AS n
    ),
    candidates AS (
      SELECT
        (local_start AT TIME ZONE timezone) AS slot_start,
        ((local_start + slot_duration_mins * interval '1 minute') AT TIME ZONE timezone) AS slot_end
      FROM starts
    )
    SELECT c.slot_start, c.slot_end
    FROM candidates c, doctor doc
    WHERE c.slot_start > now()
      AND NOT EXISTS (
        SELECT 1 FROM appointments ap
        WHERE ap.doctor_id = doc.user_id
          AND ap.status <> 'cancelled'
          AND ap.slot && tstzrange(c.slot_start, c.slot_end, '[)')
      )
      AND NOT EXISTS (
        SELECT 1 FROM slot_holds sh
        WHERE sh.doctor_id = doc.user_id
          AND sh.expires_at > now()
          AND sh.slot && tstzrange(c.slot_start, c.slot_end, '[)')
      )
    ORDER BY c.slot_start
  `);

  return result.rows.map((row) => ({
    start: new Date(row.slot_start),
    end: new Date(row.slot_end),
  }));
}
