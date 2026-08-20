import type { UserRole } from '@health/contracts';

import type { Database } from '../../db/client.js';
import { isPostgresError, PG_ERROR } from '../../db/errors.js';
import { slotOf, type TimeRange } from '../../db/types/time-range.js';
import { findAvailableSlots, findDoctorSchedulingContext } from '../doctors/availability.js';
import { writeAuditEntry } from '../../shared/audit.js';
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
  listAppointmentsForPatient,
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

export interface Requester {
  id: string;
  role: UserRole;
}

/** An admin may look up any appointment for support; anyone else only ever sees their own. */
function canSeeAppointment(requester: Requester, patientId: string): boolean {
  return requester.role === 'admin' || requester.id === patientId;
}

export async function getAppointment(
  database: Database,
  requester: Requester,
  appointmentId: string,
): Promise<AppointmentDetail> {
  const detail = await findAppointmentDetailById(database, appointmentId);
  if (!detail || !canSeeAppointment(requester, detail.patientId)) {
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

    if (!appointment || !canSeeAppointment(requester, appointment.patientId)) {
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
