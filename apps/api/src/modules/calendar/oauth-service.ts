import type { Database } from '../../db/client.js';
import { ForbiddenError } from '../../shared/errors.js';
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  revokeGoogleToken,
  type GoogleOAuthConfig,
} from '../../providers/google-oauth.js';

import { signOAuthState, verifyOAuthState } from './state-token.js';
import { deleteGoogleTokens, hasGoogleTokens, saveGoogleTokens } from './tokens.js';

export function buildConnectUrl(
  oauthConfig: GoogleOAuthConfig,
  stateSecret: string,
  userId: string,
): string {
  const state = signOAuthState(userId, stateSecret);
  return buildGoogleAuthUrl(oauthConfig, state);
}

/**
 * Finishes the OAuth round trip once Google redirects back with a `code`.
 *
 * The `state` value is the only thing tying this request to a signed-in user - Google's redirect
 * carries no Authorization header at all, so a forged or expired state is treated exactly like an
 * invalid login: a `ForbiddenError` rather than a hint about what specifically was wrong with it.
 */
export async function completeConnection(
  database: Database,
  oauthConfig: GoogleOAuthConfig,
  encryptionKey: string,
  stateSecret: string,
  code: string,
  state: string,
): Promise<void> {
  const userId = verifyOAuthState(state, stateSecret);
  if (!userId) {
    throw new ForbiddenError(
      'This connection link is invalid or has expired. Please try connecting again.',
    );
  }

  const tokens = await exchangeGoogleCode(oauthConfig, code);
  await saveGoogleTokens(database, userId, tokens, encryptionKey);
}

export async function getConnectionStatus(
  database: Database,
  userId: string,
): Promise<{ connected: boolean }> {
  return { connected: await hasGoogleTokens(database, userId) };
}

/** Deletes the local connection and makes a best-effort attempt to revoke it at Google's end too
 *  - see `revokeGoogleToken`'s own comment for why that second part is not allowed to block this. */
export async function disconnect(
  database: Database,
  userId: string,
  encryptionKey: string,
): Promise<void> {
  const accessToken = await deleteGoogleTokens(database, userId, encryptionKey);
  if (accessToken) {
    await revokeGoogleToken(accessToken);
  }
}
