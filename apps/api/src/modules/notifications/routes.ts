import {
  listDeadLettersResponseSchema,
  notificationSummaryResponseSchema,
  retryNotificationResponseSchema,
  type DeadLetterNotification,
} from '@health/contracts';
import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { requireRole } from '../auth/guards.js';
import { NotFoundError } from '../../shared/errors.js';

import { countByStatus, listDeadLetters, retryDeadLetter, type OutboxRow } from './outbox-store.js';

const idParamSchema = z.object({ id: z.string().uuid() });

function toDeadLetter(row: OutboxRow): DeadLetterNotification {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    recipientId: row.recipientId,
    channel: row.channel,
    type: row.type,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The human safety net the transactional outbox pattern depends on. Nothing here is ever silently
 * dropped — a notification that has exhausted its automatic retries lands here, visible, with a
 * one-click way to give it a fresh set of attempts once whatever was wrong has been fixed.
 */
export const adminNotificationRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.addHook('preHandler', requireRole('admin'));

  app.get(
    '/summary',
    { schema: { response: { 200: notificationSummaryResponseSchema } } },
    async (request, reply) => {
      const summary = await countByStatus(request.server.db);
      return reply.status(200).send(summary);
    },
  );

  app.get(
    '/dead-letter',
    { schema: { response: { 200: listDeadLettersResponseSchema } } },
    async (request, reply) => {
      const rows = await listDeadLetters(request.server.db);
      return reply.status(200).send(rows.map(toDeadLetter));
    },
  );

  app.post(
    '/:id/retry',
    { schema: { params: idParamSchema, response: { 200: retryNotificationResponseSchema } } },
    async (request, reply) => {
      const retried = await retryDeadLetter(request.server.db, request.params.id);
      if (!retried) {
        throw new NotFoundError('No dead-lettered notification with that id.');
      }
      return reply.status(200).send({ retried: true });
    },
  );

  done();
};
