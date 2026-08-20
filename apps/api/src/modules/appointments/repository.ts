import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, lte } from 'drizzle-orm';

import type { Database, DbTransaction } from '../../db/client.js';
import { appointments, slotHolds, users } from '../../db/schema.js';
import type { TimeRange } from '../../db/types/time-range.js';

export interface HoldRow {
  id: string;
  doctorId: string;
  patientId: string;
  slot: TimeRange;
  expiresAt: Date;
}

/** Five minutes is long enough to read a symptom form and short enough that an abandoned hold
 *  does not lock a slot out of the grid for anyone else for very long. */
export const HOLD_TTL_MINUTES = 5;

/**
 * Reserves a slot for the length of time it takes to fill in the symptom form.
 *
 * Clearing this doctor's own expired holds first, inside the same transaction as the insert, is
 * the backstop described back in the Phase 1 migration comment: the exclusion constraint on
 * `slot_holds` has no way to expire a row on its own, so an abandoned hold would otherwise sit
 * there blocking its slot until a future cleanup job got to it. Scoping the delete to this one
 * doctor keeps it a cheap, indexed operation rather than a table-wide sweep on every hold request.
 */
export async function createHold(
  database: Database,
  input: { doctorId: string; patientId: string; slot: TimeRange },
): Promise<HoldRow> {
  return database.transaction(async (tx) => {
    await tx
      .delete(slotHolds)
      .where(and(eq(slotHolds.doctorId, input.doctorId), lte(slotHolds.expiresAt, new Date())));

    const [row] = await tx
      .insert(slotHolds)
      .values({
        doctorId: input.doctorId,
        patientId: input.patientId,
        slot: input.slot,
        expiresAt: new Date(Date.now() + HOLD_TTL_MINUTES * 60_000),
      })
      .returning({
        id: slotHolds.id,
        doctorId: slotHolds.doctorId,
        patientId: slotHolds.patientId,
        slot: slotHolds.slot,
        expiresAt: slotHolds.expiresAt,
      });

    if (!row) {
      throw new Error('Insert returned no row for a new slot hold.');
    }
    return row;
  });
}

/** Locks the hold row for the rest of the transaction, so a confirm and an expiry sweep can never
 *  both act on the same hold at once. */
export async function findHoldForUpdate(
  tx: DbTransaction,
  holdId: string,
): Promise<HoldRow | undefined> {
  const [row] = await tx
    .select({
      id: slotHolds.id,
      doctorId: slotHolds.doctorId,
      patientId: slotHolds.patientId,
      slot: slotHolds.slot,
      expiresAt: slotHolds.expiresAt,
    })
    .from(slotHolds)
    .where(eq(slotHolds.id, holdId))
    .for('update')
    .limit(1);

  return row;
}

export async function deleteHold(tx: DbTransaction, holdId: string): Promise<void> {
  await tx.delete(slotHolds).where(eq(slotHolds.id, holdId));
}

export interface AppointmentDetail {
  id: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  slot: TimeRange;
  status: 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  symptoms: string | null;
  createdAt: Date;
}

const doctorUser = alias(users, 'doctor_user');
const patientUser = alias(users, 'patient_user');

function detailColumns() {
  return {
    id: appointments.id,
    doctorId: appointments.doctorId,
    doctorName: doctorUser.fullName,
    patientId: appointments.patientId,
    patientName: patientUser.fullName,
    slot: appointments.slot,
    status: appointments.status,
    symptoms: appointments.symptomsText,
    createdAt: appointments.createdAt,
  };
}

function detailQuery(database: Database) {
  return database.db
    .select(detailColumns())
    .from(appointments)
    .innerJoin(doctorUser, eq(doctorUser.id, appointments.doctorId))
    .innerJoin(patientUser, eq(patientUser.id, appointments.patientId));
}

export async function createAppointment(
  tx: DbTransaction,
  input: { doctorId: string; patientId: string; slot: TimeRange; symptoms: string },
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await tx
    .insert(appointments)
    .values({
      doctorId: input.doctorId,
      patientId: input.patientId,
      slot: input.slot,
      symptomsText: input.symptoms,
      symptomsSubmittedAt: new Date(),
    })
    .returning({ id: appointments.id, createdAt: appointments.createdAt });

  if (!row) {
    throw new Error('Insert returned no row for a new appointment.');
  }
  return row;
}

export async function findAppointmentDetailById(
  database: Database,
  appointmentId: string,
): Promise<AppointmentDetail | undefined> {
  const [row] = await detailQuery(database).where(eq(appointments.id, appointmentId)).limit(1);
  return row;
}

export async function listAppointmentsForPatient(
  database: Database,
  patientId: string,
): Promise<AppointmentDetail[]> {
  return detailQuery(database)
    .where(eq(appointments.patientId, patientId))
    .orderBy(desc(appointments.createdAt));
}

export interface AppointmentForCancel {
  id: string;
  doctorId: string;
  patientId: string;
  status: 'confirmed' | 'completed' | 'cancelled' | 'no_show';
}

export async function findAppointmentForUpdate(
  tx: DbTransaction,
  appointmentId: string,
): Promise<AppointmentForCancel | undefined> {
  const [row] = await tx
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      patientId: appointments.patientId,
      status: appointments.status,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .for('update')
    .limit(1);

  return row;
}

export async function cancelAppointment(
  tx: DbTransaction,
  appointmentId: string,
  cancelledBy: string,
  reason: string | undefined,
): Promise<void> {
  await tx
    .update(appointments)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy,
      cancellationReason: reason,
    })
    .where(eq(appointments.id, appointmentId));
}
