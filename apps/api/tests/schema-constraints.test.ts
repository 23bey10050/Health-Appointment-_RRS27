import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { appointments, doctorWorkingHours, slotHolds, users } from '../src/db/schema.js';

import {
  createTestDatabase,
  EXCLUSION_VIOLATION,
  resetDatabase,
  sqlStateOf,
  UNIQUE_VIOLATION,
} from './helpers/database.js';
import { createDoctor, createPatient, slotAt } from './helpers/fixtures.js';

let database: Database;
let doctorId: string;
let patientA: string;
let patientB: string;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
  doctorId = await createDoctor(database);
  patientA = await createPatient(database);
  patientB = await createPatient(database);
});

function book(patientId: string, slot: ReturnType<typeof slotAt>) {
  return database.db.insert(appointments).values({ patientId, doctorId, slot });
}

describe('the double-booking guarantee', () => {
  it('rejects a second appointment in exactly the same slot', async () => {
    await book(patientA, slotAt(10));

    await expect(book(patientB, slotAt(10))).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION,
    );
  });

  it('rejects a partial overlap, not just an exact match', async () => {
    await book(patientA, slotAt(10, 0, 20));

    // Starts ten minutes into the first appointment. A plain unique key on the start time would
    // have let this through, which is the whole reason the constraint uses ranges.
    await expect(book(patientB, slotAt(10, 10, 20))).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION,
    );
  });

  it('rejects an appointment that completely swallows an existing one', async () => {
    await book(patientA, slotAt(10, 0, 20));

    await expect(book(patientB, slotAt(9, 30, 90))).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION,
    );
  });

  it('allows back-to-back appointments that only touch at the boundary', async () => {
    await book(patientA, slotAt(10, 0, 20));

    // 10:20 is where the first one ends. The range is written as [start, end), so the end instant
    // belongs to the next slot and these two do not count as overlapping.
    await expect(book(patientB, slotAt(10, 20, 20))).resolves.toBeDefined();
  });

  it('lets a different doctor use the same time', async () => {
    const otherDoctorId = await createDoctor(database);
    await book(patientA, slotAt(10));

    await expect(
      database.db
        .insert(appointments)
        .values({ patientId: patientB, doctorId: otherDoctorId, slot: slotAt(10) }),
    ).resolves.toBeDefined();
  });

  it('frees the slot the moment an appointment is cancelled', async () => {
    await book(patientA, slotAt(10));
    await database.db.update(appointments).set({ status: 'cancelled' });

    await expect(book(patientB, slotAt(10))).resolves.toBeDefined();
  });

  it('still blocks the slot for a completed or missed appointment', async () => {
    await book(patientA, slotAt(10));
    await database.db.update(appointments).set({ status: 'no_show' });

    // A patient who did not turn up still used that slot. Only a cancellation gives it back.
    await expect(book(patientB, slotAt(10))).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION,
    );
  });

  it('holds the line when many bookings arrive at the same instant', async () => {
    const attempts = 20;

    // All twenty are sent before any of them is awaited, so they genuinely race inside Postgres
    // rather than queueing politely one after another.
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => book(patientA, slotAt(11))),
    );

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(attempts - 1);
    // Every loser must fail for the right reason. A deadlock or a timeout would also show up as a
    // rejection, and that would mean the guarantee held by luck rather than by design.
    for (const failure of lost) {
      expect(sqlStateOf(failure.reason)).toBe(EXCLUSION_VIOLATION);
    }
  });
});

describe('slot holds', () => {
  it('lets only one patient hold a slot', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await database.db
      .insert(slotHolds)
      .values({ doctorId, patientId: patientA, slot: slotAt(14), expiresAt });

    await expect(
      database.db
        .insert(slotHolds)
        .values({ doctorId, patientId: patientB, slot: slotAt(14), expiresAt }),
    ).rejects.toSatisfy((error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION);
  });

  it('frees the slot once the stale hold is deleted', async () => {
    const alreadyExpired = new Date(Date.now() - 60_000);
    await database.db
      .insert(slotHolds)
      .values({ doctorId, patientId: patientA, slot: slotAt(14), expiresAt: alreadyExpired });

    // An expired hold still occupies the slot until something removes it. The constraint cannot
    // read the clock, so clearing stale rows is the booking flow's job, not the database's.
    await database.pool.query('DELETE FROM slot_holds WHERE expires_at <= now()');

    await expect(
      database.db.insert(slotHolds).values({
        doctorId,
        patientId: patientB,
        slot: slotAt(14),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      }),
    ).resolves.toBeDefined();
  });
});

describe('doctor working hours', () => {
  it('refuses two overlapping shifts on the same weekday', async () => {
    await database.db
      .insert(doctorWorkingHours)
      .values({ doctorId, dayOfWeek: 1, startTime: '09:00:00', endTime: '12:00:00' });

    await expect(
      database.db
        .insert(doctorWorkingHours)
        .values({ doctorId, dayOfWeek: 1, startTime: '11:00:00', endTime: '15:00:00' }),
    ).rejects.toSatisfy((error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION);
  });

  it('allows a morning and an afternoon shift that meet at lunch', async () => {
    await database.db
      .insert(doctorWorkingHours)
      .values({ doctorId, dayOfWeek: 1, startTime: '09:00:00', endTime: '13:00:00' });

    await expect(
      database.db
        .insert(doctorWorkingHours)
        .values({ doctorId, dayOfWeek: 1, startTime: '13:00:00', endTime: '17:00:00' }),
    ).resolves.toBeDefined();
  });

  it('allows the same hours on a different weekday', async () => {
    await database.db
      .insert(doctorWorkingHours)
      .values({ doctorId, dayOfWeek: 1, startTime: '09:00:00', endTime: '12:00:00' });

    await expect(
      database.db
        .insert(doctorWorkingHours)
        .values({ doctorId, dayOfWeek: 2, startTime: '09:00:00', endTime: '12:00:00' }),
    ).resolves.toBeDefined();
  });
});

describe('user accounts', () => {
  it('treats an email as the same address whatever the capitals', async () => {
    await database.db.insert(users).values({
      email: 'Ravi.Kumar@Clinic.test',
      passwordHash: 'not-a-real-hash',
      role: 'patient',
      fullName: 'Ravi Kumar',
    });

    await expect(
      database.db.insert(users).values({
        email: 'ravi.kumar@clinic.test',
        passwordHash: 'not-a-real-hash',
        role: 'patient',
        fullName: 'Someone Else',
      }),
    ).rejects.toSatisfy((error: unknown) => sqlStateOf(error) === UNIQUE_VIOLATION);
  });

  it('finds a user by an email typed in the wrong case', async () => {
    await database.db.insert(users).values({
      email: 'Meera@Clinic.test',
      passwordHash: 'not-a-real-hash',
      role: 'patient',
      fullName: 'Meera Pillai',
    });

    const { rowCount } = await database.pool.query('SELECT 1 FROM users WHERE email = $1', [
      'MEERA@CLINIC.TEST',
    ]);

    expect(rowCount).toBe(1);
  });
});
