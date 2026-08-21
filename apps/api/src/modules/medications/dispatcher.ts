import type { Database } from '../../db/client.js';
import { queueNotification } from '../../shared/outbox.js';

import { claimDueMedicationReminders, markReminderQueued } from './repository.js';

/**
 * Decides which medication reminders are due and hands each one to the outbox - nothing more.
 *
 * Sending the actual email stays with the outbox worker built in Phase 5, exactly the same split
 * the appointment reminder scheduler already uses: this job's only responsibility is "what is due
 * right now," which keeps it small, fast, and testable without needing an email sender at all.
 */
export async function queueDueMedicationReminders(database: Database): Promise<{ queued: number }> {
  return database.transaction(async (tx) => {
    const due = await claimDueMedicationReminders(tx);

    for (const reminder of due) {
      await queueNotification(tx, {
        appointmentId: reminder.appointmentId,
        recipientId: reminder.patientId,
        channel: 'email',
        type: 'medication_reminder',
        payload: { medicationReminderId: reminder.id },
        dedupeKey: `medication_reminder:${reminder.id}`,
      });
      await markReminderQueued(tx, reminder.id);
    }

    return { queued: due.length };
  });
}
