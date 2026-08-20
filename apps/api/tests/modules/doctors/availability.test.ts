import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { appointments, slotHolds } from '../../../src/db/schema.js';
import { slotOf } from '../../../src/db/types/time-range.js';
import { findAvailableSlots } from '../../../src/modules/doctors/availability.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import {
  addLeaveDay,
  addWorkingHours,
  createDoctor,
  createPatient,
} from '../../helpers/fixtures.js';

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

/**
 * Every test below uses a doctor on UTC. Real doctors run on Asia/Kolkata (see the timezone
 * conversion test at the bottom, which pins the exact +05:30 offset this engine was built and
 * checked against in psql), but arithmetic on every other test is far easier to read without an
 * offset in the way.
 */
async function createUtcDoctor(overrides: { slotDurationMins?: number } = {}): Promise<string> {
  return createDoctor(database, {
    timezone: 'UTC',
    slotDurationMins: overrides.slotDurationMins ?? 20,
  });
}

// 2026-09-01 is a Tuesday (Postgres EXTRACT(DOW ...) = 2), confirmed against the running database
// before this suite was written. Every fixture below is built around that one fixed date so the
// day-of-week math in the query has something concrete to match.
const TUESDAY = '2026-09-01';

describe('findAvailableSlots', () => {
  it('expands a single shift into slot-duration steps', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 20 });
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '10:00' },
    ]);

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T09:20:00.000Z',
      '2026-09-01T09:40:00.000Z',
    ]);
    expect(slots[0]?.end.toISOString()).toBe('2026-09-01T09:20:00.000Z');
  });

  it('returns nothing for a doctor with no working hours at all', async () => {
    const doctorId = await createUtcDoctor();

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots).toEqual([]);
  });

  it('returns nothing for a shift shorter than one slot, rather than erroring', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 20 });
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:10' },
    ]);

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots).toEqual([]);
  });

  it('does not offer a day with no matching shift, even between two days that do have one', async () => {
    const doctorId = await createUtcDoctor();
    // Tuesday and Thursday only - Wednesday (dayOfWeek 3) is deliberately left out.
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:20' },
      { dayOfWeek: 4, startTime: '09:00', endTime: '09:20' },
    ]);

    const slots = await findAvailableSlots(database.db, doctorId, '2026-09-01', '2026-09-03');

    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-09-01T09:00:00.000Z',
      '2026-09-03T09:00:00.000Z',
    ]);
  });

  it('removes an entire day marked as leave, leaving other days untouched', async () => {
    const doctorId = await createUtcDoctor();
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:20' },
      { dayOfWeek: 3, startTime: '09:00', endTime: '09:20' },
    ]);
    await addLeaveDay(database, doctorId, TUESDAY);

    const slots = await findAvailableSlots(database.db, doctorId, '2026-09-01', '2026-09-02');

    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-09-02T09:00:00.000Z']);
  });

  it('excludes a slot that overlaps a confirmed appointment', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 20 });
    const patientId = await createPatient(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '10:00' },
    ]);
    await database.db.insert(appointments).values({
      doctorId,
      patientId,
      slot: slotOf(new Date('2026-09-01T09:20:00.000Z'), 20),
    });

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T09:40:00.000Z',
    ]);
  });

  it('does not let a cancelled appointment block its old slot', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 20 });
    const patientId = await createPatient(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:20' },
    ]);
    await database.db.insert(appointments).values({
      doctorId,
      patientId,
      status: 'cancelled',
      slot: slotOf(new Date('2026-09-01T09:00:00.000Z'), 20),
    });

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-09-01T09:00:00.000Z']);
  });

  it('excludes a slot another patient currently has on hold', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 20 });
    const patientId = await createPatient(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:40' },
    ]);
    await database.db.insert(slotHolds).values({
      doctorId,
      patientId,
      slot: slotOf(new Date('2026-09-01T09:00:00.000Z'), 20),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-09-01T09:20:00.000Z']);
  });

  it('offers a slot again once the hold on it has expired', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 20 });
    const patientId = await createPatient(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:20' },
    ]);
    await database.db.insert(slotHolds).values({
      doctorId,
      patientId,
      slot: slotOf(new Date('2026-09-01T09:00:00.000Z'), 20),
      expiresAt: new Date(Date.now() - 60_000), // already expired
    });

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-09-01T09:00:00.000Z']);
  });

  it('never offers a slot from before right now', async () => {
    const doctorId = await createUtcDoctor({ slotDurationMins: 60 });
    const today = new Date().toISOString().slice(0, 10);
    // Covers effectively the whole day, so if the "already past" filter were missing, at least one
    // slot earlier than the current hour would show up in the result.
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: new Date().getUTCDay(), startTime: '00:00', endTime: '23:00' },
    ]);

    const slots = await findAvailableSlots(database.db, doctorId, today, today);

    const now = Date.now();
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeGreaterThan(now);
    }
    // And it should not be simply "everything got filtered" - there is always at least one slot
    // left somewhere between now and 23:00 UTC, any time this suite runs before 22:00 UTC.
    expect(slots.length).toBeGreaterThan(0);
  });

  it('keeps one doctor invisible to another doctor sharing the same time and day', async () => {
    const doctorA = await createUtcDoctor({ slotDurationMins: 20 });
    const doctorB = await createUtcDoctor({ slotDurationMins: 20 });
    const patientId = await createPatient(database);
    await addWorkingHours(database, doctorA, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:20' },
    ]);
    await addWorkingHours(database, doctorB, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '09:20' },
    ]);
    await database.db.insert(appointments).values({
      doctorId: doctorA,
      patientId,
      slot: slotOf(new Date('2026-09-01T09:00:00.000Z'), 20),
    });

    const slotsForB = await findAvailableSlots(database.db, doctorB, TUESDAY, TUESDAY);

    // Doctor A being fully booked has no bearing on Doctor B's own, separate schedule.
    expect(slotsForB.map((s) => s.start.toISOString())).toEqual(['2026-09-01T09:00:00.000Z']);
  });

  it('converts a doctor-local shift into the correct UTC instant', async () => {
    // The exact case this whole query was built and hand-checked against in psql before any of
    // this module existed: a doctor on Asia/Kolkata (UTC+05:30), a 09:00-13:00 morning shift, 20
    // minute slots. 09:00 IST is 03:30 UTC.
    const doctorId = await createDoctor(database, {
      timezone: 'Asia/Kolkata',
      slotDurationMins: 20,
    });
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' },
    ]);

    const slots = await findAvailableSlots(database.db, doctorId, TUESDAY, TUESDAY);

    expect(slots).toHaveLength(12);
    expect(slots[0]?.start.toISOString()).toBe('2026-09-01T03:30:00.000Z');
    expect(slots[0]?.end.toISOString()).toBe('2026-09-01T03:50:00.000Z');
    expect(slots.at(-1)?.start.toISOString()).toBe('2026-09-01T07:10:00.000Z');
  });
});
