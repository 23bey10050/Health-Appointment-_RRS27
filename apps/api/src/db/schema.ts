import type { PrescriptionItem } from '@health/contracts';
import {
  bigint,
  boolean,
  date,
  index,
  inet,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tstzrange } from './types/time-range.js';

/**
 * The typed mirror of `migrations/0001_initial_schema.sql`.
 *
 * The SQL file is the authority — it is what actually shapes the database, and it holds the
 * exclusion constraints and triggers that have no equivalent here. This file exists so queries are
 * type-checked and a renamed column breaks the build instead of a request. A test compares the two
 * against a live database so they cannot drift apart unnoticed.
 */

export const userRole = pgEnum('user_role', ['patient', 'doctor', 'admin']);
export const appointmentStatus = pgEnum('appointment_status', [
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
]);
export const urgencyLevel = pgEnum('urgency_level', ['low', 'medium', 'high']);
export const summaryStatus = pgEnum('summary_status', [
  'not_requested',
  'pending',
  'ready',
  'unavailable',
]);
export const notificationChannel = pgEnum('notification_channel', ['email', 'calendar']);
export const notificationType = pgEnum('notification_type', [
  'booking_confirmation',
  'reminder_24h',
  'reminder_1h',
  'cancellation',
  'reschedule',
  'leave_conflict',
  'medication_reminder',
  'postvisit_summary',
]);
export const notificationStatus = pgEnum('notification_status', [
  'queued',
  'sent',
  'failed',
  'dead_letter',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Declared as text here because Drizzle has no citext helper. The column really is citext, which
  // is what makes the lookup case-insensitive; the difference never shows up in TypeScript.
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_refresh_tokens_family').on(table.familyId),
    index('idx_refresh_tokens_user').on(table.userId),
  ],
);

export const doctorProfiles = pgTable('doctor_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  specialization: text('specialization').notNull(),
  bio: text('bio'),
  slotDurationMins: smallint('slot_duration_mins').notNull().default(20),
  consultationFee: numeric('consultation_fee', { precision: 10, scale: 2 }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const doctorWorkingHours = pgTable(
  'doctor_working_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorProfiles.userId, { onDelete: 'cascade' }),
    // 0 is Sunday, matching JavaScript's getDay() so no conversion is ever needed.
    dayOfWeek: smallint('day_of_week').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_working_hours_doctor').on(table.doctorId, table.dayOfWeek)],
);

export const doctorLeaves = pgTable(
  'doctor_leaves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorProfiles.userId, { onDelete: 'cascade' }),
    leaveDate: date('leave_date').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('doctor_leaves_doctor_id_leave_date_key').on(table.doctorId, table.leaveDate),
    index('idx_leaves_date').on(table.leaveDate),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorProfiles.userId, { onDelete: 'restrict' }),
    // The exclusion constraint that makes double-booking impossible is attached to this column in
    // the SQL migration. Drizzle cannot express it, which is precisely why the SQL file leads.
    slot: tstzrange('slot').notNull(),
    status: appointmentStatus('status').notNull().default('confirmed'),

    symptomsText: text('symptoms_text'),
    symptomsSubmittedAt: timestamp('symptoms_submitted_at', { withTimezone: true }),

    aiUrgency: urgencyLevel('ai_urgency'),
    aiChiefComplaint: text('ai_chief_complaint'),
    aiSuggestedQuestions: jsonb('ai_suggested_questions').$type<string[]>(),
    aiPrevisitStatus: summaryStatus('ai_previsit_status').notNull().default('not_requested'),
    aiPrevisitProvider: text('ai_previsit_provider'),

    doctorNotes: text('doctor_notes'),
    prescription: jsonb('prescription').$type<PrescriptionItem[]>(),
    notesSubmittedAt: timestamp('notes_submitted_at', { withTimezone: true }),

    aiPostvisitSummary: text('ai_postvisit_summary'),
    aiPostvisitSteps: jsonb('ai_postvisit_steps').$type<string[]>(),
    aiPostvisitStatus: summaryStatus('ai_postvisit_status').notNull().default('not_requested'),
    aiPostvisitProvider: text('ai_postvisit_provider'),

    googleEventIdPatient: text('google_event_id_patient'),
    googleEventIdDoctor: text('google_event_id_doctor'),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancellationReason: text('cancellation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_appointments_patient').on(table.patientId, table.createdAt)],
);

export const slotHolds = pgTable(
  'slot_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctorProfiles.userId, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slot: tstzrange('slot').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_slot_holds_expiry').on(table.expiresAt)],
);

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'cascade',
    }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull(),
    type: notificationType('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: notificationStatus('status').notNull().default('queued'),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [index('idx_outbox_appointment').on(table.appointmentId)],
);

export const medicationReminders = pgTable(
  'medication_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    drugName: text('drug_name').notNull(),
    dosage: text('dosage'),
    instructions: text('instructions'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_medication_reminders_patient').on(table.patientId, table.scheduledAt)],
);

export const googleOauthTokens = pgTable('google_oauth_tokens', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scope: text('scope'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_audit_actor').on(table.actorId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type DoctorProfile = typeof doctorProfiles.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;
export type SlotHold = typeof slotHolds.$inferSelect;
export type OutboxMessage = typeof notificationOutbox.$inferSelect;
export type MedicationReminder = typeof medicationReminders.$inferSelect;
