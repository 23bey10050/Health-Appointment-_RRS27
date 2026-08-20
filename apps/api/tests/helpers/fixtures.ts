import type { Database } from '../../src/db/client.js';
import { doctorProfiles, users } from '../../src/db/schema.js';
import { slotOf, type TimeRange } from '../../src/db/types/time-range.js';

let sequence = 0;

/** Unique per call, so two fixtures in one test never collide on the email unique constraint. */
function nextSuffix(): number {
  sequence += 1;
  return sequence;
}

export async function createPatient(
  database: Database,
  overrides: { fullName?: string; timezone?: string } = {},
): Promise<string> {
  const suffix = nextSuffix();
  const [row] = await database.db
    .insert(users)
    .values({
      email: `patient${suffix}@example.test`,
      // Not a real hash. Nothing in these tests logs in, and running argon2 for every fixture
      // would make the suite slow for no benefit.
      passwordHash: 'not-a-real-hash',
      role: 'patient',
      fullName: overrides.fullName ?? `Patient ${suffix}`,
      ...(overrides.timezone ? { timezone: overrides.timezone } : {}),
    })
    .returning({ id: users.id });

  if (!row) {
    throw new Error('Could not create the patient fixture.');
  }
  return row.id;
}

export async function createDoctor(
  database: Database,
  overrides: { specialization?: string; slotDurationMins?: number } = {},
): Promise<string> {
  const suffix = nextSuffix();
  const [user] = await database.db
    .insert(users)
    .values({
      email: `doctor${suffix}@clinic.test`,
      passwordHash: 'not-a-real-hash',
      role: 'doctor',
      fullName: `Doctor ${suffix}`,
    })
    .returning({ id: users.id });

  if (!user) {
    throw new Error('Could not create the doctor fixture.');
  }

  await database.db.insert(doctorProfiles).values({
    userId: user.id,
    specialization: overrides.specialization ?? 'General Medicine',
    slotDurationMins: overrides.slotDurationMins ?? 20,
  });

  return user.id;
}

/**
 * A slot on a fixed future date.
 *
 * Fixed rather than relative to now, because a test that books "in one hour" quietly changes what
 * it is testing depending on when it runs.
 */
export function slotAt(hour: number, minute = 0, durationMinutes = 20): TimeRange {
  return slotOf(new Date(Date.UTC(2026, 8, 1, hour, minute, 0, 0)), durationMinutes);
}
