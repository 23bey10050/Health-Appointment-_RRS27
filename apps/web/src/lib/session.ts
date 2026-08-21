import type { AuthenticatedUser } from '@health/contracts';

import {
  clearStoredRefreshToken,
  loadStoredRefreshToken,
  storeRefreshToken,
} from './auth-storage.js';

export interface Session {
  accessToken: string;
  user: AuthenticatedUser;
}

/**
 * The access token lives here, in memory, and nowhere else - not localStorage, not a cookie. It
 * is gone the moment the tab closes or reloads, which is exactly the point: a 15-minute token
 * sitting in localStorage is a 15-minute window for any XSS bug this app might ever have to steal
 * a live session, and a plain module-level variable has no such window. Losing it on reload is a
 * small cost, paid back automatically by the refresh token in auth-storage.ts on the next load.
 */
let currentSession: Session | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getSession(): Session | null {
  return currentSession;
}

export function getStoredRefreshToken(): string | null {
  return loadStoredRefreshToken();
}

/** Called after login, register, or a refresh - all three hand back the same {user, tokens} shape. */
export function setSession(session: Session, refreshToken: string): void {
  currentSession = session;
  storeRefreshToken(refreshToken);
  notify();
}

export function clearSession(): void {
  currentSession = null;
  clearStoredRefreshToken();
  notify();
}

/** Lets `useAuth` (session-react.ts) subscribe to changes from outside React - the api client
 *  updates this store from a plain fetch wrapper that has no component tree to live in. */
export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
