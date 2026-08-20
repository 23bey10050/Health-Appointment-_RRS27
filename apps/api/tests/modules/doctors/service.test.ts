import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import * as doctorService from '../../../src/modules/doctors/service.js';
import { AppError } from '../../../src/shared/errors.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
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

const NONEXISTENT_ID = '00000000-0000-4000-8000-00000000ffff';

async function expectAppError(work: Promise<unknown>, status: number, code: string): Promise<void> {
  let caught: AppError | undefined;
  try {
    await work;
  } catch (error) {
    caught = error as AppError;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught?.statusCode).toBe(status);
  expect(caught?.code).toBe(code);
}

describe('createDoctor', () => {
  it('turns a duplicate email into a 409, not a raw database error', async () => {
    const adminId = await createDoctor(database);
    const input = {
      email: 'taken@clinic.test',
      password: 'a perfectly good passphrase',
      fullName: 'First One',
      specialization: 'Cardiology',
    };
    await doctorService.createDoctor(database, input, adminId);

    await expectAppError(
      doctorService.createDoctor(database, { ...input, fullName: 'Second One' }, adminId),
      409,
      'EMAIL_ALREADY_REGISTERED',
    );
  });

  it('turns overlapping initial shifts into a 409 naming the real problem', async () => {
    const adminId = await createDoctor(database);

    await expectAppError(
      doctorService.createDoctor(
        database,
        {
          email: 'newdoc@clinic.test',
          password: 'a perfectly good passphrase',
          fullName: 'Dr New',
          specialization: 'Cardiology',
          workingHours: [
            { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
            { dayOfWeek: 1, startTime: '10:00', endTime: '13:00' },
          ],
        },
        adminId,
      ),
      409,
      'WORKING_HOURS_OVERLAP',
    );
  });
});

describe('updateDoctor', () => {
  it('404s for a doctor id that does not exist, instead of silently doing nothing', async () => {
    await expectAppError(
      doctorService.updateDoctor(database, NONEXISTENT_ID, { bio: 'anything' }),
      404,
      'NOT_FOUND',
    );
  });
});

describe('addWorkingHour', () => {
  it('404s before even trying the insert, for a doctor that does not exist', async () => {
    await expectAppError(
      doctorService.addWorkingHour(database, NONEXISTENT_ID, {
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '12:00',
      }),
      404,
      'NOT_FOUND',
    );
  });

  it('409s for a shift overlapping one the doctor already has', async () => {
    const doctorId = await createDoctor(database);
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
    ]);

    await expectAppError(
      doctorService.addWorkingHour(database, doctorId, {
        dayOfWeek: 1,
        startTime: '11:00',
        endTime: '13:00',
      }),
      409,
      'WORKING_HOURS_OVERLAP',
    );
  });
});

describe('deleteWorkingHour', () => {
  it('404s for an id that does not belong to this doctor', async () => {
    await expectAppError(
      doctorService.deleteWorkingHour(database, await createDoctor(database), NONEXISTENT_ID),
      404,
      'NOT_FOUND',
    );
  });
});

describe('addLeave / deleteLeave', () => {
  it('409s for a date already marked as leave', async () => {
    const doctorId = await createDoctor(database);
    const adminId = await createDoctor(database);
    await doctorService.addLeave(database, doctorId, { leaveDate: '2026-12-25' }, adminId);

    await expectAppError(
      doctorService.addLeave(database, doctorId, { leaveDate: '2026-12-25' }, adminId),
      409,
      'LEAVE_ALREADY_MARKED',
    );
  });

  it('404s deleting a leave id that does not belong to this doctor', async () => {
    await expectAppError(
      doctorService.deleteLeave(database, await createDoctor(database), NONEXISTENT_ID),
      404,
      'NOT_FOUND',
    );
  });
});

describe('getDoctor', () => {
  it('404s for a doctor id that does not exist', async () => {
    await expectAppError(doctorService.getDoctor(database, NONEXISTENT_ID), 404, 'NOT_FOUND');
  });

  it('still returns a deactivated doctor - only the search list hides them', async () => {
    const doctorId = await createDoctor(database, { isActive: false });

    const { doctor } = await doctorService.getDoctor(database, doctorId);

    expect(doctor.isActive).toBe(false);
  });
});

describe('getAvailability', () => {
  it('404s for a doctor id that does not exist', async () => {
    await expectAppError(
      doctorService.getAvailability(database, NONEXISTENT_ID, {
        from: '2026-09-01',
        to: '2026-09-01',
      }),
      404,
      'NOT_FOUND',
    );
  });

  it('returns an empty grid for a deactivated doctor without running the slot query at all', async () => {
    const doctorId = await createDoctor(database, { isActive: false });
    // A shift that would produce real slots if the deactivation check were skipped.
    await addWorkingHours(database, doctorId, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '17:00' },
    ]);

    const { slots } = await doctorService.getAvailability(database, doctorId, {
      from: '2026-09-01',
      to: '2026-09-01',
    });

    expect(slots).toEqual([]);
  });
});
