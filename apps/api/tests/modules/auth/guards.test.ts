import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { requireAuth, requireRole } from '../../../src/modules/auth/guards.js';
import { signAccessToken } from '../../../src/modules/auth/tokens.js';
import { AppError } from '../../../src/shared/errors.js';

const SECRET = 'a-test-secret-that-is-long-enough-to-be-real';

/** A Fastify request is a large object; a guard only ever touches these four things. */
function fakeRequest(authorizationHeader?: string): FastifyRequest {
  return {
    headers: authorizationHeader ? { authorization: authorizationHeader } : {},
    server: { config: { auth: { jwtAccessSecret: SECRET } } },
    user: undefined,
  } as unknown as FastifyRequest;
}

const fakeReply = {} as FastifyReply;

function bearer(role: 'patient' | 'doctor' | 'admin', sub = 'user-1'): string {
  return `Bearer ${signAccessToken({ sub, role }, { secret: SECRET, ttlSeconds: 900 }).token}`;
}

/**
 * Runs a Fastify-style three-argument hook and hands back however it finished.
 *
 * A `preHandler` reports success or failure through the `done` callback, not through its return
 * value or a throw — see the comment on `requireAuth` for why that distinction matters. This is
 * the shape every test below needs, so it is built once here.
 */
function runHook(
  hook: (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void) => void,
  request: FastifyRequest,
): { error?: Error } {
  const done = vi.fn();
  hook(request, fakeReply, done);
  expect(done).toHaveBeenCalledTimes(1);
  const [error] = done.mock.calls[0] as [Error | undefined];
  return { error };
}

describe('requireAuth', () => {
  it('attaches the caller to the request when the token is good', () => {
    const request = fakeRequest(bearer('doctor', 'doc-42'));

    const { error } = runHook(requireAuth, request);

    expect(error).toBeUndefined();
    expect(request.user).toEqual({ id: 'doc-42', role: 'doctor' });
  });

  it('rejects a request with no Authorization header at all', () => {
    const request = fakeRequest();

    const { error } = runHook(requireAuth, request);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(401);
    expect((error as AppError).code).toBe('MISSING_TOKEN');
  });

  it('rejects a header that is not the Bearer scheme', () => {
    const request = fakeRequest('Basic dXNlcjpwYXNz');

    const { error } = runHook(requireAuth, request);

    expect((error as AppError).code).toBe('MISSING_TOKEN');
  });

  it('rejects "Bearer" with nothing after it', () => {
    const request = fakeRequest('Bearer ');

    const { error } = runHook(requireAuth, request);

    expect((error as AppError).code).toBe('MISSING_TOKEN');
  });

  it('rejects a token signed with a different secret', () => {
    const wrongSecretToken = signAccessToken(
      { sub: 'user-1', role: 'patient' },
      { secret: 'a-completely-different-secret-value', ttlSeconds: 900 },
    ).token;
    const request = fakeRequest(`Bearer ${wrongSecretToken}`);

    const { error } = runHook(requireAuth, request);

    expect((error as AppError).statusCode).toBe(401);
    expect((error as AppError).code).toBe('INVALID_TOKEN');
  });

  it('never leaves the request hanging - done() is always called exactly once', () => {
    // The bug this guards against: a hook that returns without calling done() does not error, it
    // hangs forever, which runHook's own toHaveBeenCalledTimes(1) assertion would have caught.
    runHook(requireAuth, fakeRequest(bearer('patient')));
    runHook(requireAuth, fakeRequest());
  });
});

describe('requireRole', () => {
  it('lets a caller through when their role is on the list', () => {
    const request = fakeRequest(bearer('admin'));

    const { error } = runHook(requireRole('admin', 'doctor'), request);

    expect(error).toBeUndefined();
    expect(request.user?.role).toBe('admin');
  });

  it('blocks a caller whose role is not on the list, with 403 not 401', () => {
    const request = fakeRequest(bearer('patient'));

    const { error } = runHook(requireRole('admin', 'doctor'), request);

    // 403, because the token itself is perfectly valid - logging in again would not fix anything,
    // which is exactly the distinction between "not authenticated" and "not authorised".
    expect((error as AppError).statusCode).toBe(403);
    expect((error as AppError).code).toBe('FORBIDDEN');
  });

  it('still rejects with 401 when there is no token, before the role is even checked', () => {
    const { error } = runHook(requireRole('patient'), fakeRequest());

    expect((error as AppError).statusCode).toBe(401);
  });

  it('refuses to be built with no roles at all, since that would block every caller silently', () => {
    expect(() => requireRole()).toThrow(/at least one role/);
  });
});
