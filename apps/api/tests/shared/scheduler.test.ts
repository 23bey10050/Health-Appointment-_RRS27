import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startScheduler } from '../../src/shared/scheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function silentLogger() {
  return { error: vi.fn() };
}

describe('startScheduler', () => {
  it('runs a job immediately by default, before the first interval even elapses', async () => {
    const run = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler([{ name: 'job', intervalMs: 60_000, run }], silentLogger());

    // A microtask tick, not a timer - the immediate run is not scheduled through setInterval.
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('skips the immediate run when asked to', async () => {
    const run = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler(
      [{ name: 'job', intervalMs: 60_000, run, runImmediately: false }],
      silentLogger(),
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(run).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('runs again every interval after that', async () => {
    const run = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler([{ name: 'job', intervalMs: 1000, run }], silentLogger());

    await vi.advanceTimersByTimeAsync(3500);

    // One immediate run, plus three full intervals elapsed.
    expect(run).toHaveBeenCalledTimes(4);
    scheduler.stop();
  });

  it("a job's own failure is logged and does not stop the schedule", async () => {
    const run = vi.fn(() => Promise.reject(new Error('this tick went wrong')));
    const logger = silentLogger();
    const scheduler = startScheduler([{ name: 'flaky-job', intervalMs: 1000, run }], logger);

    await vi.advanceTimersByTimeAsync(2500);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'flaky-job' }),
      expect.stringContaining('flaky-job'),
    );
    scheduler.stop();
  });

  it('runs two independent jobs on their own separate schedules', async () => {
    const fast = vi.fn(() => Promise.resolve());
    const slow = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler(
      [
        { name: 'fast', intervalMs: 500, run: fast },
        { name: 'slow', intervalMs: 2000, run: slow },
      ],
      silentLogger(),
    );

    await vi.advanceTimersByTimeAsync(2000);

    // Fast: immediate + 4 intervals of 500ms = 5. Slow: immediate + 1 interval of 2000ms = 2.
    expect(fast).toHaveBeenCalledTimes(5);
    expect(slow).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('stop() prevents any further ticks', async () => {
    const run = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler([{ name: 'job', intervalMs: 1000, run }], silentLogger());
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = run.mock.calls.length;

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(run.mock.calls.length).toBe(callsBeforeStop);
  });
});
