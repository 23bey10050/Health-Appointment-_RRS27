import type { PrescriptionItem } from '@health/contracts';

import type { DbTransaction } from '../../db/client.js';

import { expandScheduleTimes, insertReminders, type NewReminder } from './repository.js';
import { timesOfDayFor } from './schedule.js';

/** "Today" in the patient's own timezone, as a plain calendar date - the first dose of a freshly
 *  written prescription starts from whichever local day it is right now for the patient, not the
 *  server's own UTC day, which could already be tomorrow for someone west of it. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

/**
 * Turns a doctor's prescription into concrete medication_reminders rows.
 *
 * Runs inside the same transaction `submitNotes` already uses to write the prescription itself -
 * a visit whose notes were saved but whose reminders silently failed to schedule is a worse state
 * than either succeeding together, and there is nothing slow or external here to justify splitting
 * it into two steps the way an actual email send is.
 */
export async function scheduleMedicationReminders(
  tx: DbTransaction,
  input: {
    appointmentId: string;
    patientId: string;
    patientTimezone: string;
    prescription: readonly PrescriptionItem[];
  },
): Promise<void> {
  const startDate = todayIn(input.patientTimezone);

  for (const item of input.prescription) {
    const scheduledTimes = await expandScheduleTimes(tx, {
      startDate,
      durationDays: item.durationDays,
      timesOfDay: timesOfDayFor(item.timesPerDay),
      timezone: input.patientTimezone,
    });

    const reminders: NewReminder[] = scheduledTimes.map((scheduledAt) => ({
      appointmentId: input.appointmentId,
      patientId: input.patientId,
      drugName: item.drug,
      dosage: item.dosage,
      instructions: item.instructions,
      scheduledAt,
    }));
    await insertReminders(tx, reminders);
  }
}
