import type { AuthenticatedUser } from '@health/contracts';
import type { ZodType } from 'zod';

import { clearSession, getSession, getStoredRefreshToken, setSession } from './session.js';

/** Falls back to the API's own default dev port so `npm run dev` works with zero setup, matching
 *  every other part of this project - a missing .env value degrades to something that still runs,
 *  never a crash. Set VITE_API_URL to point at a deployed API instead. */
const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: { path: string; message: string }[];
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** False for the two endpoints that run before a session exists at all: login and register. */
  auth?: boolean;
}

function buildHeaders(options: RequestOptions): HeadersInit {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false) {
    const session = getSession();
    if (session) {
      headers['Authorization'] = `Bearer ${session.accessToken}`;
    }
  }
  return headers;
}

async function rawFetch(path: string, options: RequestOptions): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: buildHeaders(options),
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

/**
 * At most one refresh call in flight at a time, shared by every request that hits a 401
 * simultaneously - the access token for every open tab and every in-flight request expires at
 * the exact same instant, and refresh tokens rotate on use. Firing one refresh per request would
 * mean only the first actually succeeds; every other one presents an already-used refresh token a
 * moment later and the API reads that as theft, revoking the whole session. Awaiting the same
 * shared promise instead of triggering a new one is what keeps a normal 15-minute expiry from
 * ever looking like a stolen session.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    return false;
  }

  try {
    const response = await rawFetch('/auth/refresh', {
      method: 'POST',
      auth: false,
      body: { refreshToken },
    });
    if (!response.ok) {
      clearSession();
      return false;
    }
    const data = (await response.json()) as {
      user: AuthenticatedUser;
      tokens: { accessToken: string; refreshToken: string };
    };
    setSession({ accessToken: data.tokens.accessToken, user: data.user }, data.tokens.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function refreshOnce(): Promise<boolean> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** The same single-flight refresh the 401 handler below uses, exposed for app start-up: reads
 *  whatever refresh token survived from the last visit and turns it back into a live session
 *  before the first route ever renders. Returns false, quietly, for a first-ever visit with
 *  nothing stored yet - that is not a failure, just nothing to restore. */
export function restoreSession(): Promise<boolean> {
  return refreshOnce();
}

async function parseErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}

/**
 * Every request this app makes goes through here. A 401 caused specifically by an expired access
 * token gets exactly one silent refresh-and-retry before giving up - any other 401 (a missing or
 * genuinely invalid token) means something is wrong that a refresh cannot fix, so it is left to
 * the caller, which is what a route guard uses to decide whether to send someone back to login.
 */
export async function apiRequest<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  let response = await rawFetch(path, options);

  if (response.status === 401 && options.auth !== false) {
    const body = await parseErrorBody(response.clone());
    if (body.error?.code === 'TOKEN_EXPIRED') {
      const refreshed = await refreshOnce();
      if (refreshed) {
        response = await rawFetch(path, options);
      }
    }
  }

  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new ApiError(
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? response.statusText,
      body.error?.details,
    );
  }

  // A 204 has no body to validate at all - the schema for a route shaped this way is only ever
  // `z.void()`, so there is nothing useful `.parse` could check that the status code has not
  // already guaranteed.
  if (response.status === 204) {
    return undefined as T;
  }

  const json: unknown = await response.json();
  return schema.parse(json);
}
