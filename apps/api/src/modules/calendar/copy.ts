import type { RenderContext } from '../notifications/render-context.js';

import type { CalendarSide } from './sync.js';

/**
 * What goes into each side's own copy of the event. Deliberately short and free of the patient's
 * symptom text - a calendar entry can end up synced onto a phone's lock screen or shared with a
 * family calendar app, which is a much more public surface than an email inbox, so it gets only
 * what each person already knows: who the appointment is with.
 *
 * `doctorName` is used exactly as stored, with no "Dr " prepended - the seed data and every other
 * part of this app already carries that honorific in the name itself ("Dr Anand Mehta"), the same
 * lesson Phase 5's email templates learned the hard way.
 */
export function buildCalendarEventCopy(
  side: CalendarSide,
  context: RenderContext,
): { summary: string; description: string } {
  if (side === 'patient') {
    return {
      summary: `Appointment with ${context.doctorName}`,
      description: `${context.doctorSpecialization} appointment.`,
    };
  }
  return {
    summary: `Appointment with ${context.patientName}`,
    description: 'Patient appointment.',
  };
}
