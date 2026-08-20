export interface ShutdownLogger {
  info(details: object, message: string): void;
  error(details: object, message: string): void;
  fatal(details: object, message: string): void;
}

export interface ShutdownOptions {
  /** Stops accepting new requests and waits for the ones already running. */
  closeServer: () => Promise<void>;
  /** Returns every pooled database connection. */
  closeDatabase: () => Promise<void>;
  logger: ShutdownLogger;
  /** How long we wait for the two closes above before giving up and quitting anyway. */
  timeoutMs: number;
  /** Injected so tests can watch it instead of ending the test runner. */
  exit: (code: number) => void;
}

export type ShutdownRunner = (reason: string, exitCode: number) => Promise<void>;

/**
 * Builds the "wind down and quit" routine.
 *
 * It lives in its own file for one reason: shutdown is the code most likely to be wrong and least
 * likely to be noticed, because it only runs on the way out. Pulling it away from the startup
 * script means a test can drive it — including the case where closing hangs.
 *
 * Two behaviours matter here. It runs once no matter how many signals arrive, since a platform
 * often sends SIGTERM and then SIGINT a moment later. And it always ends the process, even if
 * closing the server never finishes, because a deploy that waits forever for the old process is
 * an outage.
 */
export function createShutdownRunner(options: ShutdownOptions): ShutdownRunner {
  let hasStarted = false;

  return async (reason: string, exitCode: number): Promise<void> => {
    if (hasStarted) {
      return;
    }
    hasStarted = true;

    options.logger.info({ reason }, 'Shutting down');

    const forceExit = setTimeout(() => {
      options.logger.fatal({ reason }, 'Shutdown took too long, exiting now');
      options.exit(1);
    }, options.timeoutMs);
    // Without this the pending timer would keep Node alive for the full timeout even after a clean
    // close, turning a fast shutdown into a slow one.
    forceExit.unref();

    let finalCode = exitCode;

    try {
      await options.closeServer();
      await options.closeDatabase();
      options.logger.info({ reason }, 'Shutdown complete');
    } catch (error) {
      options.logger.error({ err: error, reason }, 'Shutdown did not finish cleanly');
      finalCode = 1;
    } finally {
      clearTimeout(forceExit);
      options.exit(finalCode);
    }
  };
}
