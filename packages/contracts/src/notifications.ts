import { z } from 'zod';

export const notificationChannelSchema = z.enum(['email', 'calendar']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationTypeSchema = z.enum([
  'booking_confirmation',
  'reminder_24h',
  'reminder_1h',
  'cancellation',
  'reschedule',
  'leave_conflict',
  'medication_reminder',
  'postvisit_summary',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationStatusSchema = z.enum(['queued', 'sent', 'failed', 'dead_letter']);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

/**
 * What the admin dashboard's "Notification Health" tab shows for one dead-lettered row — the
 * human safety net for the outbox pattern. Nothing here is the email content itself; an admin
 * diagnosing a stuck notification needs to know what kind of thing failed and why, not re-read the
 * message.
 */
export const deadLetterNotificationSchema = z.object({
  id: z.string().uuid(),
  appointmentId: z.string().uuid().nullable(),
  recipientId: z.string().uuid(),
  channel: notificationChannelSchema,
  type: notificationTypeSchema,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type DeadLetterNotification = z.infer<typeof deadLetterNotificationSchema>;

export const listDeadLettersResponseSchema = z.array(deadLetterNotificationSchema);

export const retryNotificationResponseSchema = z.object({ retried: z.literal(true) });

/** A count per outbox status, for the same "Notification Health" tab - the at-a-glance number
 *  next to the row-by-row dead-letter list below it. */
export const notificationSummaryResponseSchema = z.object({
  queued: z.number().int().min(0),
  sent: z.number().int().min(0),
  failed: z.number().int().min(0),
  dead_letter: z.number().int().min(0),
});
export type NotificationSummaryResponse = z.infer<typeof notificationSummaryResponseSchema>;
