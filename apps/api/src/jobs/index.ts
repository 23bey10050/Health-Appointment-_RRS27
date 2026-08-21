import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import { buildCalendarSync } from '../modules/calendar/sync.js';
import { queueDueMedicationReminders } from '../modules/medications/dispatcher.js';
import { drainOutboxOnce } from '../modules/notifications/worker.js';
import { queueDueReminders } from '../modules/notifications/reminders.js';
import { BrevoEmailSender } from '../providers/brevo.js';
import { ConsoleEmailSender, type EmailSender } from '../shared/email.js';
import type { Logger } from '../shared/logging.js';
import { startScheduler, type RunningScheduler } from '../shared/scheduler.js';

const OUTBOX_DRAIN_INTERVAL_MS = 20_000;
const REMINDER_SCHEDULER_INTERVAL_MS = 5 * 60_000;
const MEDICATION_DISPATCH_INTERVAL_MS = 5 * 60_000;

/** Picks the real sender when there is an account to send through, and the one that prints to the
 *  console otherwise — the switch this whole abstraction exists for. */
export function buildEmailSender(config: AppConfig, logger: Logger): EmailSender {
  if (config.email.brevoApiKey && config.email.senderEmail) {
    return new BrevoEmailSender(
      config.email.brevoApiKey,
      config.email.senderEmail,
      config.email.senderName,
    );
  }
  return new ConsoleEmailSender(logger);
}

/**
 * Starts the two background jobs this phase adds, inside the same process as the HTTP server —
 * never inside `buildServer` itself, so a test building a server with `inject()` never also spins
 * up a live 20-second interval touching the real outbox table underneath it.
 */
export function startBackgroundJobs(
  database: Database,
  config: AppConfig,
  sender: EmailSender,
  logger: Logger,
): RunningScheduler {
  const calendarSync = buildCalendarSync(database, config);

  return startScheduler(
    [
      {
        name: 'outbox-drain',
        intervalMs: OUTBOX_DRAIN_INTERVAL_MS,
        run: async () => {
          await drainOutboxOnce(database, sender, calendarSync, logger);
        },
      },
      {
        name: 'reminder-scheduler',
        intervalMs: REMINDER_SCHEDULER_INTERVAL_MS,
        run: async () => {
          await queueDueReminders(database);
        },
      },
      {
        name: 'medication-reminder-dispatcher',
        intervalMs: MEDICATION_DISPATCH_INTERVAL_MS,
        run: async () => {
          await queueDueMedicationReminders(database);
        },
      },
    ],
    logger,
  );
}
