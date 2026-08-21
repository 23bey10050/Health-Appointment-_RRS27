import type { NotificationType } from '@health/contracts';

import type { RenderContext } from './render-context.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type NotificationSide = 'patient' | 'doctor';

function formatSlotTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** Just the date, for a subject line — "Tuesday, September 1" reads better in an inbox list than
 *  the full date-and-time `formatSlotTime` gives the message body. */
function formatSlotDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/**
 * A plain wrapper, not a designed template. Inline styles because many email clients strip a
 * `<style>` block entirely, and a notification like this earns its keep by being clear and quick
 * to read, not by looking like a marketing email.
 */
function wrapHtml(paragraphs: readonly string[]): string {
  const body = paragraphs
    .map((paragraph) => `<p style="margin: 0 0 12px;">${paragraph}</p>`)
    .join('');
  return `<div style="font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 15px; color: #1a1a1a; max-width: 480px;">${body}</div>`;
}

function wrapText(paragraphs: readonly string[]): string {
  return paragraphs.join('\n\n');
}

function bookingConfirmationForPatient(ctx: RenderContext): RenderedEmail {
  const time = formatSlotTime(ctx.slot.start, ctx.patientTimezone);
  const lines = [
    `Hi ${ctx.patientName},`,
    `Your appointment with ${ctx.doctorName} (${ctx.doctorSpecialization}) is confirmed for ${time}.`,
    `If anything changes, you can cancel it from your account any time before then.`,
  ];
  return {
    subject: `Your appointment with ${ctx.doctorName} is confirmed`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

function bookingConfirmationForDoctor(ctx: RenderContext): RenderedEmail {
  const time = formatSlotTime(ctx.slot.start, ctx.doctorTimezone);
  const lines = [
    `Hi ${ctx.doctorName},`,
    `You have a new appointment with ${ctx.patientName} on ${time}.`,
  ];
  return {
    subject: `New appointment: ${ctx.patientName} on ${formatSlotDate(ctx.slot.start, ctx.doctorTimezone)}`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

function cancellationForPatient(ctx: RenderContext): RenderedEmail {
  const time = formatSlotTime(ctx.slot.start, ctx.patientTimezone);
  const lines = [
    `Hi ${ctx.patientName},`,
    `Your appointment with ${ctx.doctorName} on ${time} has been cancelled.` +
      (ctx.cancellationReason ? ` Reason given: ${ctx.cancellationReason}` : ''),
    `You can book a new appointment any time.`,
  ];
  return {
    subject: `Your appointment with ${ctx.doctorName} has been cancelled`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

function cancellationForDoctor(ctx: RenderContext): RenderedEmail {
  const time = formatSlotTime(ctx.slot.start, ctx.doctorTimezone);
  const lines = [
    `Hi ${ctx.doctorName},`,
    `The appointment with ${ctx.patientName} on ${time} has been cancelled.` +
      (ctx.cancellationReason ? ` Reason given: ${ctx.cancellationReason}` : ''),
    `That slot is open again.`,
  ];
  return {
    subject: `Appointment cancelled: ${ctx.patientName}`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

/** Reminders only ever go to the patient — a doctor's own schedule is their reminder. */
function reminder(ctx: RenderContext, howSoon: string): RenderedEmail {
  const time = formatSlotTime(ctx.slot.start, ctx.patientTimezone);
  const lines = [
    `Hi ${ctx.patientName},`,
    `This is a reminder that you have an appointment with ${ctx.doctorName} ${howSoon}, on ${time}.`,
  ];
  return {
    subject: `Reminder: your appointment is ${howSoon}`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

/** A leave-triggered cancellation, worded differently from `cancellationForPatient` on purpose -
 *  the patient did not choose this, the doctor's own availability did, and the copy says so
 *  instead of reading like the patient cancelled their own visit. The leave's own reason (if an
 *  admin gave one) stays out of this - it is internal clinic record-keeping, not something owed
 *  to the patient, who only needs to know the appointment is no longer happening and why in the
 *  broadest sense. */
function leaveConflictForPatient(ctx: RenderContext): RenderedEmail {
  const time = formatSlotTime(ctx.slot.start, ctx.patientTimezone);
  const lines = [
    `Hi ${ctx.patientName},`,
    `Your appointment with ${ctx.doctorName} on ${time} has had to be cancelled - ${ctx.doctorName} is unavailable that day.`,
    `You can book a new appointment with ${ctx.doctorName} any time.`,
  ];
  return {
    subject: `Your appointment with ${ctx.doctorName} needs to be rebooked`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

export interface MedicationReminderDetails {
  drugName: string;
  dosage: string | null;
  instructions: string | null;
}

/** Always the patient's own reminder - nobody else's medication schedule is this app's business
 *  to send. Kept out of `renderNotification` below because it needs more than a `RenderContext`
 *  can carry: which specific drug and dose this one reminder is about. */
export function renderMedicationReminder(
  ctx: RenderContext,
  medication: MedicationReminderDetails,
): RenderedEmail {
  const dose = medication.dosage
    ? `${medication.drugName} (${medication.dosage})`
    : medication.drugName;
  const lines = [
    `Hi ${ctx.patientName},`,
    `Time to take your ${dose}.`,
    ...(medication.instructions ? [medication.instructions] : []),
  ];
  return {
    subject: `Reminder: take your ${medication.drugName}`,
    html: wrapHtml(lines),
    text: wrapText(lines),
  };
}

/**
 * The one place that decides which template a given outbox row gets. `side` is not stored on the
 * row itself — the worker works it out by comparing the row's `recipientId` against the
 * appointment's own patient and doctor ids, since that is the only place "whose copy is this"
 * actually lives.
 */
export function renderNotification(
  type: NotificationType,
  side: NotificationSide,
  ctx: RenderContext,
): RenderedEmail {
  switch (type) {
    case 'booking_confirmation':
      return side === 'patient'
        ? bookingConfirmationForPatient(ctx)
        : bookingConfirmationForDoctor(ctx);
    case 'cancellation':
      return side === 'patient' ? cancellationForPatient(ctx) : cancellationForDoctor(ctx);
    case 'reminder_24h':
      return reminder(ctx, 'tomorrow');
    case 'reminder_1h':
      return reminder(ctx, 'in about an hour');
    case 'leave_conflict':
      return leaveConflictForPatient(ctx);
    case 'medication_reminder':
      // Rendered through `renderMedicationReminder` instead, which needs more than a
      // RenderContext carries - reaching this case means the worker's own dispatch has a bug.
      throw new Error(
        'medication_reminder is rendered through renderMedicationReminder, not here.',
      );
    case 'reschedule':
    case 'postvisit_summary':
      // Queued by a phase later than this one, whose job is to add the matching template here
      // alongside it — this error is the intended way to notice that step got missed, not a bug.
      throw new Error(`No email template implemented yet for notification type "${type}".`);
  }
}
