import type { PrescriptionItem, UserRole } from '@health/contracts';

import type { Database } from '../../db/client.js';
import { isPostgresError, PG_ERROR } from '../../db/errors.js';
import { slotOf, type TimeRange } from '../../db/types/time-range.js';
import { findAvailableSlots, findDoctorSchedulingContext } from '../doctors/availability.js';
import { findUserTimezone } from '../medications/repository.js';
import { scheduleMedicationReminders } from '../medications/service.js';
import { writeAuditEntry } from '../../shared/audit.js';
import { resolveDoctorDayRange } from '../../shared/doctor-day-range.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import { queueNotification } from '../../shared/outbox.js';

import {
  cancelAppointment,
  createAppointment,
  createHold,
  deleteHold,
  findAppointmentDetailById,
  findAppointmentForUpdate,
  findHoldForUpdate,
  listAppointmentsForDoctor,
  listAppointmentsForPatient,
  saveDoctorNotes,
  type AppointmentDetail,
  type HoldRow,
} from './repository.js';

function slotUnavailable(cause?: unknown): ConflictError {
  return new ConflictError(
    'SLOT_UNAVAILABLE',
    'That slot is not available. Please choose another.',
    {
      cause,
    },
  );
}

/**
 * Confirms a requested instant is a real, currently bookable slot before anything is written.
 *
 * Reuses `findAvailableSlots` for the doctor's one local day rather than writing a second query
 * that decides what "bookable" means — the availability grid and the booking flow can never quietly
 * disagree about which slots are real, because they are answering the question with the same code.
 */
async function assertSlotIsBookable(
  database: Database,
  doctorId: string,
  start: Date,
): Promise<TimeRange> {
  const context = await findDoctorSchedulingContext(database.db, doctorId, start);
  if (!context) {
    throw new NotFoundError('No doctor with that id.');
  }
  if (!context.isActive) {
    throw slotUnavailable();
  }

  const slot = slotOf(start, context.slotDurationMins);
  const dayGrid = await findAvailableSlots(
    database.db,
    doctorId,
    context.localDate,
    context.localDate,
  );
  const isBookable = dayGrid.some(
    (candidate) =>
      candidate.start.getTime() === slot.start.getTime() &&
      candidate.end.getTime() === slot.end.getTime(),
  );

  if (!isBookable) {
    throw slotUnavailable();
  }
  return slot;
}

/**
 * Reserves a slot for the few minutes it takes a patient to fill in the symptom form.
 *
 * The check above is a courtesy — it turns "outside working hours" and "someone already has this"
 * into the same clear answer before the patient invests any time. The actual guarantee is the
 * exclusion constraint on the insert a moment later, which is what `createHold` relies on and what
 * the `catch` below is there to translate into that same friendly answer if two patients reach for
 * the identical slot within the same instant.
 */
export async function holdSlot(
  database: Database,
  patientId: string,
  doctorId: string,
  start: Date,
): Promise<HoldRow> {
  const slot = await assertSlotIsBookable(database, doctorId, start);

  try {
    return await createHold(database, { doctorId, patientId, slot });
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.EXCLUSION_VIOLATION)) {
      throw slotUnavailable(error);
    }
    throw error;
  }
}

/**
 * Turns a held slot into a real appointment.
 *
 * Every failure path here is checked *before* anything is written, so there is never a case where
 * this needs to report a rejection after already writing something that has to survive it — unlike
 * the login and refresh flows in Phase 2, nothing here throws away a side effect by rolling back,
 * because nothing worth keeping has happened yet at the point any of these throw.
 */
export async function confirmHold(
  database: Database,
  patientId: string,
  holdId: string,
  symptoms: string,
): Promise<AppointmentDetail> {
  const appointmentId = await database.transaction(async (tx) => {
    const hold = await findHoldForUpdate(tx, holdId);

    // Not found and "found, but somebody else's" get the same answer - a hold id is unguessable,
    // so there is nothing useful an attacker learns either way, and no reason to distinguish them.
    if (!hold || hold.patientId !== patientId) {
      throw new NotFoundError('No hold with that id.');
    }
    if (hold.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError('HOLD_EXPIRED', 'This hold has expired. Please choose a slot again.');
    }

    let created: { id: string };
    try {
      created = await createAppointment(tx, {
        doctorId: hold.doctorId,
        patientId,
        slot: hold.slot,
        symptoms,
      });
    } catch (error) {
      // Should be unreachable in normal operation - the hold's own exclusion constraint already
      // makes this slot exclusively ours the moment the hold succeeded. Handled anyway, because
      // "should be unreachable" is not the same promise as "is unreachable".
      if (isPostgresError(error, PG_ERROR.EXCLUSION_VIOLATION)) {
        throw slotUnavailable(error);
      }
      throw error;
    }

    await deleteHold(tx, holdId);

    await writeAuditEntry(tx, {
      actorId: patientId,
      action: 'appointment_booked',
      entityType: 'appointment',
      entityId: created.id,
    });

    // The payload is deliberately just the id. Nothing drains this table yet - that is Phase 5 -
    // and guessing at exactly what an email template will want before it exists would mean
    // designing that shape twice. The worker can look up whatever it needs when it exists.
    await queueNotification(tx, {
      appointmentId: created.id,
      recipientId: patientId,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId: created.id },
      dedupeKey: `booking_confirmation:${created.id}:${patientId}`,
    });
    await queueNotification(tx, {
      appointmentId: created.id,
      recipientId: hold.doctorId,
      channel: 'email',
      type: 'booking_confirmation',
      payload: { appointmentId: created.id },
      dedupeKey: `booking_confirmation:${created.id}:${hold.doctorId}`,
    });

    // The same event, once for each side's own calendar - a `calendar:` prefix on the dedupe key
    // keeps these from colliding with the two email rows above, which would otherwise share the
    // exact same `type:appointmentId:recipientId` string. Whether either one actually produces a
    // real event depends entirely on whether that person has connected Google Calendar - the
    // worker decides that, not this transaction, which queues the same promise-to-sync either way.
    await queueNotification(tx, {
      appointmentId: created.id,
      recipientId: patientId,
      channel: 'calendar',
      type: 'booking_confirmation',
      payload: { appointmentId: created.id },
      dedupeKey: `calendar:booking_confirmation:${created.id}:${patientId}`,
    });
    await queueNotification(tx, {
      appointmentId: created.id,
      recipientId: hold.doctorId,
      channel: 'calendar',
      type: 'booking_confirmation',
      payload: { appointmentId: created.id },
      dedupeKey: `calendar:booking_confirmation:${created.id}:${hold.doctorId}`,
    });

    return created.id;
  });

  return mustFindAppointment(database, appointmentId);
}

export async function listMyAppointments(
  database: Database,
  patientId: string,
): Promise<AppointmentDetail[]> {
  return listAppointmentsForPatient(database, patientId);
}

/** A doctor's own daily/weekly schedule - `doctorId` only ever arrives here as the caller's own
 *  id, taken from their own access token, so this has no ownership check to make the way
 *  `getAppointment` does for a single appointment; there is no other doctor's schedule this
 *  function could even be asked for. */
export async function getMySchedule(
  database: Database,
  doctorId: string,
  from: string,
  to: string,
): Promise<AppointmentDetail[]> {
  const range = await resolveDoctorDayRange(database.db, doctorId, from, to);
  if (!range) {
    // Unreachable in practice - see resolveDoctorDayRange's own comment - kept as a real error
    // rather than an empty list, so a bug here fails loudly instead of just looking like an
    // empty schedule.
    throw new Error(`Doctor ${doctorId} was expected to exist but does not.`);
  }
  return listAppointmentsForDoctor(database, doctorId, range);
}

export interface Requester {
  id: string;
  role: UserRole;
}

/** An admin may look up any appointment for support; the patient and the assigned doctor see
 *  their own side of it - a doctor needs this to read the pre-visit triage brief before a visit,
 *  and the patient needs it to read the post-visit summary after one. Nobody else sees either. */
function canSeeAppointment(
  requester: Requester,
  appointment: { patientId: string; doctorId: string },
): boolean {
  return (
    requester.role === 'admin' ||
    requester.id === appointment.patientId ||
    requester.id === appointment.doctorId
  );
}

export async function getAppointment(
  database: Database,
  requester: Requester,
  appointmentId: string,
): Promise<AppointmentDetail> {
  const detail = await findAppointmentDetailById(database, appointmentId);
  if (!detail || !canSeeAppointment(requester, detail)) {
    throw new NotFoundError('No appointment with that id.');
  }
  return detail;
}

export async function cancelAppointmentByRequester(
  database: Database,
  requester: Requester,
  appointmentId: string,
  reason: string | undefined,
): Promise<AppointmentDetail> {
  const finalId = await database.transaction(async (tx) => {
    const appointment = await findAppointmentForUpdate(tx, appointmentId);

    // Cancelling stays patient-and-admin only, unlike the read above - a doctor needing to cancel
    // a patient's booking is a real workflow, but not one this phase's AI summary work touches, so
    // it is left as it was rather than widened on the side.
    const canCancel = requester.role === 'admin' || requester.id === appointment?.patientId;
    if (!appointment || !canCancel) {
      throw new NotFoundError('No appointment with that id.');
    }
    if (appointment.status !== 'confirmed') {
      throw new ConflictError(
        'APPOINTMENT_NOT_CANCELLABLE',
        `This appointment is already ${appointment.status.replace('_', ' ')} and cannot be cancelled.`,
      );
    }

    await cancelAppointment(tx, appointmentId, requester.id, reason);

    await writeAuditEntry(tx, {
      actorId: requester.id,
      action: 'appointment_cancelled',
      entityType: 'appointment',
      entityId: appointmentId,
      metadata: reason ? { reason } : undefined,
    });

    await queueNotification(tx, {
      appointmentId,
      recipientId: appointment.patientId,
      channel: 'email',
      type: 'cancellation',
      payload: { appointmentId },
      dedupeKey: `cancellation:${appointmentId}:${appointment.patientId}`,
    });
    await queueNotification(tx, {
      appointmentId,
      recipientId: appointment.doctorId,
      channel: 'email',
      type: 'cancellation',
      payload: { appointmentId },
      dedupeKey: `cancellation:${appointmentId}:${appointment.doctorId}`,
    });

    // Deleting each side's own calendar event, same reasoning as the calendar rows in
    // confirmHold above - the worker looks up whichever event id was actually recorded, if any,
    // and simply has nothing to do for a side that never had one created in the first place.
    await queueNotification(tx, {
      appointmentId,
      recipientId: appointment.patientId,
      channel: 'calendar',
      type: 'cancellation',
      payload: { appointmentId },
      dedupeKey: `calendar:cancellation:${appointmentId}:${appointment.patientId}`,
    });
    await queueNotification(tx, {
      appointmentId,
      recipientId: appointment.doctorId,
      channel: 'calendar',
      type: 'cancellation',
      payload: { appointmentId },
      dedupeKey: `calendar:cancellation:${appointmentId}:${appointment.doctorId}`,
    });

    return appointmentId;
  });

  return mustFindAppointment(database, finalId);
}

/**
 * Records what the doctor wrote after a visit and moves the appointment to 'completed'.
 *
 * This is the trigger point for the post-visit AI summary, though the actual AI call is not made
 * here - the route handler fires that afterwards, un-awaited, the same way it fires the pre-visit
 * call after `confirmHold`. Keeping it out of this function is what let Phase 4's booking code
 * stay untouched: nothing about this appointment write itself needs to know an AI summary exists.
 */
export async function submitNotes(
  database: Database,
  doctorId: string,
  appointmentId: string,
  doctorNotes: string,
  prescription: PrescriptionItem[],
): Promise<AppointmentDetail> {
  const finalId = await database.transaction(async (tx) => {
    const appointment = await findAppointmentForUpdate(tx, appointmentId);

    if (!appointment || appointment.doctorId !== doctorId) {
      throw new NotFoundError('No appointment with that id.');
    }
    if (appointment.status !== 'confirmed') {
      throw new ConflictError(
        'APPOINTMENT_NOT_ACTIVE',
        `This appointment is already ${appointment.status.replace('_', ' ')}, so notes cannot be added.`,
      );
    }

    await saveDoctorNotes(tx, appointmentId, doctorNotes, prescription);

    await writeAuditEntry(tx, {
      actorId: doctorId,
      action: 'appointment_notes_submitted',
      entityType: 'appointment',
      entityId: appointmentId,
    });

    // In the same transaction as the prescription itself - a visit whose notes saved but whose
    // reminders silently failed to schedule is a worse outcome than either succeeding together,
    // and expanding a schedule is a fast, local computation with nothing external to justify
    // deferring it the way an actual reminder email is deferred to the outbox.
    if (prescription.length > 0) {
      const patientTimezone = await findUserTimezone(tx, appointment.patientId);
      await scheduleMedicationReminders(tx, {
        appointmentId,
        patientId: appointment.patientId,
        patientTimezone,
        prescription,
      });
    }

    return appointmentId;
  });

  return mustFindAppointment(database, finalId);
}

async function mustFindAppointment(
  database: Database,
  appointmentId: string,
): Promise<AppointmentDetail> {
  const detail = await findAppointmentDetailById(database, appointmentId);
  if (!detail) {
    // A bug, not a user-facing outcome: the row was just written successfully inside this same
    // request, in the same process, so it existing is not something the caller should have to
    // handle as a normal case.
    throw new Error(`Appointment ${appointmentId} was written but cannot be read back.`);
  }
  return detail;
}
