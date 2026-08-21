import { z } from 'zod';

/**
 * One line of the append-only trail `shared/audit.ts` writes to throughout the API. `actorName`
 * rides along here rather than making an admin cross-reference a bare id by hand - the write side
 * only ever stores the id, so the read side is the one place that needs to join it back to a name.
 */
export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const listAuditLogQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(100).optional(),
  entityType: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;

export const listAuditLogResponseSchema = z.object({
  items: z.array(auditLogEntrySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type ListAuditLogResponse = z.infer<typeof listAuditLogResponseSchema>;
