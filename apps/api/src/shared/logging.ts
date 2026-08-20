import type { FastifyServerOptions } from 'fastify';

import type { AppConfig } from '../config/env.js';

/**
 * The narrow shape of Pino this project's own code actually calls — used wherever a background job
 * or a provider adapter needs to log something but has no business depending on the whole of Pino's
 * real type. `app.log` satisfies this directly, and a test can hand over a plain object with three
 * `vi.fn()`s instead.
 */
export interface Logger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/**
 * Header and body fields that must never reach a log file. Logs get shipped, searched and shared,
 * so a password or a bearer token sitting in one is a leak even if nobody is looking today.
 */
const SECRET_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.refreshToken',
];

export function buildLoggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  if (config.isTest) {
    return false;
  }

  const base = {
    level: config.logLevel,
    redact: { paths: SECRET_PATHS, remove: true },
    // Fastify's default log line carries the whole request object. Trimming it to the fields we
    // would actually read keeps log volume down, which matters on a free tier with a size cap.
    serializers: {
      req(request: { method: string; url: string; ip: string; id: string }) {
        return {
          id: request.id,
          method: request.method,
          url: request.url,
          ip: request.ip,
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  };

  if (config.isProduction) {
    return base;
  }

  // Locally we want lines a person can scan. pino-pretty is a dev dependency only, so production
  // keeps emitting plain JSON that a log service can parse.
  return {
    ...base,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  };
}
