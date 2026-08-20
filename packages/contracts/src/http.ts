import { z } from 'zod';

/**
 * The one and only error shape this API returns. Every failure — a bad password, a slot that just
 * got taken, a database that fell over — comes back looking like this, so the browser has exactly
 * one branch to write instead of guessing at each endpoint.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    /** A stable machine-readable tag such as SLOT_UNAVAILABLE. Safe to switch on in the UI. */
    code: z.string().min(1),
    /** Written for a human to read. Never contains a stack trace or anything internal. */
    message: z.string().min(1),
    /** Matches the id in the server logs, so a support question can be traced to one request. */
    requestId: z.string().min(1),
    /** Present only when a request failed validation, listing what was wrong and where. */
    details: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Answer from the liveness probe. Deliberately tiny — this endpoint is hit every few minutes. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Answer from the readiness probe. `ok` here means the API can actually serve real traffic, which
 * is a stronger promise than "the process is running".
 */
export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.object({
      ok: z.boolean(),
      latencyMs: z.number().nonnegative().optional(),
      error: z.string().optional(),
    }),
  }),
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
