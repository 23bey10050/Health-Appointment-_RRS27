import { previsitSummarySchema, postvisitSummarySchema } from '@health/contracts';
import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { appointments } from '../../db/schema.js';
import { writeAuditEntry } from '../../shared/audit.js';
import { describeUnknownError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logging.js';

import { runSummaryChain, type SummaryAttempt } from './chain.js';
import { buildPostvisitPrompt, buildPrevisitPrompt, POSTVISIT_PROMPT_VERSION, PREVISIT_PROMPT_VERSION } from './prompts.js';
import type { SummaryProvider } from './provider.js';

const PREVISIT_FALLBACK_TEXT =
  "A summary could not be generated automatically. Please read the patient's own symptom notes " +
  'below before the visit.';

const POSTVISIT_FALLBACK_TEXT =
  "A plain-language summary could not be generated automatically. Please read the doctor's notes " +
  'below.';

/**
 * One audit row per attempt (Groq's first try, its retry, then Gemini), so a slow or failing
 * provider shows up in the same trail everything else in this app is already logged to.
 *
 * An empty attempt list is a real outcome, not nothing happening - it means neither AI account
 * was configured, so the chain never even tried. That still gets one row, or an admin reading the
 * audit trail for an appointment with no AI summary would see silence and have no way to tell
 * "nothing is set up" apart from a bug that swallowed every attempt without a trace.
 */
async function logAttempts(
  database: Database,
  appointmentId: string,
  action: string,
  promptVersion: string,
  attempts: readonly SummaryAttempt[],
): Promise<void> {
  if (attempts.length === 0) {
    await writeAuditEntry(database.db, {
      action,
      entityType: 'appointment',
      entityId: appointmentId,
      metadata: { promptVersion, outcome: 'no_provider_configured' },
    });
    return;
  }

  for (const attempt of attempts) {
    await writeAuditEntry(database.db, {
      action,
      entityType: 'appointment',
      entityId: appointmentId,
      metadata: { promptVersion, ...attempt },
    });
  }
}

/**
 * Runs the pre-visit triage summary and writes whatever it gets back onto the appointment row.
 *
 * Called after the booking response has already gone out to the patient - never awaited by the
 * request that triggers it. A slow or failing AI call must never make booking itself feel slow,
 * which is also why every failure here is swallowed rather than thrown: the caller is a
 * fire-and-forget `void` call, and an uncaught rejection here would otherwise reach the process's
 * top-level handler and take the whole server down over one AI summary.
 */
export async function triggerPrevisitSummary(
  database: Database,
  appointmentId: string,
  symptoms: string,
  providers: readonly SummaryProvider[],
  logger: Logger,
): Promise<void> {
  try {
    await database.db
      .update(appointments)
      .set({ aiPrevisitStatus: 'pending' })
      .where(eq(appointments.id, appointmentId));

    const result = await runSummaryChain(providers, buildPrevisitPrompt(symptoms), previsitSummarySchema);
    await logAttempts(database, appointmentId, 'previsit_summary_attempt', PREVISIT_PROMPT_VERSION, result.attempts);

    if (result.success) {
      await database.db
        .update(appointments)
        .set({
          aiPrevisitStatus: 'ready',
          aiPrevisitProvider: result.success.provider,
          aiUrgency: result.success.value.urgency,
          aiChiefComplaint: result.success.value.chiefComplaint,
          aiSuggestedQuestions: result.success.value.suggestedQuestions,
        })
        .where(eq(appointments.id, appointmentId));
      return;
    }

    await database.db
      .update(appointments)
      .set({ aiPrevisitStatus: 'unavailable', aiChiefComplaint: PREVISIT_FALLBACK_TEXT })
      .where(eq(appointments.id, appointmentId));
  } catch (error) {
    logger.error(
      { appointmentId, err: describeUnknownError(error) },
      'Pre-visit summary generation crashed',
    );
  }
}

/** Same shape as the pre-visit version above, run after a doctor submits their notes instead of
 *  after a booking. See that function's comment for why every failure here is swallowed. */
export async function triggerPostvisitSummary(
  database: Database,
  appointmentId: string,
  doctorNotes: string,
  providers: readonly SummaryProvider[],
  logger: Logger,
): Promise<void> {
  try {
    await database.db
      .update(appointments)
      .set({ aiPostvisitStatus: 'pending' })
      .where(eq(appointments.id, appointmentId));

    const result = await runSummaryChain(providers, buildPostvisitPrompt(doctorNotes), postvisitSummarySchema);
    await logAttempts(database, appointmentId, 'postvisit_summary_attempt', POSTVISIT_PROMPT_VERSION, result.attempts);

    if (result.success) {
      await database.db
        .update(appointments)
        .set({
          aiPostvisitStatus: 'ready',
          aiPostvisitProvider: result.success.provider,
          aiPostvisitSummary: result.success.value.summary,
          aiPostvisitSteps: result.success.value.followUpSteps,
        })
        .where(eq(appointments.id, appointmentId));
      return;
    }

    await database.db
      .update(appointments)
      .set({ aiPostvisitStatus: 'unavailable', aiPostvisitSummary: POSTVISIT_FALLBACK_TEXT })
      .where(eq(appointments.id, appointmentId));
  } catch (error) {
    logger.error(
      { appointmentId, err: describeUnknownError(error) },
      'Post-visit summary generation crashed',
    );
  }
}
