import type { LoginRequest, RegisterRequest } from '@health/contracts';

import * as authApi from '../../lib/api/auth.js';
import { clearSession, getStoredRefreshToken, setSession } from '../../lib/session.js';

export async function loginWithPassword(data: LoginRequest): Promise<void> {
  const result = await authApi.login(data);
  setSession(
    { accessToken: result.tokens.accessToken, user: result.user },
    result.tokens.refreshToken,
  );
}

export async function registerPatient(data: RegisterRequest): Promise<void> {
  const result = await authApi.register(data);
  setSession(
    { accessToken: result.tokens.accessToken, user: result.user },
    result.tokens.refreshToken,
  );
}

/** Clears the local session immediately, before the network call - someone who just clicked
 *  "log out" should see it happen right away, not wait on a round trip that only ever confirms
 *  what the browser is about to forget regardless. */
export async function logoutCurrentUser(): Promise<void> {
  const refreshToken = getStoredRefreshToken();
  clearSession();
  if (refreshToken) {
    await authApi.logout(refreshToken).catch(() => {
      // Already logged out locally - a failed revoke on the server just means that refresh
      // token eventually expires on its own instead of being revoked early. Not worth surfacing.
    });
  }
}
