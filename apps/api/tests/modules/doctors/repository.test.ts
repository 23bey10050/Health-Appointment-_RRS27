import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { users } from '../../../src/db/schema.js';
import * as repository from '../../../src/modules/doctors/repository.js';
import {
  createTestDatabase,
  EXCLUSION_VIOLATION,
  resetDatabase,
  sqlStateOf,
  UNIQUE_VIOLATION,
} from '../../helpers/database.js';
import { addWorkingHours, createDoctor } from '../../helpers/fixtures.js';

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

const baseInput = {
  email: 'newdoc@clinic.test',
  password: 'a perfectly good passphrase',
  fullName: 'Dr New Comer',
  specialization: 'Pediatrics',
} as const;

describe('createDoctor', () => {
  it('creates the login and the profile together', async () => {
    const { doctor } = await repository.createDoctor(
      database,
      baseInput,
      await createDoctor(database),
    );

    expect(doctor.fullName).toBe('Dr New Comer');
    expect(doctor.specialization).toBe('Pediatrics');
    expect(doctor.isActive).toBe(true);

    const [account] = await database.db
      .select()
      .from(users)
      .where(eq(users.email, baseInput.email));
    expect(account?.role).toBe('doctor');
  });

  it('creates the first week of shifts in the same call, and returns them', async () => {
    const { workingHours } = await repository.createDoctor(
      database,
      { ...baseInput, workingHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }] },
      await createDoctor(database),
    );

    expect(workingHours).toHaveLength(1);
    expect(workingHours[0]).toMatchObject({
      dayOfWeek: 1,
      startTime: '09:00:00',
      endTime: '12:00:00',
    });
  });

  it('refuses a second doctor on the same email', async () => {
    const adminId = await createDoctor(database);
    await repository.createDoctor(database, baseInput, adminId);

    await expect(repository.createDoctor(database, baseInput, adminId)).rejects.toSatisfy(
      (error: unknown) => sqlStateOf(error) === UNIQUE_VIOLATION,
    );
  });

  it('creates nothing at all when the initial shifts overlap each other', async () => {
    const adminId = await createDoctor(database);

    await expect(
      repository.createDoctor(
        database,
        {
          ...baseInput,
          workingHours: [
            { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
            { dayOfWeek: 1, startTime: '11:00', endTime: '15:00' },
          ],
        },
        adminId,
      ),
    ).rejects.toSatisfy((error: unknown) => sqlStateOf(error) === EXCLUSION_VIOLATION);

    // The whole thing is one transaction - not even the user account should have survived.
    const rows = await database.db.select().from(users).where(eq(users.email, baseInput.email));
    expect(rows).toHaveLength(0);
  });
});

describe('updateDoctor', () => {
  it('changes only the fields given', async () => {
    const doctorId = await createDoctor(database, { specialization: 'General Medicine' });

    const updated = await repository.updateDoctor(database, doctorId, {
      bio: 'Twenty years in practice.',
    });

    expect(updated?.bio).toBe('Twenty years in practice.');
    expect(updated?.specialization).toBe('General Medicine');
  });

  it('toggles isActive on the users table, not the profile table', async () => {
    const doctorId = await createDoctor(database);

    const updated = await repository.updateDoctor(database, doctorId, { isActive: false });

    expect(updated?.isActive).toBe(false);
  });

  it('returns undefined for a doctor id that does not exist', async () => {
    const updated = await repository.updateDoctor(
      database,
      '00000000-0000-4000-8000-00000000ffff',
      {
        bio: 'anything',
      },
    );

    expect(updated).toBeUndefined();
  });
});

describe('listDoctors', () => {
  it('paginates and reports the true total, not just the page size', async () => {
    for (let i = 0; i < 5; i += 1) {
      await createDoctor(database, { specialization: 'Dermatology' });
    }

    const page1 = await repository.listDoctors(database, {
      specialization: 'Dermatology',
      page: 1,
      pageSize: 2,
    });
    const page2 = await repository.listDoctors(database, {
      specialization: 'Dermatology',
      page: 2,
      pageSize: 2,
    });

    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.items[0]?.id).not.toBe(page2.items[0]?.id);
  });

  it('matches specialization regardless of capitalisation', async () => {
    await createDoctor(database, { specialization: 'Cardiology' });

    const result = await repository.listDoctors(database, {
      specialization: 'CARDIOLOGY',
      page: 1,
      pageSize: 20,
    });

    expect(result.total).toBe(1);
  });

  it('never returns a deactivated doctor', async () => {
    await createDoctor(database, { specialization: 'Oncology', isActive: false });

    const result = await repository.listDoctors(database, {
      specialization: 'Oncology',
      page: 1,
      pageSize: 20,
    });

    expect(result.total).toBe(0);
  });
});

describe('working hours', () => {
  it('lists shifts sorted by day then time', async () => {
    const doctorId = await createDoctor(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 3, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    ]);

    const rows = await repository.listWorkingHours(database.db, doctorId);

    expect(rows.map((r) => [r.dayOfWeek, r.startTime])).toEqual([
      [1, '09:00:00'],
      [1, '14:00:00'],
      [3, '09:00:00'],
    ]);
  });

  it('only deletes a shift that actually belongs to the named doctor', async () => {
    const doctorA = await createDoctor(database);
    const doctorB = await createDoctor(database);
    const shift = await repository.addWorkingHour(database, doctorA, {
      dayOfWeek: 1,
      startTime: '09:00',
      endTime: '12:00',
    });

    // doctorB's id is right in shape but wrong in fact - it is not who this shift belongs to, so
    // the delete should silently match zero rows rather than removing doctorA's shift by accident.
    const deletedUsingWrongDoctor = await repository.deleteWorkingHour(database, doctorB, shift.id);
    const deletedUsingRightDoctor = await repository.deleteWorkingHour(database, doctorA, shift.id);

    expect(deletedUsingWrongDoctor).toBe(false);
    expect(deletedUsingRightDoctor).toBe(true);
  });

  it('reports false, not an error, when the id simply does not exist', async () => {
    const doctorId = await createDoctor(database);

    const deleted = await repository.deleteWorkingHour(
      database,
      doctorId,
      '00000000-0000-4000-8000-00000000ffff',
    );

    expect(deleted).toBe(false);
  });
});

describe('leaves', () => {
  it('adds and lists a leave day', async () => {
    const doctorId = await createDoctor(database);
    const adminId = await createDoctor(database);

    await database.transaction((tx) =>
      repository.addLeave(tx, doctorId, { leaveDate: '2026-12-25', reason: 'Holiday' }, adminId),
    );
    const leaves = await repository.listLeaves(database, doctorId);

    expect(leaves).toEqual([
      { id: expect.any(String), leaveDate: '2026-12-25', reason: 'Holiday' },
    ]);
  });

  it('refuses a second leave row for the same doctor and date', async () => {
    const doctorId = await createDoctor(database);
    const adminId = await createDoctor(database);
    await database.transaction((tx) =>
      repository.addLeave(tx, doctorId, { leaveDate: '2026-12-25' }, adminId),
    );

    await expect(
      database.transaction((tx) =>
        repository.addLeave(tx, doctorId, { leaveDate: '2026-12-25' }, adminId),
      ),
    ).rejects.toSatisfy((error: unknown) => sqlStateOf(error) === UNIQUE_VIOLATION);
  });

  it('only deletes a leave that actually belongs to the named doctor', async () => {
    const doctorA = await createDoctor(database);
    const doctorB = await createDoctor(database);
    const adminId = await createDoctor(database);
    const leave = await database.transaction((tx) =>
      repository.addLeave(tx, doctorA, { leaveDate: '2026-12-25' }, adminId),
    );

    const deletedUsingWrongDoctor = await repository.deleteLeave(database, doctorB, leave.id);
    const deletedUsingRightDoctor = await repository.deleteLeave(database, doctorA, leave.id);

    expect(deletedUsingWrongDoctor).toBe(false);
    expect(deletedUsingRightDoctor).toBe(true);
  });
});
