import { z } from 'zod';

/**
 * How far ahead a patient may reserve a slot. Ninety days is a generous booking horizon for a
 * clinic and, like the 31-day cap on browsing availability, exists mainly to keep a stray or
 * malicious "start" value from being anything wildly out of range.
 */
const MAX_BOOKING_HORIZON_DAYS = 90;

function isWithinBookingHorizon(iso: string): boolean {
  const requested = Date.parse(iso);
  if (Number.isNaN(requested)) {
    return false;
  }
  const horizon = Date.now() + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  return requested <= horizon;
}

export const holdRequestSchema = z.object({
  doctorId: z.string().uuid(),
  /** The exact `start` instant echoed back from `GET /doctors/:id/availability` — never computed
   *  client-side, so the patient never has to think about the doctor's timezone at all. */
  start: z
    .string()
    .datetime()
    .refine(isWithinBookingHorizon, {
      message: `must not be more than ${MAX_BOOKING_HORIZON_DAYS} days out`,
    }),
});

export type HoldRequest = z.infer<typeof holdRequestSchema>;

export const holdResponseSchema = z.object({
  holdId: z.string().uuid(),
  doctorId: z.string().uuid(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type HoldResponse = z.infer<typeof holdResponseSchema>;

export const confirmRequestSchema = z.object({
  symptoms: z
    .string()
    .trim()
    .min(3, 'must describe the symptoms in at least a few words')
    .max(4000, 'is too long'),
});

export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;

export const appointmentStatusSchema = z.enum(['confirmed', 'completed', 'cancelled', 'no_show']);

export const appointmentSchema = z.object({
  id: z.string().uuid(),
  doctorId: z.string().uuid(),
  doctorName: z.string(),
  patientId: z.string().uuid(),
  patientName: z.string(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  status: appointmentStatusSchema,
  symptoms: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type Appointment = z.infer<typeof appointmentSchema>;

export const cancelAppointmentRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentRequestSchema>;
