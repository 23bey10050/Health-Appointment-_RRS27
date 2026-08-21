import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api-client.js';

/** A 4xx means the request itself was wrong - a slot already taken, a bad password, a missing
 *  appointment - and asking again with the exact same input can only ever fail the exact same
 *  way. Only a network failure or a 5xx is worth retrying, since those are the ones a Render
 *  free-tier cold start actually looks like from the browser's side. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 2;
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 5000);
}

/**
 * One shared client for the whole app. The defaults here are the "deliberate retry and stale
 * times" the plan calls for - not TanStack Query's own defaults, which retry every kind of
 * failure three times and treat everything as instantly stale. A cold start on the free tier
 * looks exactly like a slow network from here, which is what `shouldRetry` is actually tuned for;
 * a rejected login is not the same kind of failure and must never quietly retry itself.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetry,
      retryDelay,
    },
    mutations: {
      // A POST that already reached the server (a hold created, an appointment cancelled) must
      // never be retried blindly - the caller decides case by case, not this default.
      retry: false,
    },
  },
});
