import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  GoogleGrantRevokedError,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  type GoogleOAuthConfig,
} from '../../src/providers/google-oauth.js';

const config: GoogleOAuthConfig = {
  clientId: 'the-client-id.apps.googleusercontent.com',
  clientSecret: 'the-client-secret',
  redirectUri: 'http://localhost:4000/auth/google/callback',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildGoogleAuthUrl', () => {
  it('asks for offline access and forces a fresh consent screen, so a refresh token always comes back', () => {
    const url = new URL(buildGoogleAuthUrl(config, 'the-signed-state'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('calendar.events');
    expect(url.searchParams.get('state')).toBe('the-signed-state');
  });
});

describe('exchangeGoogleCode', () => {
  it('posts the authorization_code grant and returns the full token set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: 'a-real-access-token',
        refresh_token: 'a-real-refresh-token',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/calendar.events',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await exchangeGoogleCode(config, 'the-authorization-code');

    expect(tokens).toEqual({
      accessToken: 'a-real-access-token',
      refreshToken: 'a-real-refresh-token',
      expiresInSeconds: 3599,
      scope: 'https://www.googleapis.com/auth/calendar.events',
    });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(options.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-authorization-code');
    expect(body.get('client_secret')).toBe(config.clientSecret);
  });

  it('throws a clear error when Google rejects the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: 'invalid_request', error_description: 'Missing code' }),
        ),
    );

    await expect(exchangeGoogleCode(config, 'bad-code')).rejects.toThrow(
      /invalid_request.*Missing code/s,
    );
  });
});

describe('refreshGoogleAccessToken', () => {
  it('posts the refresh_token grant and returns a new access token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { access_token: 'a-fresh-access-token', expires_in: 3599 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const refreshed = await refreshGoogleAccessToken(config, 'the-stored-refresh-token');

    expect(refreshed).toEqual({ accessToken: 'a-fresh-access-token', expiresInSeconds: 3599 });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(options.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-stored-refresh-token');
  });

  it('throws GoogleGrantRevokedError specifically when Google reports invalid_grant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' })),
    );

    await expect(
      refreshGoogleAccessToken(config, 'a-revoked-refresh-token'),
    ).rejects.toBeInstanceOf(GoogleGrantRevokedError);
  });

  it('throws a generic error, not GoogleGrantRevokedError, for an unrelated failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(500, { error: 'internal_error' })),
    );

    await expect(refreshGoogleAccessToken(config, 'token')).rejects.not.toBeInstanceOf(
      GoogleGrantRevokedError,
    );
  });
});

describe('revokeGoogleToken', () => {
  it('never throws, even when the request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(revokeGoogleToken('a-token')).resolves.toBeUndefined();
  });

  it('never throws on a non-2xx response either', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 400 })));

    await expect(revokeGoogleToken('a-token')).resolves.toBeUndefined();
  });
});
