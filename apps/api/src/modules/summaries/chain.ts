import type { ZodType } from 'zod';

import { describeUnknownError } from '../../shared/errors.js';

import type { SummaryPrompt, SummaryProvider } from './provider.js';

/** How long we give the first provider a second try before moving on. Chosen to be a real pause -
 *  long enough that a momentary rate limit has a chance to clear - without keeping a patient's
 *  booking request waiting, since this whole chain runs after the response has already gone out. */
const RETRY_BACKOFF_MS = 300;

export interface SummaryAttempt {
  provider: string;
  outcome: 'success' | 'timeout' | 'invalid_json' | 'schema_mismatch' | 'error';
  latencyMs: number;
  detail?: string;
}

export interface SummaryChainResult<T> {
  attempts: SummaryAttempt[];
  success?: { value: T; provider: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A model asked for "nothing but JSON" still occasionally wraps its answer in a markdown code
 * fence out of habit. Stripping one off before parsing costs nothing and saves a real answer from
 * being thrown away as `invalid_json` over formatting rather than substance.
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

type AttemptOutcome<T> =
  { ok: true; attempt: SummaryAttempt; value: T } | { ok: false; attempt: SummaryAttempt };

async function attemptOnce<T>(
  provider: SummaryProvider,
  prompt: SummaryPrompt,
  schema: ZodType<T>,
): Promise<AttemptOutcome<T>> {
  const startedAt = performance.now();
  const latencyMs = (): number => Math.round(performance.now() - startedAt);

  let raw: string;
  try {
    raw = await provider.complete(prompt);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      attempt: {
        provider: provider.name,
        outcome: timedOut ? 'timeout' : 'error',
        latencyMs: latencyMs(),
        detail: describeUnknownError(error),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw)) as unknown;
  } catch {
    return {
      ok: false,
      attempt: {
        provider: provider.name,
        outcome: 'invalid_json',
        latencyMs: latencyMs(),
        detail: raw.slice(0, 200),
      },
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      attempt: {
        provider: provider.name,
        outcome: 'schema_mismatch',
        latencyMs: latencyMs(),
        detail: result.error.issues.map((issue) => issue.message).join('; '),
      },
    };
  }

  return {
    ok: true,
    attempt: { provider: provider.name, outcome: 'success', latencyMs: latencyMs() },
    value: result.data,
  };
}

/**
 * Tries each provider in turn until one gives back a real, schema-valid answer.
 *
 * The first provider in the list gets a second try after a short backoff before anything else is
 * attempted - that is Groq in this app, and a 429 or a dropped connection there is usually gone a
 * moment later. Everything after it gets one attempt each. An empty provider list (both AI keys
 * left blank, which this project treats as a normal way to run) skips straight to an empty result,
 * so the caller falls back to its own deterministic template without this ever touching a network.
 */
export async function runSummaryChain<T>(
  providers: readonly SummaryProvider[],
  prompt: SummaryPrompt,
  schema: ZodType<T>,
): Promise<SummaryChainResult<T>> {
  const attempts: SummaryAttempt[] = [];
  const [first, ...rest] = providers;
  if (!first) {
    return { attempts };
  }

  const firstTry = await attemptOnce(first, prompt, schema);
  attempts.push(firstTry.attempt);
  if (firstTry.ok) {
    return { attempts, success: { value: firstTry.value, provider: first.name } };
  }

  await sleep(RETRY_BACKOFF_MS);
  const retry = await attemptOnce(first, prompt, schema);
  attempts.push(retry.attempt);
  if (retry.ok) {
    return { attempts, success: { value: retry.value, provider: first.name } };
  }

  for (const provider of rest) {
    const attempt = await attemptOnce(provider, prompt, schema);
    attempts.push(attempt.attempt);
    if (attempt.ok) {
      return { attempts, success: { value: attempt.value, provider: provider.name } };
    }
  }

  return { attempts };
}
