import type { UserRole } from '@health/contracts';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

import { UnauthorizedError, ForbiddenError } from '../../shared/errors.js';

import { verifyAccessToken } from './tokens.js';

/** Who is making this request, once their access token has checked out. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Reads `request.user` for a route that only runs behind `requireAuth` or `requireRole`, where it
 * is always set by the time a handler body runs. Throwing here instead of asserting with `!` means
 * a route wired up without its guard fails loudly with a clear message the moment it is hit, rather
 * than crashing later on `undefined.id` somewhere less obvious.
 */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new Error(
      'request.user is not set. This route is missing its requireAuth/requireRole preHandler.',
    );
  }
  return request.user;
}

const BEARER_PREFIX = 'Bearer ';

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;

  if (!header?.startsWith(BEARER_PREFIX)) {
    throw new UnauthorizedError(
      'MISSING_TOKEN',
      'Sign in and send your access token as "Authorization: Bearer <token>".',
    );
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    throw new UnauthorizedError('MISSING_TOKEN', 'The Authorization header has no token in it.');
  }

  return token;
}

/** The actual check, kept separate from Fastify's hook plumbing so it is just a function call. */
function authenticate(request: FastifyRequest): AuthenticatedUser {
  const token = extractBearerToken(request);
  const result = verifyAccessToken(token, request.server.config.auth.jwtAccessSecret);

  if (!result.valid) {
    const message =
      result.reason === 'expired'
        ? 'Your session has expired. Please sign in again.'
        : 'That access token is not valid.';
    throw new UnauthorizedError(
      result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      message,
    );
  }

  return { id: result.payload.sub, role: result.payload.role };
}

/**
 * Confirms the caller is signed in and attaches who they are to the request.
 *
 * Written in Fastify's three-argument hook style and calling `done()` explicitly, not as a plain
 * function that just returns. A `preHandler` only auto-continues when it returns a Promise —
 * Fastify has no other way to tell "finished successfully" apart from "still running" for a
 * synchronous function, so a sync hook that never calls `done()` hangs the request forever rather
 * than erroring, which is what happened here until this was caught by an integration test.
 */
export function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  try {
    request.user = authenticate(request);
    done();
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Builds a Fastify `preHandler` that only lets the given roles through.
 *
 * Runs the same check `requireAuth` does — a route only ever needs one of the two, never both, so
 * there is no route that is authenticated but role-blind by accident.
 */
export function requireRole(...allowedRoles: readonly UserRole[]) {
  if (allowedRoles.length === 0) {
    throw new Error('requireRole() needs at least one role — an empty list blocks everyone.');
  }

  return function roleGuard(
    request: FastifyRequest,
    _reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    try {
      const user = authenticate(request);
      if (!allowedRoles.includes(user.role)) {
        throw new ForbiddenError('Your account type cannot do that.');
      }
      request.user = user;
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  };
}
