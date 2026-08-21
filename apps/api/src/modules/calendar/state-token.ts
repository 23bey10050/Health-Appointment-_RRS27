import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Long enough for someone to actually get through Google's consent screen, short enough that a
 * `state` value sitting in a browser's history or a proxy log is not useful to anyone for long.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  userId: string;
  expiresAt: number;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Ties a Google OAuth `state` parameter to the signed-in user who started the connect flow, so
 * the callback - which Google calls with no Authorization header at all - can still know whose
 * tokens it just received, and a forged callback request cannot claim to be anyone else's.
 *
 * Signed with the same secret access tokens use, but in a shape that could never pass for one -
 * `verifyAccessToken` expects a JWT, this is a plain HMAC blob - so the two purposes stay distinct
 * even though they share a key. A second secret just for this would be one more thing to generate
 * and configure for no real security gain over reusing the one already required.
 */
export function signOAuthState(userId: string, secret: string): string {
  const payload: StatePayload = { userId, expiresAt: Date.now() + STATE_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/** Returns the userId a state value was signed for, or undefined for anything forged, expired, or
 *  simply malformed - every failure reason collapses to the same "start over" outcome. */
export function verifyOAuthState(state: string, secret: string): string | undefined {
  const [payloadB64, signature] = state.split('.');
  if (!payloadB64 || !signature) {
    return undefined;
  }

  const expected = sign(payloadB64, secret);
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return undefined;
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return undefined;
  }

  if (typeof payload.userId !== 'string' || payload.expiresAt < Date.now()) {
    return undefined;
  }
  return payload.userId;
}
