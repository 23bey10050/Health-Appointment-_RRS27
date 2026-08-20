import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import type { AppConfig } from './config/env.js';
import type { Database } from './db/client.js';
import { authRoutes } from './modules/auth/routes.js';
import { adminDoctorRoutes, publicDoctorRoutes } from './modules/doctors/routes.js';
import { healthRoutes } from './routes/health.js';
import { registerErrorHandler } from './shared/error-handler.js';
import { buildLoggerOptions } from './shared/logging.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
  }
}

export interface ServerDependencies {
  config: AppConfig;
  db: Database;
}

/**
 * Assembles the API and hands it back without opening a port.
 *
 * Keeping `listen` out of this function is what makes the whole app testable: a test builds the
 * same server a real deploy does, passes a stand-in database, and fires requests straight at it
 * with `inject` — no port to bind, nothing to clash with a second test running beside it.
 */
export async function buildServer({ config, db }: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    // Every request gets an id that appears in the logs and in any error we return, so a user
    // saying "it broke" can be matched to the exact request without guessing.
    genReqId: () => randomUUID(),
    // Render terminates TLS in front of us, so the client's real IP and protocol arrive as
    // forwarding headers. Without this, rate limiting would see every request as one IP.
    trustProxy: config.isProduction,
    // A booking payload is small. Capping the body stops a huge upload from eating the memory of
    // a 512 MB instance.
    bodyLimit: 256 * 1024,
  });

  app.decorate('config', config);
  app.decorate('db', db);

  // Every route's schema is a Zod object; these two compilers are what turns that into actual
  // request validation and response serialization instead of just a type-level decoration.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    // This API answers JSON to a separate front-end origin and never serves a page itself, so the
    // browser-page directives do not apply and would only add noise to every response.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  registerErrorHandler(app);

  await app.register(rateLimit, {
    // The everyday ceiling for ordinary traffic. Auth routes set their own tighter limits below;
    // this one exists so nothing on the API is completely unbounded.
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // In-memory is deliberate, not a shortcut: the app runs as one process on the free tier (see
    // the scheduling decision in the project plan), so there is no second instance for a shared
    // Redis-backed limiter to coordinate with, and skipping Redis here is the same call that kept
    // it out of the architecture entirely.
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(adminDoctorRoutes, { prefix: '/admin/doctors' });
  await app.register(publicDoctorRoutes, { prefix: '/doctors' });

  return app;
}
