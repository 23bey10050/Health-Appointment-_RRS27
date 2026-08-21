import type {
  AvailabilityQuery,
  CreateDoctorRequest,
  CreateLeaveRequest,
  ListDoctorsQuery,
  UpdateDoctorRequest,
  WorkingHourInput,
} from '@health/contracts';

import type { Database } from '../../db/client.js';
import { isPostgresError, PG_ERROR } from '../../db/errors.js';
import { writeAuditEntry } from '../../shared/audit.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import { queueNotification } from '../../shared/outbox.js';

import { findAvailableSlots, type AvailabilitySlot } from './availability.js';
import * as repository from './repository.js';
import type { DoctorRow, LeaveRow, WorkingHourRow } from './repository.js';

function doctorNotFound(): NotFoundError {
  return new NotFoundError('No doctor with that id.');
}

export async function createDoctor(
  database: Database,
  input: CreateDoctorRequest,
  createdByAdminId: string,
): Promise<repository.CreatedDoctor> {
  try {
    return await repository.createDoctor(database, input, createdByAdminId);
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw new ConflictError(
        'EMAIL_ALREADY_REGISTERED',
        'An account with that email already exists.',
        { cause: error },
      );
    }
    if (isPostgresError(error, PG_ERROR.EXCLUSION_VIOLATION)) {
      // One of the initial shifts sent with the create request overlaps another one in the same
      // request. Nothing was written - createDoctor runs as one transaction - so there is no
      // half-created account to clean up here.
      throw new ConflictError(
        'WORKING_HOURS_OVERLAP',
        'Two of the working hours given overlap each other on the same day.',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function updateDoctor(
  database: Database,
  doctorId: string,
  input: UpdateDoctorRequest,
): Promise<DoctorRow> {
  const updated = await repository.updateDoctor(database, doctorId, input);
  if (!updated) {
    throw doctorNotFound();
  }
  return updated;
}

export async function getDoctor(
  database: Database,
  doctorId: string,
): Promise<{
  doctor: DoctorRow;
  workingHours: WorkingHourRow[];
}> {
  const doctor = await repository.findDoctorById(database.db, doctorId);
  if (!doctor) {
    throw doctorNotFound();
  }
  const workingHours = await repository.listWorkingHours(database.db, doctorId);
  return { doctor, workingHours };
}

export async function listDoctors(
  database: Database,
  query: ListDoctorsQuery,
): Promise<{ items: DoctorRow[]; total: number; page: number; pageSize: number }> {
  const { items, total } = await repository.listDoctors(database, {
    specialization: query.specialization,
    page: query.page,
    pageSize: query.pageSize,
  });
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function addWorkingHour(
  database: Database,
  doctorId: string,
  input: WorkingHourInput,
): Promise<WorkingHourRow> {
  await ensureDoctorExists(database, doctorId);

  try {
    return await repository.addWorkingHour(database, doctorId, input);
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.EXCLUSION_VIOLATION)) {
      throw new ConflictError(
        'WORKING_HOURS_OVERLAP',
        'This shift overlaps a shift the doctor already has on that day.',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function deleteWorkingHour(
  database: Database,
  doctorId: string,
  workingHourId: string,
): Promise<void> {
  const deleted = await repository.deleteWorkingHour(database, doctorId, workingHourId);
  if (!deleted) {
    throw new NotFoundError('No working hour with that id for this doctor.');
  }
}

export async function listWorkingHours(
  database: Database,
  doctorId: string,
): Promise<WorkingHourRow[]> {
  await ensureDoctorExists(database, doctorId);
  return repository.listWorkingHours(database.db, doctorId);
}

export async function listLeaves(database: Database, doctorId: string): Promise<LeaveRow[]> {
  await ensureDoctorExists(database, doctorId);
  return repository.listLeaves(database, doctorId);
}

const LEAVE_CANCELLATION_REASON = 'The doctor became unavailable on this date.';

export interface LeaveCreated {
  leave: LeaveRow;
  cancelledAppointments: number;
}

/**
 * Marks a leave day and, in the same transaction, cancels whatever it conflicts with.
 *
 * Locking the affected appointments with `FOR UPDATE` before touching any of them is what makes
 * this safe against a patient racing to book or cancel one of the very appointments this function
 * is about to cancel out from under them - by the time this transaction commits, there is no
 * window where the leave day exists but an affected appointment does not yet know it is cancelled.
 */
export async function addLeave(
  database: Database,
  doctorId: string,
  input: CreateLeaveRequest,
  createdByAdminId: string,
): Promise<LeaveCreated> {
  await ensureDoctorExists(database, doctorId);

  try {
    return await database.transaction(async (tx) => {
      const leave = await repository.addLeave(tx, doctorId, input, createdByAdminId);

      await writeAuditEntry(tx, {
        actorId: createdByAdminId,
        action: 'doctor_leave_added',
        entityType: 'doctor',
        entityId: doctorId,
        metadata: { leaveDate: input.leaveDate },
      });

      const conflicts = await repository.findAndLockConfirmedAppointmentsOnDate(
        tx,
        doctorId,
        input.leaveDate,
      );

      for (const conflict of conflicts) {
        await repository.cancelAppointmentForLeave(
          tx,
          conflict.appointmentId,
          createdByAdminId,
          LEAVE_CANCELLATION_REASON,
        );

        await writeAuditEntry(tx, {
          actorId: createdByAdminId,
          action: 'appointment_cancelled_for_leave',
          entityType: 'appointment',
          entityId: conflict.appointmentId,
          metadata: { leaveDate: input.leaveDate },
        });

        await queueNotification(tx, {
          appointmentId: conflict.appointmentId,
          recipientId: conflict.patientId,
          channel: 'email',
          type: 'leave_conflict',
          payload: { appointmentId: conflict.appointmentId },
          dedupeKey: `leave_conflict:${conflict.appointmentId}:${conflict.patientId}`,
        });

        // Both sides' calendars lose the event, the same as any other cancellation - the doctor
        // does not need an email about their own leave, but their calendar should not go on
        // showing a visit that is not happening.
        await queueNotification(tx, {
          appointmentId: conflict.appointmentId,
          recipientId: conflict.patientId,
          channel: 'calendar',
          type: 'cancellation',
          payload: { appointmentId: conflict.appointmentId },
          dedupeKey: `calendar:cancellation:${conflict.appointmentId}:${conflict.patientId}`,
        });
        await queueNotification(tx, {
          appointmentId: conflict.appointmentId,
          recipientId: doctorId,
          channel: 'calendar',
          type: 'cancellation',
          payload: { appointmentId: conflict.appointmentId },
          dedupeKey: `calendar:cancellation:${conflict.appointmentId}:${doctorId}`,
        });
      }

      return { leave, cancelledAppointments: conflicts.length };
    });
  } catch (error) {
    if (isPostgresError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      throw new ConflictError(
        'LEAVE_ALREADY_MARKED',
        'That date is already marked as a leave day for this doctor.',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function deleteLeave(
  database: Database,
  doctorId: string,
  leaveId: string,
): Promise<void> {
  const deleted = await repository.deleteLeave(database, doctorId, leaveId);
  if (!deleted) {
    throw new NotFoundError('No leave day with that id for this doctor.');
  }
}

/** Lets a doctor see the cost of marking a day off before they commit to it, instead of finding
 *  out how many patients got bumped only after the cascade has already run. */
export async function previewLeaveImpact(
  database: Database,
  doctorId: string,
  leaveDate: string,
): Promise<{ affectedAppointments: number }> {
  const affectedAppointments = await repository.countConfirmedAppointmentsOnDate(
    database.db,
    doctorId,
    leaveDate,
  );
  return { affectedAppointments };
}

/**
 * A deactivated doctor keeps their record — an admin can still look them up, reactivate them, or
 * inspect their history — but they have nothing to sell. Returning an empty grid here, rather than
 * running the full slot query against a doctor nobody should be booking, is what keeps that
 * boundary enforced in exactly one place instead of scattered across every caller.
 */
export async function getAvailability(
  database: Database,
  doctorId: string,
  query: AvailabilityQuery,
): Promise<{ doctor: DoctorRow; slots: AvailabilitySlot[] }> {
  const doctor = await repository.findDoctorById(database.db, doctorId);
  if (!doctor) {
    throw doctorNotFound();
  }
  if (!doctor.isActive) {
    return { doctor, slots: [] };
  }

  const slots = await findAvailableSlots(database.db, doctorId, query.from, query.to);
  return { doctor, slots };
}

async function ensureDoctorExists(database: Database, doctorId: string): Promise<void> {
  const doctor = await repository.findDoctorById(database.db, doctorId);
  if (!doctor) {
    throw doctorNotFound();
  }
}
