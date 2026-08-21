import type { CreateDoctorRequest, UpdateDoctorRequest, WorkingHourInput } from '@health/contracts';
import { and, asc, count, eq, ilike, sql } from 'drizzle-orm';

import type { Database, Db, DbTransaction } from '../../db/client.js';
import {
  appointments,
  doctorLeaves,
  doctorProfiles,
  doctorWorkingHours,
  users,
} from '../../db/schema.js';
import { hashPassword } from '../../shared/password.js';

/** Anything that can run a `select`/`insert`/`update`/`delete` — a plain connection or mid-transaction. */
type Executor = Db | DbTransaction;

export interface DoctorRow {
  id: string;
  fullName: string;
  specialization: string;
  bio: string | null;
  slotDurationMins: number;
  consultationFee: number | null;
  isActive: boolean;
}

export interface WorkingHourRow {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface LeaveRow {
  id: string;
  leaveDate: string;
  reason: string | null;
}

/**
 * Postgres's `NUMERIC` arrives as a string, because a JS `number` cannot represent arbitrary
 * precision without silently rounding. Converting here, once, at the edge of the database layer,
 * means the rest of the app only ever deals in plain numbers.
 */
function toFeeNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toDoctorRow(row: {
  id: string;
  fullName: string;
  specialization: string;
  bio: string | null;
  slotDurationMins: number;
  consultationFee: string | null;
  isActive: boolean;
}): DoctorRow {
  return {
    id: row.id,
    fullName: row.fullName,
    specialization: row.specialization,
    bio: row.bio,
    slotDurationMins: row.slotDurationMins,
    consultationFee: toFeeNumber(row.consultationFee),
    isActive: row.isActive,
  };
}

const DOCTOR_COLUMNS = {
  id: users.id,
  fullName: users.fullName,
  specialization: doctorProfiles.specialization,
  bio: doctorProfiles.bio,
  slotDurationMins: doctorProfiles.slotDurationMins,
  consultationFee: doctorProfiles.consultationFee,
  isActive: users.isActive,
} as const;

/**
 * Creates the doctor's login and their clinic profile together, in one transaction, optionally with
 * their first week of shifts. Either the whole doctor exists afterwards — account, profile, and
 * schedule — or none of it does; there is no state where a login was created but the profile that
 * makes it useful never was.
 */
export interface CreatedDoctor {
  doctor: DoctorRow;
  workingHours: WorkingHourRow[];
}

export async function createDoctor(
  database: Database,
  input: CreateDoctorRequest,
  createdByAdminId: string,
): Promise<CreatedDoctor> {
  const passwordHash = await hashPassword(input.password);

  return database.transaction(async (tx) => {
    const [account] = await tx
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        role: 'doctor',
        fullName: input.fullName,
        phone: input.phone,
        timezone: input.timezone,
      })
      .returning({ id: users.id, fullName: users.fullName, isActive: users.isActive });

    if (!account) {
      throw new Error('Insert returned no row for a new doctor user.');
    }

    const [profile] = await tx
      .insert(doctorProfiles)
      .values({
        userId: account.id,
        specialization: input.specialization,
        bio: input.bio,
        slotDurationMins: input.slotDurationMins,
        consultationFee: input.consultationFee?.toFixed(2),
        createdBy: createdByAdminId,
      })
      .returning({
        specialization: doctorProfiles.specialization,
        bio: doctorProfiles.bio,
        slotDurationMins: doctorProfiles.slotDurationMins,
        consultationFee: doctorProfiles.consultationFee,
      });

    if (!profile) {
      throw new Error('Insert returned no row for a new doctor profile.');
    }

    const workingHours =
      input.workingHours && input.workingHours.length > 0
        ? await insertWorkingHours(tx, account.id, input.workingHours)
        : [];

    return {
      doctor: toDoctorRow({
        id: account.id,
        fullName: account.fullName,
        isActive: account.isActive,
        ...profile,
      }),
      workingHours,
    };
  });
}

export async function updateDoctor(
  database: Database,
  doctorId: string,
  input: UpdateDoctorRequest,
): Promise<DoctorRow | undefined> {
  return database.transaction(async (tx) => {
    const profileChanges: Partial<typeof doctorProfiles.$inferInsert> = {};
    if (input.specialization !== undefined) profileChanges.specialization = input.specialization;
    if (input.bio !== undefined) profileChanges.bio = input.bio;
    if (input.slotDurationMins !== undefined)
      profileChanges.slotDurationMins = input.slotDurationMins;
    if (input.consultationFee !== undefined) {
      profileChanges.consultationFee = input.consultationFee.toFixed(2);
    }

    if (Object.keys(profileChanges).length > 0) {
      await tx
        .update(doctorProfiles)
        .set(profileChanges)
        .where(eq(doctorProfiles.userId, doctorId));
    }

    if (input.isActive !== undefined) {
      await tx.update(users).set({ isActive: input.isActive }).where(eq(users.id, doctorId));
    }

    return findDoctorById(tx, doctorId);
  });
}

export async function findDoctorById(
  executor: Executor,
  doctorId: string,
): Promise<DoctorRow | undefined> {
  const [row] = await executor
    .select(DOCTOR_COLUMNS)
    .from(doctorProfiles)
    .innerJoin(users, eq(users.id, doctorProfiles.userId))
    .where(eq(doctorProfiles.userId, doctorId))
    .limit(1);

  return row ? toDoctorRow(row) : undefined;
}

export interface ListDoctorsFilter {
  specialization?: string;
  page: number;
  pageSize: number;
}

export interface ListDoctorsResult {
  items: DoctorRow[];
  total: number;
}

/**
 * Only ever returns doctors a patient can actually book. A deactivated doctor still exists — an
 * admin can look them up directly by id to reactivate them — but they have no business showing up
 * in a search result nobody can act on.
 */
export async function listDoctors(
  database: Database,
  filter: ListDoctorsFilter,
): Promise<ListDoctorsResult> {
  const conditions = [eq(users.isActive, true)];
  if (filter.specialization) {
    // Exact match, case-insensitive, no wildcards - which is exactly what the index on
    // lower(specialization) from the Phase 1 migration was built to accelerate.
    conditions.push(ilike(doctorProfiles.specialization, filter.specialization));
  }
  const whereClause = and(...conditions);

  const [items, totals] = await Promise.all([
    database.db
      .select(DOCTOR_COLUMNS)
      .from(doctorProfiles)
      .innerJoin(users, eq(users.id, doctorProfiles.userId))
      .where(whereClause)
      .orderBy(asc(users.fullName))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    database.db
      .select({ total: count() })
      .from(doctorProfiles)
      .innerJoin(users, eq(users.id, doctorProfiles.userId))
      .where(whereClause),
  ]);

  return { items: items.map(toDoctorRow), total: totals[0]?.total ?? 0 };
}

export async function listWorkingHours(
  executor: Executor,
  doctorId: string,
): Promise<WorkingHourRow[]> {
  return executor
    .select({
      id: doctorWorkingHours.id,
      dayOfWeek: doctorWorkingHours.dayOfWeek,
      startTime: doctorWorkingHours.startTime,
      endTime: doctorWorkingHours.endTime,
    })
    .from(doctorWorkingHours)
    .where(eq(doctorWorkingHours.doctorId, doctorId))
    .orderBy(asc(doctorWorkingHours.dayOfWeek), asc(doctorWorkingHours.startTime));
}

async function insertWorkingHours(
  tx: DbTransaction,
  doctorId: string,
  shifts: readonly WorkingHourInput[],
): Promise<WorkingHourRow[]> {
  return tx
    .insert(doctorWorkingHours)
    .values(
      shifts.map((shift) => ({
        doctorId,
        dayOfWeek: shift.dayOfWeek,
        startTime: shift.startTime,
        endTime: shift.endTime,
      })),
    )
    .returning({
      id: doctorWorkingHours.id,
      dayOfWeek: doctorWorkingHours.dayOfWeek,
      startTime: doctorWorkingHours.startTime,
      endTime: doctorWorkingHours.endTime,
    });
}

export async function addWorkingHour(
  database: Database,
  doctorId: string,
  input: WorkingHourInput,
): Promise<WorkingHourRow> {
  const [row] = await database.db
    .insert(doctorWorkingHours)
    .values({
      doctorId,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
    })
    .returning({
      id: doctorWorkingHours.id,
      dayOfWeek: doctorWorkingHours.dayOfWeek,
      startTime: doctorWorkingHours.startTime,
      endTime: doctorWorkingHours.endTime,
    });

  if (!row) {
    throw new Error('Insert returned no row for a new working hour.');
  }
  return row;
}

/** Returns whether a row actually existed to delete, so the route can answer 404 rather than 200. */
export async function deleteWorkingHour(
  database: Database,
  doctorId: string,
  workingHourId: string,
): Promise<boolean> {
  const deleted = await database.db
    .delete(doctorWorkingHours)
    .where(and(eq(doctorWorkingHours.id, workingHourId), eq(doctorWorkingHours.doctorId, doctorId)))
    .returning({ id: doctorWorkingHours.id });

  return deleted.length > 0;
}

export async function listLeaves(database: Database, doctorId: string): Promise<LeaveRow[]> {
  return database.db
    .select({ id: doctorLeaves.id, leaveDate: doctorLeaves.leaveDate, reason: doctorLeaves.reason })
    .from(doctorLeaves)
    .where(eq(doctorLeaves.doctorId, doctorId))
    .orderBy(asc(doctorLeaves.leaveDate));
}

/** Runs inside the transaction the cascade also uses, rather than opening its own - saving the
 *  leave day and cancelling whatever it conflicts with either both happen or neither does. */
export async function addLeave(
  tx: DbTransaction,
  doctorId: string,
  input: { leaveDate: string; reason?: string },
  createdByAdminId: string,
): Promise<LeaveRow> {
  const [row] = await tx
    .insert(doctorLeaves)
    .values({
      doctorId,
      leaveDate: input.leaveDate,
      reason: input.reason,
      createdBy: createdByAdminId,
    })
    .returning({
      id: doctorLeaves.id,
      leaveDate: doctorLeaves.leaveDate,
      reason: doctorLeaves.reason,
    });

  if (!row) {
    throw new Error('Insert returned no row for a new leave day.');
  }
  return row;
}

export interface LeaveConflict {
  appointmentId: string;
  patientId: string;
}

interface LeaveConflictRow extends Record<string, unknown> {
  appointment_id: string;
  patient_id: string;
}

/**
 * Finds every confirmed appointment that falls on a doctor's newly marked leave day, and locks
 * each one for the rest of the transaction so nothing else can book, cancel, or reschedule any of
 * them while the cascade below is still deciding what to do with them.
 *
 * "That day" means the doctor's own local calendar day, not a literal UTC midnight-to-midnight
 * window - the same `AT TIME ZONE` conversion the availability engine already relies on for
 * exactly the same reason, so a leave day marked in the doctor's own timezone actually covers the
 * hours patients could have booked into.
 */
export async function findAndLockConfirmedAppointmentsOnDate(
  tx: DbTransaction,
  doctorId: string,
  leaveDate: string,
): Promise<LeaveConflict[]> {
  const result = await tx.execute<LeaveConflictRow>(sql`
    WITH doctor AS (
      SELECT timezone FROM users WHERE id = ${doctorId}
    ),
    day_range AS (
      SELECT
        (${leaveDate}::date AT TIME ZONE doc.timezone) AS range_start,
        ((${leaveDate}::date + 1) AT TIME ZONE doc.timezone) AS range_end
      FROM doctor doc
    )
    SELECT a.id AS appointment_id, a.patient_id
    FROM appointments a, day_range r
    WHERE a.doctor_id = ${doctorId}
      AND a.status = 'confirmed'
      AND a.slot && tstzrange(r.range_start, r.range_end)
    FOR UPDATE OF a
  `);

  return result.rows.map((row) => ({
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
  }));
}

export async function cancelAppointmentForLeave(
  tx: DbTransaction,
  appointmentId: string,
  cancelledBy: string,
  reason: string,
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

export async function deleteLeave(
  database: Database,
  doctorId: string,
  leaveId: string,
): Promise<boolean> {
  const deleted = await database.db
    .delete(doctorLeaves)
    .where(and(eq(doctorLeaves.id, leaveId), eq(doctorLeaves.doctorId, doctorId)))
    .returning({ id: doctorLeaves.id });

  return deleted.length > 0;
}
