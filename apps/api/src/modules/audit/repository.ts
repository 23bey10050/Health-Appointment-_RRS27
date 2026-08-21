import { and, count, desc, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { auditLog, users } from '../../db/schema.js';

export interface AuditLogRow {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ListAuditLogFilter {
  actorId?: string;
  action?: string;
  entityType?: string;
  page: number;
  pageSize: number;
}

export interface ListAuditLogResult {
  items: AuditLogRow[];
  total: number;
}

/**
 * The append-only trail `shared/audit.ts` writes to throughout the API, read back for an admin -
 * newest first, since someone investigating "what just happened" almost never wants the oldest row
 * first. The bigint primary key is turned into a plain string at this one boundary, the same way
 * every other Postgres type this app cannot hand straight to JSON already gets converted exactly
 * once, at the edge of the database layer, rather than at every place that later reads it.
 */
export async function listAuditLog(
  database: Database,
  filter: ListAuditLogFilter,
): Promise<ListAuditLogResult> {
  const conditions = [];
  if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
  if (filter.action) conditions.push(eq(auditLog.action, filter.action));
  if (filter.entityType) conditions.push(eq(auditLog.entityType, filter.entityType));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const columns = {
    id: auditLog.id,
    actorId: auditLog.actorId,
    actorName: users.fullName,
    action: auditLog.action,
    entityType: auditLog.entityType,
    entityId: auditLog.entityId,
    metadata: auditLog.metadata,
    createdAt: auditLog.createdAt,
  };

  const [items, totals] = await Promise.all([
    database.db
      .select(columns)
      .from(auditLog)
      // A row with no actor (a failed login by an email that was never a real account, say) must
      // still come back - a left join, not an inner one, is what keeps it from silently vanishing.
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize),
    database.db.select({ total: count() }).from(auditLog).where(whereClause),
  ]);

  return {
    items: items.map((row) => ({
      ...row,
      id: row.id.toString(),
      metadata: row.metadata as Record<string, unknown> | null,
    })),
    total: totals[0]?.total ?? 0,
  };
}
