import { alias } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { appointments, doctorProfiles, users } from '../../db/schema.js';
import type { TimeRange } from '../../db/types/time-range.js';

/**
 * Everything a template needs to render one appointment-related email, for either side of it.
 *
 * Deliberately not the same shape `appointments/repository.ts` already builds for the booking API
 * — that one has no reason to carry either party's timezone, and a template has no real use for an
 * `AppointmentDetail`'s `status`. Two different callers with two different needs get two different
 * queries, rather than one bloated shape trying to serve both.
 */
export interface RenderContext {
  appointmentId: string;
  doctorId: string;
  doctorName: string;
  doctorEmail: string;
  doctorTimezone: string;
  doctorSpecialization: string;
  patientId: string;
  patientName: string;
  patientEmail: string;
  patientTimezone: string;
  slot: TimeRange;
  /** Only meaningful once the appointment is actually cancelled; `null` otherwise. */
  cancellationReason: string | null;
}

const doctorUser = alias(users, 'doctor_user_for_render');
const patientUser = alias(users, 'patient_user_for_render');

export async function loadRenderContext(
  database: Database,
  appointmentId: string,
): Promise<RenderContext | undefined> {
  const [row] = await database.db
    .select({
      appointmentId: appointments.id,
      doctorId: appointments.doctorId,
      doctorName: doctorUser.fullName,
      doctorEmail: doctorUser.email,
      doctorTimezone: doctorUser.timezone,
      doctorSpecialization: doctorProfiles.specialization,
      patientId: appointments.patientId,
      patientName: patientUser.fullName,
      patientEmail: patientUser.email,
      patientTimezone: patientUser.timezone,
      slot: appointments.slot,
      cancellationReason: appointments.cancellationReason,
    })
    .from(appointments)
    .innerJoin(doctorUser, eq(doctorUser.id, appointments.doctorId))
    .innerJoin(doctorProfiles, eq(doctorProfiles.userId, appointments.doctorId))
    .innerJoin(patientUser, eq(patientUser.id, appointments.patientId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);

  return row;
}
