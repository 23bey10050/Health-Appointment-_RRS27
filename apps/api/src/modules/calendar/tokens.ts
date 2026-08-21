import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { googleOauthTokens } from '../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../shared/crypto.js';
import {
  refreshGoogleAccessToken,
  type GoogleOAuthConfig,
  type GoogleTokenSet,
} from '../../providers/google-oauth.js';

/** A token is refreshed a little before its real expiry, not right at it - otherwise a call that
 *  starts an instant before expiry could still land on Google's side after it, and fail for a
 *  reason this app could easily have avoided. */
const REFRESH_SKEW_SECONDS = 60;

/** Stores a freshly connected account's tokens, encrypted. Only called right after the OAuth
 *  callback, which is the one moment Google is guaranteed to hand back a refresh token - later
 *  refreshes only ever renew the access token, so nothing else touches this row's refresh token. */
export async function saveGoogleTokens(
  database: Database,
  userId: string,
  tokens: GoogleTokenSet,
  encryptionKey: string,
): Promise<void> {
  if (!tokens.refreshToken) {
    throw new Error(
      'Google did not return a refresh token for this connection - access_type=offline and ' +
        'prompt=consent should always produce one, so something about the auth request was wrong.',
    );
  }

  await database.db
    .insert(googleOauthTokens)
    .values({
      userId,
      accessTokenEncrypted: encryptSecret(tokens.accessToken, encryptionKey),
      refreshTokenEncrypted: encryptSecret(tokens.refreshToken, encryptionKey),
      expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      scope: tokens.scope,
    })
    .onConflictDoUpdate({
      target: googleOauthTokens.userId,
      set: {
        accessTokenEncrypted: encryptSecret(tokens.accessToken, encryptionKey),
        refreshTokenEncrypted: encryptSecret(tokens.refreshToken, encryptionKey),
        expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
        scope: tokens.scope,
      },
    });
}

/**
 * Hands back a real, currently-valid access token for this user, refreshing it first if needed -
 * or undefined if they have never connected Google Calendar at all, which is a normal, expected
 * outcome here, not a failure. A revoked or expired refresh token surfaces as a thrown
 * `GoogleGrantRevokedError` instead, since that case is genuinely worth a caller's attention.
 */
export async function getValidAccessToken(
  database: Database,
  config: GoogleOAuthConfig,
  userId: string,
  encryptionKey: string,
): Promise<string | undefined> {
  const [row] = await database.db
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.userId, userId))
    .limit(1);

  if (!row) {
    return undefined;
  }

  const stillFresh = row.expiresAt.getTime() - REFRESH_SKEW_SECONDS * 1000 > Date.now();
  if (stillFresh) {
    return decryptSecret(row.accessTokenEncrypted, encryptionKey);
  }

  const refreshToken = decryptSecret(row.refreshTokenEncrypted, encryptionKey);
  const refreshed = await refreshGoogleAccessToken(config, refreshToken);

  await database.db
    .update(googleOauthTokens)
    .set({
      accessTokenEncrypted: encryptSecret(refreshed.accessToken, encryptionKey),
      expiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
    })
    .where(eq(googleOauthTokens.userId, userId));

  return refreshed.accessToken;
}

export async function hasGoogleTokens(database: Database, userId: string): Promise<boolean> {
  const [row] = await database.db
    .select({ userId: googleOauthTokens.userId })
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.userId, userId))
    .limit(1);
  return row !== undefined;
}

/** Deletes the stored connection and hands back its still-decryptable access token, if there was
 *  one, so the caller can make a best-effort attempt to revoke it at Google's end too - purely a
 *  courtesy, since deleting this row is what actually stops this app from touching that user's
 *  calendar again regardless of whether the revoke call itself succeeds. */
export async function deleteGoogleTokens(
  database: Database,
  userId: string,
  encryptionKey: string,
): Promise<string | undefined> {
  const [deleted] = await database.db
    .delete(googleOauthTokens)
    .where(eq(googleOauthTokens.userId, userId))
    .returning({ accessTokenEncrypted: googleOauthTokens.accessTokenEncrypted });

  return deleted ? decryptSecret(deleted.accessTokenEncrypted, encryptionKey) : undefined;
}
