import {
  listAuditLogResponseSchema,
  listAuditLogQuerySchema,
  type AuditLogEntry,
  type ListAuditLogResponse,
} from '@health/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { requireRole } from '../auth/guards.js';

import { listAuditLog, type AuditLogRow } from './repository.js';

function toAuditLogEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Read-only, admin-only - nothing here ever writes. Filtering by actor, action, or entity type
 *  is what turns an append-only trail meant for "prove what happened" into something an admin can
 *  actually narrow down instead of scrolling through everything the whole clinic has ever done. */
export const adminAuditRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.addHook('preHandler', requireRole('admin'));

  app.get(
    '/',
    {
      schema: {
        querystring: listAuditLogQuerySchema,
        response: { 200: listAuditLogResponseSchema },
      },
    },
    async (request, reply): Promise<ListAuditLogResponse> => {
      const result = await listAuditLog(request.server.db, request.query);
      return reply.status(200).send({
        items: result.items.map(toAuditLogEntry),
        page: request.query.page,
        pageSize: request.query.pageSize,
        total: result.total,
      });
    },
  );

  done();
};
