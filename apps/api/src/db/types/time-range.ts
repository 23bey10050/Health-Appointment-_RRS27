import { customType } from 'drizzle-orm/pg-core';

/** A booking window: starts at `start`, runs up to but not including `end`. */
export interface TimeRange {
  start: Date;
  end: Date;
}

/**
 * Postgres writes a range as `["2026-09-01 10:00:00+00","2026-09-01 10:20:00+00")`. The trailing
 * `)` is the important character: it means the end instant belongs to the *next* slot, which is
 * exactly why a 10:00-10:20 and a 10:20-10:40 appointment do not count as overlapping.
 */
const RANGE_PATTERN = /^\[([^,]+),([^)\]]+)\)$/;

/**
 * Turns a range into the text Postgres expects.
 *
 * The three checks are not ceremony. A range built from an invalid Date would be written as the
 * literal text "Invalid Date", and Postgres would reject it with an error naming the column but not
 * the reason — a confusing five minutes at exactly the wrong moment.
 */
export function serializeTimeRange(value: TimeRange): string {
  if (!(value.start instanceof Date) || !(value.end instanceof Date)) {
    throw new TypeError('A time range needs a start and an end Date.');
  }
  if (Number.isNaN(value.start.getTime()) || Number.isNaN(value.end.getTime())) {
    throw new TypeError('A time range cannot be built from an invalid Date.');
  }
  if (value.end <= value.start) {
    throw new RangeError('A time range must end after it starts.');
  }

  return `[${value.start.toISOString()},${value.end.toISOString()})`;
}

/** Turns the text Postgres sends back into two Dates. */
export function parseTimeRange(value: string): TimeRange {
  const match = RANGE_PATTERN.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new TypeError(`Postgres returned a time range this code cannot read: ${value}`);
  }

  const start = new Date(stripQuotes(match[1]));
  const end = new Date(stripQuotes(match[2]));

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new TypeError(`Postgres returned a time range with an unreadable date: ${value}`);
  }

  return { start, end };
}

/**
 * Teaches Drizzle to speak `tstzrange`.
 *
 * Drizzle has no built-in range type, and node-postgres hands ranges back as a raw string. Without
 * this, every query touching a slot would be parsing text by hand at the call site. The real work
 * lives in the two functions above so it can be tested directly rather than through a column.
 */
export const tstzrange = customType<{ data: TimeRange; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
  toDriver: serializeTimeRange,
  fromDriver: parseTimeRange,
});

function stripQuotes(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

/** Builds a range from a start time and a length in minutes, the way every slot is defined. */
export function slotOf(start: Date, durationMinutes: number): TimeRange {
  if (durationMinutes <= 0) {
    throw new RangeError('A slot must be at least one minute long.');
  }
  return { start, end: new Date(start.getTime() + durationMinutes * 60_000) };
}
