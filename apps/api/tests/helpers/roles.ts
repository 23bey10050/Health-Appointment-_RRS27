import type { UserRole } from '@health/contracts';

import type { Database } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';

import { buildTestConfig } from './test-server.js';

let sequence = 0;

/**
 * A real user row plus a real, correctly signed access token for it — built without touching
 * Argon2 or the login endpoint. RBAC tests only care what role a token carries, and hashing a
 * password for every one of them would make an already-large suite slow for no real benefit. The
 * user row is still real, not skipped, because several routes record who acted (`created_by`),
 * and that column has a foreign key back to `users` — a token for a user that does not exist would
 * fail for a different reason than the one each test is actually checking.
 */
export async function createUserWithToken(
  database: Database,
  role: UserRole,
): Promise<{ id: string; token: string }> {
  sequence += 1;
  const config = buildTestConfig();

  const [row] = await database.db
    .insert(users)
    .values({
      email: `${role}${sequence}@rbac-fixture.test`,
      passwordHash: 'not-a-real-hash',
      role,
      fullName: `${role} fixture ${sequence}`,
    })
    .returning({ id: users.id });

  if (!row) {
    throw new Error('Could not create the RBAC fixture user.');
  }

  const { token } = signAccessToken(
    { sub: row.id, role },
    { secret: config.auth.jwtAccessSecret, ttlSeconds: config.auth.accessTokenTtlSeconds },
  );

  return { id: row.id, token };
}
