import { useSyncExternalStore } from 'react';

import { getSession, subscribeToSession, type Session } from '../../lib/session.js';

export interface AuthState {
  session: Session | null;
  isAuthenticated: boolean;
}

/** `useSyncExternalStore`, not a Context, because the session it reads is already a single
 *  external store (session.ts) that the api client itself writes to from outside any component -
 *  a Context would just be a second place claiming to own the same state. */
export function useAuth(): AuthState {
  const session = useSyncExternalStore(subscribeToSession, getSession, getSession);
  return { session, isAuthenticated: session !== null };
}
