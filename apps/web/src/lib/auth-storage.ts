const REFRESH_TOKEN_KEY = 'health-appointment.refreshToken';

/**
 * The refresh token is the one credential that has to survive a page reload - the access token
 * deliberately does not (see session.ts) - so it is the only thing this app ever puts in
 * localStorage. Every call here is wrapped, because private browsing and some locked-down
 * corporate browsers throw on `localStorage` access rather than just returning null, and a
 * storage quirk should never be the reason the whole app fails to load.
 */
export function loadStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeRefreshToken(token: string): void {
  try {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  } catch {
    // Storage unavailable - the session simply will not survive a reload, which is a worse
    // experience than a crash but not one worth crashing over.
  }
}

export function clearStoredRefreshToken(): void {
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Nothing to clean up if we could never write it in the first place.
  }
}
