import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShutdownRunner, type ShutdownLogger } from '../src/shared/lifecycle.js';

/**
 * A logger that records instead of printing.
 *
 * The three spies are handed back beside the logger rather than read off it afterwards, because
 * pulling a method off an object to assert on it detaches it from its owner — a habit that breaks
 * the moment the real logger needs `this`.
 */
function createSilentLogger() {
  const info = vi.fn();
  const error = vi.fn();
  const fatal = vi.fn();
  return { logger: { info, error, fatal } satisfies ShutdownLogger, info, error, fatal };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdownRunner', () => {
  it('closes the server before the database, then exits with the code it was given', async () => {
    const order: string[] = [];
    const exit = vi.fn();

    const shutdown = createShutdownRunner({
      closeServer: () => {
        order.push('server');
        return Promise.resolve();
      },
      closeDatabase: () => {
        order.push('database');
        return Promise.resolve();
      },
      logger: createSilentLogger().logger,
      timeoutMs: 5000,
      exit,
    });

    await shutdown('SIGTERM', 0);

    // Order is not cosmetic. Closing the database first would pull the connections out from under
    // requests that are still finishing.
    expect(order).toEqual(['server', 'database']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('ignores a second signal, because platforms often send two', async () => {
    const closeServer = vi.fn(() => Promise.resolve());
    const exit = vi.fn();

    const shutdown = createShutdownRunner({
      closeServer,
      closeDatabase: () => Promise.resolve(),
      logger: createSilentLogger().logger,
      timeoutMs: 5000,
      exit,
    });

    await shutdown('SIGTERM', 0);
    await shutdown('SIGINT', 0);

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits with a failure code when closing throws', async () => {
    const { logger, error } = createSilentLogger();
    const exit = vi.fn();

    const shutdown = createShutdownRunner({
      closeServer: () => Promise.reject(new Error('sockets stuck')),
      closeDatabase: () => Promise.resolve(),
      logger,
      timeoutMs: 5000,
      exit,
    });

    await shutdown('SIGTERM', 0);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(error).toHaveBeenCalled();
  });

  it('quits anyway when closing never finishes', async () => {
    const { logger, fatal } = createSilentLogger();
    const exit = vi.fn();

    const shutdown = createShutdownRunner({
      // A server with an open connection that never ends looks exactly like this.
      closeServer: () => new Promise<void>(() => undefined),
      closeDatabase: () => Promise.resolve(),
      logger,
      timeoutMs: 5000,
      exit,
    });

    void shutdown('SIGTERM', 0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(fatal).toHaveBeenCalled();
  });
});
