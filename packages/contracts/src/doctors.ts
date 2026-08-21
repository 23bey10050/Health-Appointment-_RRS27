import { z } from 'zod';

import { emailSchema, passwordSchema } from './auth.js';

/** Matches "09:00" or "09:00:00". Postgres's own `TIME` type accepts both; we only emit the first. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const timeOfDaySchema = z.string().regex(TIME_PATTERN, 'must be a time like "09:00"');

/** A plain calendar date, "2026-09-01" — never a full timestamp. Working hours have no timezone
 * of their own; they are always read in the doctor's own zone, which is why the wire format stays
 * a bare date rather than something that could smuggle in an offset. */
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like "2026-09-01"');

const dayOfWeekSchema = z
  .number()
  .int()
  .min(0, 'must be 0 (Sunday) through 6 (Saturday)')
  .max(6, 'must be 0 (Sunday) through 6 (Saturday)');

/** Mirrors the CHECK constraint on `doctor_profiles.slot_duration_mins`. */
const slotDurationSchema = z
  .number()
  .int()
  .min(5, 'must be at least 5 minutes')
  .max(240, 'must be at most 240 minutes');

const consultationFeeSchema = z
  .number()
  .nonnegative('cannot be negative')
  .max(999_999.99, 'is unreasonably large')
  .optional();

export const workingHourInputSchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    startTime: timeOfDaySchema,
    endTime: timeOfDaySchema,
  })
  .refine((value) => value.endTime > value.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export type WorkingHourInput = z.infer<typeof workingHourInputSchema>;

export const workingHourSchema = z.object({
  id: z.string().uuid(),
  dayOfWeek: dayOfWeekSchema,
  startTime: z.string(),
  endTime: z.string(),
});

export type WorkingHour = z.infer<typeof workingHourSchema>;

export const createDoctorRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1, 'is required').max(200),
  specialization: z.string().trim().min(1, 'is required').max(120),
  bio: z.string().trim().max(2000).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  slotDurationMins: slotDurationSchema.optional(),
  consultationFee: consultationFeeSchema,
  // Lets an admin set up the doctor's first week in the same request that creates the account,
  // instead of a create-then-seven-more-requests dance for the common case.
  workingHours: z.array(workingHourInputSchema).max(30).optional(),
});

export type CreateDoctorRequest = z.infer<typeof createDoctorRequestSchema>;

/**
 * Deliberately narrow. Email and password live on `users` and change through their own flows —
 * this endpoint only ever touches the clinic-facing side of a doctor's profile.
 */
export const updateDoctorRequestSchema = z
  .object({
    specialization: z.string().trim().min(1).max(120).optional(),
    bio: z.string().trim().max(2000).nullable().optional(),
    slotDurationMins: slotDurationSchema.optional(),
    consultationFee: consultationFeeSchema,
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'must change at least one field',
  });

export type UpdateDoctorRequest = z.infer<typeof updateDoctorRequestSchema>;

export const doctorSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  specialization: z.string(),
  bio: z.string().nullable(),
  slotDurationMins: z.number().int(),
  consultationFee: z.number().nullable(),
  isActive: z.boolean(),
  workingHours: z.array(workingHourSchema),
});

export type Doctor = z.infer<typeof doctorSchema>;

/** The lighter shape used in the search list — no working hours, so paging stays cheap. */
export const doctorSummarySchema = doctorSchema.omit({ workingHours: true });

export type DoctorSummary = z.infer<typeof doctorSummarySchema>;

export const listDoctorsQuerySchema = z.object({
  specialization: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListDoctorsQuery = z.infer<typeof listDoctorsQuerySchema>;

export const listDoctorsResponseSchema = z.object({
  items: z.array(doctorSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export type ListDoctorsResponse = z.infer<typeof listDoctorsResponseSchema>;

export const createLeaveRequestSchema = z.object({
  leaveDate: calendarDateSchema,
  reason: z.string().trim().max(500).optional(),
});

export type CreateLeaveRequest = z.infer<typeof createLeaveRequestSchema>;

export const leaveSchema = z.object({
  id: z.string().uuid(),
  leaveDate: z.string(),
  reason: z.string().nullable(),
});

/** What creating a leave day answers with, on top of the plain leave record - how many already
 *  confirmed appointments the cascade cancelled, so the admin UI can say "4 patients were
 *  notified" without a second request. Only meaningful at the moment of creation, which is why it
 *  is not just added to `leaveSchema` itself - a listed leave day is not re-run every time it is
 *  read back. */
export const createLeaveResponseSchema = leaveSchema.extend({
  cancelledAppointments: z.number().int().min(0),
});

export type CreateLeaveResponse = z.infer<typeof createLeaveResponseSchema>;

export type Leave = z.infer<typeof leaveSchema>;

/**
 * A range wide enough for a real booking UI (a term, roughly) and narrow enough that the slot
 * engine's `generate_series` can never be asked to expand years of empty calendar.
 */
const MAX_AVAILABILITY_SPAN_DAYS = 31;

export const availabilityQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .refine((value) => value.to >= value.from, {
    message: 'must not be before "from"',
    path: ['to'],
  })
  .refine(
    (value) => {
      const spanDays = daysBetween(value.from, value.to);
      return spanDays <= MAX_AVAILABILITY_SPAN_DAYS;
    },
    { message: `must not span more than ${MAX_AVAILABILITY_SPAN_DAYS} days`, path: ['to'] },
  );

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

function daysBetween(from: string, to: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

export const availabilitySlotSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
});

export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

export const availabilityResponseSchema = z.object({
  doctorId: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  slots: z.array(availabilitySlotSchema),
});

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
