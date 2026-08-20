import { hashPassword } from '../shared/password.js';

import type { Database } from './client.js';
import { doctorProfiles, doctorWorkingHours, users } from './schema.js';

/**
 * Everyone seeded shares this password. It exists so a new developer can log in within seconds of
 * cloning, and the seed command refuses to run in production for exactly that reason.
 */
const SEED_PASSWORD = 'Clinic@2026';

/**
 * Fixed ids rather than random ones.
 *
 * This is what makes the seed safe to run twice: every insert can say "skip if already there", and
 * a second run changes nothing instead of creating a duplicate clinic.
 */
const ID = {
  admin: '00000000-0000-4000-8000-000000000001',
  drMehta: '00000000-0000-4000-8000-000000000010',
  drIyer: '00000000-0000-4000-8000-000000000011',
  drKhan: '00000000-0000-4000-8000-000000000012',
  patientAsha: '00000000-0000-4000-8000-000000000020',
  patientBilal: '00000000-0000-4000-8000-000000000021',
  patientChitra: '00000000-0000-4000-8000-000000000022',
} as const;

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export interface SeedSummary {
  doctors: number;
  patients: number;
  password: string;
  accounts: string[];
}

export async function seedDevelopmentData(database: Database): Promise<SeedSummary> {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  await database.transaction(async (tx) => {
    await tx
      .insert(users)
      .values([
        {
          id: ID.admin,
          email: 'admin@clinic.test',
          passwordHash,
          role: 'admin',
          fullName: 'Priya Nair',
        },
        {
          id: ID.drMehta,
          email: 'mehta@clinic.test',
          passwordHash,
          role: 'doctor',
          fullName: 'Dr Anand Mehta',
        },
        {
          id: ID.drIyer,
          email: 'iyer@clinic.test',
          passwordHash,
          role: 'doctor',
          fullName: 'Dr Lakshmi Iyer',
        },
        {
          id: ID.drKhan,
          email: 'khan@clinic.test',
          passwordHash,
          role: 'doctor',
          fullName: 'Dr Sameer Khan',
        },
        {
          id: ID.patientAsha,
          email: 'asha@example.test',
          passwordHash,
          role: 'patient',
          fullName: 'Asha Verma',
          phone: '+91 90000 00001',
        },
        {
          id: ID.patientBilal,
          email: 'bilal@example.test',
          passwordHash,
          role: 'patient',
          fullName: 'Bilal Ahmed',
          phone: '+91 90000 00002',
        },
        {
          id: ID.patientChitra,
          email: 'chitra@example.test',
          passwordHash,
          role: 'patient',
          fullName: 'Chitra Rao',
          // Deliberately in a different timezone. Medicine reminders are worked out per patient,
          // and a seed where everyone shares one zone would hide a bug in that.
          timezone: 'Europe/London',
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(doctorProfiles)
      .values([
        {
          userId: ID.drMehta,
          specialization: 'Cardiology',
          bio: 'Twenty years treating heart rhythm problems and high blood pressure.',
          slotDurationMins: 20,
          consultationFee: '800.00',
          createdBy: ID.admin,
        },
        {
          userId: ID.drIyer,
          specialization: 'Dermatology',
          bio: 'Skin, hair and allergy care for adults and children.',
          // A shorter appointment, so the availability grid is not identical for every doctor.
          slotDurationMins: 15,
          consultationFee: '600.00',
          createdBy: ID.admin,
        },
        {
          userId: ID.drKhan,
          specialization: 'General Medicine',
          bio: 'Everyday illnesses, health checks and long-term condition reviews.',
          slotDurationMins: 30,
          consultationFee: '500.00',
          createdBy: ID.admin,
        },
      ])
      .onConflictDoNothing();

    // Dr Mehta and Dr Khan work a split day with a lunch break; Dr Iyer works afternoons only.
    // Three different shapes means the slot builder gets exercised properly the first time it runs.
    const workingHours = [
      ...WEEKDAYS.flatMap((dayOfWeek) => [
        { doctorId: ID.drMehta, dayOfWeek, startTime: '09:00:00', endTime: '13:00:00' },
        { doctorId: ID.drMehta, dayOfWeek, startTime: '14:00:00', endTime: '17:00:00' },
      ]),
      ...WEEKDAYS.map((dayOfWeek) => ({
        doctorId: ID.drIyer,
        dayOfWeek,
        startTime: '13:00:00',
        endTime: '18:00:00',
      })),
      ...WEEKDAYS.flatMap((dayOfWeek) => [
        { doctorId: ID.drKhan, dayOfWeek, startTime: '10:00:00', endTime: '13:00:00' },
        { doctorId: ID.drKhan, dayOfWeek, startTime: '15:00:00', endTime: '19:00:00' },
      ]),
      // Dr Khan also covers Saturday mornings.
      { doctorId: ID.drKhan, dayOfWeek: 6, startTime: '10:00:00', endTime: '13:00:00' },
    ];

    await tx.insert(doctorWorkingHours).values(workingHours).onConflictDoNothing();
  });

  return {
    doctors: 3,
    patients: 3,
    password: SEED_PASSWORD,
    accounts: [
      'admin@clinic.test      (admin)',
      'mehta@clinic.test      (doctor, Cardiology, 20 min slots)',
      'iyer@clinic.test       (doctor, Dermatology, 15 min slots)',
      'khan@clinic.test       (doctor, General Medicine, 30 min slots)',
      'asha@example.test      (patient)',
      'bilal@example.test     (patient)',
      'chitra@example.test    (patient, Europe/London)',
    ],
  };
}
