import {
  googleConnectUrlResponseSchema,
  googleConnectionStatusSchema,
  googleDisconnectResponseSchema,
} from '@health/contracts';
import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { AppConfig } from '../../config/env.js';
import { requireAuth, requireUser } from '../auth/guards.js';
import { ServiceUnavailableError } from '../../shared/errors.js';
import type { GoogleOAuthConfig } from '../../providers/google-oauth.js';

import {
  buildConnectUrl,
  completeConnection,
  disconnect,
  getConnectionStatus,
} from './oauth-service.js';

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

function requireGoogleConfig(config: AppConfig): GoogleOAuthConfig & { encryptionKey: string } {
  const { google } = config;
  if (
    !google.clientId ||
    !google.clientSecret ||
    !google.redirectUri ||
    !google.tokenEncryptionKey
  ) {
    throw new ServiceUnavailableError(
      'Google Calendar sync is not configured on this server. Set GOOGLE_CLIENT_ID, ' +
        'GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and GOOGLE_TOKEN_ENCRYPTION_KEY to enable it.',
    );
  }
  return {
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    redirectUri: google.redirectUri,
    encryptionKey: google.tokenEncryptionKey,
  };
}

function htmlPage(title: string, message: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family: sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center;">` +
    `<h1>${title}</h1><p>${message}</p></body></html>`
  );
}

/**
 * Google's redirect lands a real browser tab on `/callback`, not an API client - which is why
 * that one route answers with a plain HTML page instead of JSON. Nothing here has a frontend to
 * hand the result back to yet (that is Phase 9), so this page is the whole of the response; once
 * a real frontend exists, this becomes a redirect to it instead, with the same logic underneath.
 */
export const calendarAuthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    '/connect',
    {
      preHandler: requireAuth,
      schema: { response: { 200: googleConnectUrlResponseSchema } },
    },
    async (request, reply) => {
      const google = requireGoogleConfig(request.server.config);
      const url = buildConnectUrl(
        google,
        request.server.config.auth.jwtAccessSecret,
        requireUser(request).id,
      );
      return reply.status(200).send({ url });
    },
  );

  app.get('/callback', { schema: { querystring: callbackQuerySchema } }, async (request, reply) => {
    const { code, state, error } = request.query;

    if (error || !code || !state) {
      return reply
        .status(400)
        .type('text/html')
        .send(
          htmlPage(
            'Connection cancelled',
            'Google Calendar was not connected. You can close this tab and try again.',
          ),
        );
    }

    try {
      const google = requireGoogleConfig(request.server.config);
      await completeConnection(
        request.server.db,
        google,
        google.encryptionKey,
        request.server.config.auth.jwtAccessSecret,
        code,
        state,
      );
      return reply
        .status(200)
        .type('text/html')
        .send(htmlPage('Google Calendar connected', 'You can close this tab now.'));
    } catch {
      return reply
        .status(400)
        .type('text/html')
        .send(
          htmlPage(
            'Connection failed',
            'This connection link is invalid or has expired. Please try connecting again.',
          ),
        );
    }
  });

  app.get(
    '/status',
    { preHandler: requireAuth, schema: { response: { 200: googleConnectionStatusSchema } } },
    async (request, reply) => {
      const status = await getConnectionStatus(request.server.db, requireUser(request).id);
      return reply.status(200).send(status);
    },
  );

  app.post(
    '/disconnect',
    { preHandler: requireAuth, schema: { response: { 200: googleDisconnectResponseSchema } } },
    async (request, reply) => {
      const google = requireGoogleConfig(request.server.config);
      await disconnect(request.server.db, requireUser(request).id, google.encryptionKey);
      return reply.status(200).send({ disconnected: true });
    },
  );

  done();
};
