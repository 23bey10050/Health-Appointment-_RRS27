import { z } from 'zod';

export const urgencyLevelSchema = z.enum(['low', 'medium', 'high']);
export type UrgencyLevel = z.infer<typeof urgencyLevelSchema>;

/**
 * `not_requested` is the resting state before anything has been asked for. `pending` covers the
 * short window - usually well under a second - while a background call is actually in flight, so
 * a client that reloads mid-request sees "still working" instead of nothing at all.
 */
export const summaryStatusSchema = z.enum(['not_requested', 'pending', 'ready', 'unavailable']);
export type SummaryStatus = z.infer<typeof summaryStatusSchema>;

/** One line of a prescription, written by the doctor and later read back by the AI summary and,
 *  in a future phase, the medication reminder builder - so its shape is shared, not duplicated. */
export const prescriptionItemSchema = z.object({
  drug: z.string().trim().min(1).max(200),
  dosage: z.string().trim().min(1).max(100),
  timesPerDay: z.number().int().min(1).max(12),
  durationDays: z.number().int().min(1).max(365),
  instructions: z.string().trim().max(500).optional(),
});
export type PrescriptionItem = z.infer<typeof prescriptionItemSchema>;

/**
 * What the pre-visit AI call is asked to hand back. `suggestedQuestions` is deliberately not
 * pinned to exactly three - a model that comes back with two good questions instead of three
 * should not be thrown away and replaced with a template just because it missed a count.
 */
export const previsitSummarySchema = z.object({
  urgency: urgencyLevelSchema,
  chiefComplaint: z.string().trim().min(1).max(300),
  suggestedQuestions: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
});
export type PrevisitSummary = z.infer<typeof previsitSummarySchema>;

/** What the post-visit AI call is asked to hand back. Deliberately has no medication field of its
 *  own - the doctor's own `prescription` is already the exact, non-hallucination-risk source for
 *  drug names and doses, so the AI's only job here is the plain-language wrapper around it. */
export const postvisitSummarySchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  followUpSteps: z.array(z.string().trim().min(1).max(300)).max(10),
});
export type PostvisitSummary = z.infer<typeof postvisitSummarySchema>;

export const submitNotesRequestSchema = z.object({
  doctorNotes: z.string().trim().min(3, 'must say something about the visit').max(4000),
  prescription: z.array(prescriptionItemSchema).max(20).default([]),
});
export type SubmitNotesRequest = z.infer<typeof submitNotesRequestSchema>;
