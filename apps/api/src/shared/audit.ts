import type { DbTransaction } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/** Runs inside either a plain Db or a transaction — both expose the same `.insert(...)`. */
type Writable = Pick<DbTransaction, 'insert'>;

export interface AuditEntry {
  /** Who did this. Left out entirely for actions with no logged-in actor, such as a failed login. */
  actorId?: string;
  /** A short, consistent verb such as `login_succeeded` or `appointment_cancelled`. */
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Writes one line to the append-only audit trail.
 *
 * Takes whatever database handle the caller already has — plain or mid-transaction — so an audit
 * row can be written in the same transaction as the change it describes. That matters here in
 * particular: a login failure and its audit entry either both happen or neither does, so "who tried
 * to log in and failed, and when" can never go missing because of a crash between the two writes.
 */
export async function writeAuditEntry(db: Writable, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? null,
  });
}
