import { describeUnknownError } from '../shared/errors.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const REQUEST_TIMEOUT_MS = 8000;

/** Read-write access to a calendar's events - the narrowest scope that can create and delete a
 *  single event, short of the full `calendar` scope this app has no other reason to ask for. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  scope: string;
}

/** Thrown specifically when Google says a refresh token is dead - revoked by the user, or expired
 *  from disuse - as opposed to a transient network or server problem. Kept as its own error type
 *  so a caller can tell "this connection is genuinely gone" apart from "try again later" without
 *  parsing a message string. */
export class GoogleGrantRevokedError extends Error {
  constructor() {
    super('Google Calendar access has been revoked or has expired. Reconnect to restore it.');
    this.name = 'GoogleGrantRevokedError';
  }
}

/**
 * The URL a user's browser is sent to for Google's consent screen.
 *
 * `access_type=offline` plus `prompt=consent` is the one combination that reliably makes Google
 * hand back a refresh token, not just a short-lived access token - without it, a second connect
 * attempt by the same user gets no refresh token at all, since Google only issues one the first
 * time a user grants consent unless explicitly asked to prompt again.
 */
export function buildGoogleAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToTokenEndpoint(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    throw new Error(`Could not reach Google's token endpoint: ${describeUnknownError(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  const parsed = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!response.ok) {
    if (parsed.error === 'invalid_grant') {
      throw new GoogleGrantRevokedError();
    }
    throw new Error(
      `Google rejected the token request (HTTP ${response.status}, ${parsed.error ?? 'no code'}): ${parsed.error_description ?? 'no message given'}`,
    );
  }
  return parsed;
}

/** The one-time trade of an authorization code for a real token set, right after the user grants
 *  consent. Only this call ever returns a refresh token - every later refresh only renews the
 *  access token, so the original refresh token from here is what gets stored long-term. */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  code: string,
): Promise<GoogleTokenSet> {
  const parsed = await postToTokenEndpoint(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code,
    }),
  );

  if (!parsed.access_token) {
    throw new Error('Google did not return an access token for this authorization code.');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresInSeconds: parsed.expires_in ?? 3600,
    scope: parsed.scope ?? CALENDAR_SCOPE,
  };
}

/** Renews an expired access token using the long-lived refresh token. Throws
 *  `GoogleGrantRevokedError` if the user has revoked access at Google's end since connecting. */
export async function refreshGoogleAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const parsed = await postToTokenEndpoint(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );

  if (!parsed.access_token) {
    throw new Error('Google did not return a new access token on refresh.');
  }
  return { accessToken: parsed.access_token, expiresInSeconds: parsed.expires_in ?? 3600 };
}

/** Best-effort - called when a user disconnects, so Google's own record agrees with ours. A
 *  failure here is not worth blocking the disconnect over: the local token row is already gone
 *  either way, which is what actually stops this app from touching that user's calendar again. */
export async function revokeGoogleToken(token: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // Deliberately swallowed - see the comment above.
  } finally {
    clearTimeout(timeout);
  }
}
