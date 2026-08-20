import { ConfigError, loadConfig } from './config/env.js';
import { createDatabase } from './db/client.js';
import { buildServer } from './server.js';
import { describeUnknownError } from './shared/errors.js';
import { createShutdownRunner } from './shared/lifecycle.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

async function start(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config);
  const app = await buildServer({ config, db });

  // Hosting platforms send SIGTERM and then kill the process a short while later. Requests already
  // in flight get that window to finish, and the timeout is our promise to leave regardless.
  const shutdown = createShutdownRunner({
    closeServer: () => app.close(),
    closeDatabase: () => db.close(),
    logger: app.log,
    timeoutMs: config.shutdownTimeoutMs,
    exit: (code) => process.exit(code),
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal, 0);
    });
  }

  // A promise that rejects with nobody watching, or an error thrown outside any request, would
  // otherwise take the process down with no explanation in the logs. We log it properly and then
  // still exit, because carrying on after an unknown failure means serving requests from a state
  // we no longer understand. The platform restarts us, and the restart is the recovery.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  await listenWithIpv4Fallback(app, config.port, config.host);

  // The database is checked after the port is open, not before. The server should be reachable and
  // answering /health even when Postgres is still waking up, which is exactly what happens on a
  // free tier that scales to zero.
  const database = await db.ping();
  if (database.ok) {
    app.log.info({ latencyMs: database.latencyMs }, 'Database reachable');
  } else {
    app.log.warn({ error: database.error }, 'Database not reachable yet');
  }
}

/**
 * Opens the port, and quietly copes with the one host that cannot do IPv6.
 *
 * We ask for `::` because a dual-stack socket serves both address families and saves local callers
 * a wasted connection attempt. A few container images ship with IPv6 disabled, and there the bind
 * fails outright — so we fall back to IPv4 rather than refusing to boot over a networking detail.
 */
async function listenWithIpv4Fallback(
  app: Awaited<ReturnType<typeof buildServer>>,
  port: number,
  host: string,
): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (error) {
    const cannotUseIpv6 =
      host === '::' &&
      error instanceof Error &&
      ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes((error as { code?: string }).code ?? '');

    if (!cannotUseIpv6) {
      throw error;
    }

    app.log.warn('IPv6 is unavailable on this host, listening on IPv4 only');
    await app.listen({ port, host: '0.0.0.0' });
  }
}

start().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // No logger exists yet at this point, and this message is the only thing standing between the
    // reader and a confusing crash, so it goes straight to stderr in plain text.
    console.error(`\n${error.message}\n\nFix your .env file and start again.\n`);
    process.exit(78); // EX_CONFIG, the conventional exit code for bad configuration.
  }

  console.error(`Server failed to start: ${describeUnknownError(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
