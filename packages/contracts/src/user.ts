import { z } from 'zod';

/**
 * Who someone is in the clinic. This drives every permission decision in the API, so it lives here
 * rather than in either app — the browser and the server must never disagree on the list.
 */
export const userRoleSchema = z.enum(['patient', 'doctor', 'admin']);

export type UserRole = z.infer<typeof userRoleSchema>;

export const USER_ROLES = userRoleSchema.options;
