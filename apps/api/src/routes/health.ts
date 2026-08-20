import type { HealthResponse, ReadinessResponse } from '@health/contracts';
import type { FastifyPluginCallback } from 'fastify';

import { APP_VERSION } from '../shared/version.js';

/**
 * Two probes that answer two different questions.
 *
 * `/health` asks "is this process alive?" and touches nothing else. The keep-alive ping hits it
 * every few minutes to stop the free hosting tier from falling asleep, so it has to stay fast and
 * has to keep answering even while the database is down — otherwise a database blip would let the
 * whole service go to sleep on top of it.
 *
 * `/ready` asks the harder question, "can this process actually serve a patient right now?", and
 * that means checking the database.
 */
export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: APP_VERSION,
    };
  });

  app.get('/ready', async (_request, reply): Promise<ReadinessResponse> => {
    const database = await app.db.ping();

    // 503 rather than 500: nothing is broken in our code, the dependency is simply not there yet.
    // Load balancers and uptime checks read that difference correctly.
    if (!database.ok) {
      reply.status(503);
    }

    return {
      status: database.ok ? 'ok' : 'degraded',
      checks: { database },
    };
  });

  done();
};
