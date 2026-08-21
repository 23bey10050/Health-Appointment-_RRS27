import {
  authResponseSchema,
  logoutResponseSchema,
  type AuthResponse,
  type LoginRequest,
  type RegisterRequest,
} from '@health/contracts';

import { apiRequest } from '../api-client.js';

export function login(data: LoginRequest): Promise<AuthResponse> {
  return apiRequest('/auth/login', authResponseSchema, { method: 'POST', body: data, auth: false });
}

export function register(data: RegisterRequest): Promise<AuthResponse> {
  return apiRequest('/auth/register', authResponseSchema, {
    method: 'POST',
    body: data,
    auth: false,
  });
}

/** Best-effort - the caller clears the local session regardless of whether this succeeds, since a
 *  refresh token that never reaches the server to be revoked is still gone from this browser. */
export function logout(refreshToken: string): Promise<{ loggedOut: true }> {
  return apiRequest('/auth/logout', logoutResponseSchema, {
    method: 'POST',
    body: { refreshToken },
    auth: false,
  });
}
