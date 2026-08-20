import type { Logger } from './logging.js';

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  /** Whether to run once immediately at startup rather than waiting a full interval first.
   *  Defaults to true — the outbox worker in particular should catch up on anything that was
   *  queued while the process was down the moment it comes back, not sit idle for its first tick. */
  runImmediately?: boolean;
}

export interface RunningScheduler {
  stop: () => void;
}

/**
 * Runs a small set of background jobs on their own fixed intervals, inside this same process.
 *
 * This is deliberately not `node-cron`. Every job this project actually has — drain the outbox,
 * queue due reminders — is "run again every N seconds forever", never "run at 2am" or "run on the
 * first of the month". A fixed interval is the entire feature a cron expression parser would be
 * bought for, so building on `setInterval` gets the same result with one less dependency and one
 * less thing that could be configured wrong.
 *
 * A job's own errors never stop it from running again — `run` is wrapped in a try/catch here so
 * one bad tick is logged and the schedule keeps going, rather than a single failure silently
 * ending the background work for the rest of the process's life.
 */
export function startScheduler(
  jobs: readonly ScheduledJob[],
  logger: Pick<Logger, 'error'>,
): RunningScheduler {
  const timers = jobs.map((job) => {
    const tick = (): void => {
      job.run().catch((error: unknown) => {
        logger.error({ err: error, job: job.name }, `Scheduled job "${job.name}" failed`);
      });
    };

    if (job.runImmediately !== false) {
      tick();
    }

    const timer = setInterval(tick, job.intervalMs);
    // Doesn't keep the process alive on its own - main.ts's own listen() call is what does that.
    // Without this, a test that builds a scheduler and forgets to stop it would hang forever.
    timer.unref();
    return timer;
  });

  return {
    stop: () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
    },
  };
}
