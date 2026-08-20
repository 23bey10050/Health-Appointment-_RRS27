import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/db/client.js';
import { refreshTokens } from '../../../src/db/schema.js';
import {
  createRefreshTokenFamily,
  findRefreshTokenForUpdate,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
} from '../../../src/modules/auth/refresh-token-store.js';
import { createTestDatabase, resetDatabase } from '../../helpers/database.js';
import { createPatient } from '../../helpers/fixtures.js';

let database: Database;
let patientId: string;

beforeAll(() => {
  database = createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await resetDatabase(database);
  patientId = await createPatient(database);
});

describe('createRefreshTokenFamily', () => {
  it('starts a family with one unused, unrevoked token', async () => {
    const issued = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));

    const lookup = await database.transaction((tx) => findRefreshTokenForUpdate(tx, issued.token));

    expect(lookup.outcome).toBe('valid');
  });
});

describe('findRefreshTokenForUpdate', () => {
  it('reports not_found for a token that was never issued', async () => {
    const lookup = await database.transaction((tx) =>
      findRefreshTokenForUpdate(tx, 'a-token-nobody-ever-issued'),
    );

    expect(lookup).toEqual({ outcome: 'not_found' });
  });

  it('reports expired for a token past its expiry', async () => {
    const issued = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));
    await database.db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.userId, patientId));

    const lookup = await database.transaction((tx) => findRefreshTokenForUpdate(tx, issued.token));

    expect(lookup.outcome).toBe('expired');
  });

  it('reports reused for a token already marked used', async () => {
    const issued = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));
    await database.transaction(async (tx) => {
      const lookup = await findRefreshTokenForUpdate(tx, issued.token);
      if (lookup.outcome === 'valid') {
        await rotateRefreshToken(tx, lookup.row, 30);
      }
    });

    const secondLookup = await database.transaction((tx) =>
      findRefreshTokenForUpdate(tx, issued.token),
    );

    expect(secondLookup.outcome).toBe('reused');
  });

  it('reports reused for a token that was explicitly revoked', async () => {
    const issued = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));
    await database.transaction(async (tx) => {
      const lookup = await findRefreshTokenForUpdate(tx, issued.token);
      if (lookup.outcome === 'valid') {
        await revokeRefreshToken(tx, lookup.row.id, 'logout');
      }
    });

    const secondLookup = await database.transaction((tx) =>
      findRefreshTokenForUpdate(tx, issued.token),
    );

    expect(secondLookup.outcome).toBe('reused');
  });
});

describe('rotateRefreshToken', () => {
  it('keeps the replacement in the same family as the token it replaces', async () => {
    const issued = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));

    const rotated = await database.transaction(async (tx) => {
      const lookup = await findRefreshTokenForUpdate(tx, issued.token);
      if (lookup.outcome !== 'valid') throw new Error('expected a valid lookup');
      return rotateRefreshToken(tx, lookup.row, 30);
    });

    expect(rotated.familyId).toBe(issued.familyId);
    expect(rotated.token).not.toBe(issued.token);
  });

  it('makes the new token immediately usable', async () => {
    const issued = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));

    const rotated = await database.transaction(async (tx) => {
      const lookup = await findRefreshTokenForUpdate(tx, issued.token);
      if (lookup.outcome !== 'valid') throw new Error('expected a valid lookup');
      return rotateRefreshToken(tx, lookup.row, 30);
    });

    const lookup = await database.transaction((tx) => findRefreshTokenForUpdate(tx, rotated.token));
    expect(lookup.outcome).toBe('valid');
  });
});

describe('revokeRefreshTokenFamily', () => {
  it('revokes every live token descended from one session, not just the newest', async () => {
    const first = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));
    const second = await database.transaction(async (tx) => {
      const lookup = await findRefreshTokenForUpdate(tx, first.token);
      if (lookup.outcome !== 'valid') throw new Error('expected a valid lookup');
      return rotateRefreshToken(tx, lookup.row, 30);
    });

    await database.transaction((tx) =>
      revokeRefreshTokenFamily(tx, second.familyId, 'reuse_detected'),
    );

    const rows = await database.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, second.familyId));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokeReason).toBe('reuse_detected');
    }
  });

  it('does not touch a different family', async () => {
    const mine = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));
    const otherPatientId = await createPatient(database);
    const someoneElses = await database.transaction((tx) =>
      createRefreshTokenFamily(tx, otherPatientId, 30),
    );

    await database.transaction((tx) =>
      revokeRefreshTokenFamily(tx, mine.familyId, 'reuse_detected'),
    );

    const [untouched] = await database.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, someoneElses.familyId));

    expect(untouched?.revokedAt).toBeNull();
  });
});

describe('revokeRefreshToken', () => {
  it('revokes exactly the token asked for, leaving the rest of the family alone', async () => {
    const first = await database.transaction((tx) => createRefreshTokenFamily(tx, patientId, 30));
    const second = await database.transaction(async (tx) => {
      const lookup = await findRefreshTokenForUpdate(tx, first.token);
      if (lookup.outcome !== 'valid') throw new Error('expected a valid lookup');
      return rotateRefreshToken(tx, lookup.row, 30);
    });

    const secondLookup = await database.transaction((tx) =>
      findRefreshTokenForUpdate(tx, second.token),
    );
    if (secondLookup.outcome !== 'valid') throw new Error('expected the rotated token to be valid');

    await database.transaction((tx) => revokeRefreshToken(tx, secondLookup.row.id, 'logout'));

    const rows = await database.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, second.familyId));
    const revokedCount = rows.filter((row) => row.revokedAt !== null).length;

    expect(revokedCount).toBe(1);
  });
});
