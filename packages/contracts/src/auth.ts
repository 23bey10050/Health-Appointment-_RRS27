import { z } from 'zod';

import { userRoleSchema } from './user.js';

/**
 * NIST 800-63B recommends judging a password by length, not by forcing a mix of symbols a person
 * will just write on a sticky note. 10 characters is the floor; nothing upstream stops someone from
 * choosing a long passphrase instead. 128 is a ceiling only to stop a client from sending something
 * absurd through the hashing function.
 */
export const passwordSchema = z
  .string()
  .min(10, 'must be at least 10 characters')
  .max(128, 'must be at most 128 characters');

export const emailSchema = z.string().trim().toLowerCase().email('must be a valid email address');

/**
 * The public sign-up form. Deliberately has no `role` field: anyone filling this in becomes a
 * patient, full stop. Doctor and admin accounts are created by an admin in Phase 3, never by
 * someone typing their own role into a form.
 */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1, 'is required').max(200),
  phone: z.string().trim().min(1).max(30).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'is required'),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1, 'is required'),
});

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1, 'is required'),
});

export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const authenticatedUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  fullName: z.string(),
  role: userRoleSchema,
});

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string().datetime(),
});

export type AuthTokens = z.infer<typeof authTokensSchema>;

export const authResponseSchema = z.object({
  user: authenticatedUserSchema,
  tokens: authTokensSchema,
});

export type AuthResponse = z.infer<typeof authResponseSchema>;

export const logoutResponseSchema = z.object({
  loggedOut: z.literal(true),
});
