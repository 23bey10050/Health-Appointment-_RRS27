import type { ApiError } from '@health/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { isAppError } from './errors.js';

/**
 * Every failure funnels through here and leaves as the same JSON shape.
 *
 * Two rules drive the whole function. First, a client only ever sees a message we wrote on
 * purpose — an unexpected crash returns a generic line, because a stack trace or a raw Postgres
 * error tells an attacker about our schema. Second, nothing is silently swallowed: whatever we
 * hide from the response is written to the log against the same request id the caller receives,
 * so a user reporting "it failed" can be traced to the exact stack in seconds.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      request.log.info({ err: error }, 'Request failed validation');
      return reply.status(400).send(
        buildBody('VALIDATION_FAILED', 'Some of the values sent were not valid.', requestId, {
          details: error.issues.map((issue) => ({
            path: issue.path.join('.') || '(body)',
            message: issue.message,
          })),
        }),
      );
    }

    if (isAppError(error)) {
      // Expected outcomes are not incidents. Logging them at warn/info keeps the error log
      // meaningful, so anything at error level is genuinely worth looking at.
      const level = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[level]({ err: error, code: error.code }, error.message);
      return reply
        .status(error.statusCode)
        .send(
          buildBody(
            error.code,
            error.message,
            requestId,
            error.details ? { details: error.details } : undefined,
          ),
        );
    }

    // Fastify raises these itself for malformed JSON, oversized bodies and the like. They are the
    // caller's problem, not a bug, so they keep their own status and message.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      request.log.warn({ err: error }, 'Request rejected');
      return reply
        .status(error.statusCode)
        .send(buildBody(error.code ?? 'BAD_REQUEST', error.message, requestId));
    }

    request.log.error({ err: error }, 'Unhandled error while serving request');
    return reply
      .status(500)
      .send(
        buildBody(
          'INTERNAL_ERROR',
          'Something went wrong on our side. Please try again.',
          requestId,
        ),
      );
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .status(404)
      .send(
        buildBody(
          'ROUTE_NOT_FOUND',
          `No route matches ${request.method} ${request.url}.`,
          request.id,
        ),
      );
  });
}

function buildBody(
  code: string,
  message: string,
  requestId: string,
  extra?: { details: readonly { path: string; message: string }[] },
): ApiError {
  return {
    error: {
      code,
      message,
      requestId,
      ...(extra?.details ? { details: [...extra.details] } : {}),
    },
  };
}
