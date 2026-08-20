import {
  authResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  refreshRequestSchema,
  registerRequestSchema,
  type AuthResponse,
} from '@health/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import {
  login,
  logout,
  refreshSession,
  registerPatient,
  type AuthenticatedResult,
} from './service.js';

/** How hard a client can hammer the two credential-guessing endpoints before being slowed down. */
const LOGIN_RATE_LIMIT = { max: 8, timeWindow: '5 minutes' } as const;
const REGISTER_RATE_LIMIT = { max: 10, timeWindow: '10 minutes' } as const;

function toAuthResponse(result: AuthenticatedResult): AuthResponse {
  return {
    user: result.user,
    tokens: {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
    },
  };
}

// Callback-style, not async: registering routes is synchronous work, and every genuinely
// asynchronous step lives inside the individual route handlers below, not in this function's own
// body — an async function with nothing to await would be lying about doing async work.
export const authRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.post(
    '/register',
    {
      config: { rateLimit: REGISTER_RATE_LIMIT },
      schema: { body: registerRequestSchema, response: { 201: authResponseSchema } },
    },
    async (request, reply) => {
      const result = await registerPatient(request.server.db, request.server.config, request.body, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });
      return reply.status(201).send(toAuthResponse(result));
    },
  );

  app.post(
    '/login',
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      schema: { body: loginRequestSchema, response: { 200: authResponseSchema } },
    },
    async (request, reply) => {
      const result = await login(request.server.db, request.server.config, request.body, {
        userAgent: request.headers['user-agent'],
        ipAddress: request.ip,
      });
      return reply.status(200).send(toAuthResponse(result));
    },
  );

  app.post(
    '/refresh',
    {
      schema: { body: refreshRequestSchema, response: { 200: authResponseSchema } },
    },
    async (request, reply) => {
      const result = await refreshSession(
        request.server.db,
        request.server.config,
        request.body.refreshToken,
        { userAgent: request.headers['user-agent'], ipAddress: request.ip },
      );
      return reply.status(200).send(toAuthResponse(result));
    },
  );

  app.post(
    '/logout',
    {
      schema: { body: logoutRequestSchema, response: { 200: logoutResponseSchema } },
    },
    async (request, reply) => {
      await logout(request.server.db, request.body.refreshToken);
      return reply.status(200).send({ loggedOut: true });
    },
  );

  done();
};
