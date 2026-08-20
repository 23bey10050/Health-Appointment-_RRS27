/**
 * Postgres error codes we act on by name.
 *
 * The full list is in the Postgres manual under "Error Codes". Only the ones this app makes a real
 * decision about are named here — the rest are genuine bugs and belong in the generic 500 path.
 */
export const PG_ERROR = {
  /** An exclusion constraint rejected the row. For us that means "that slot is already taken". */
  EXCLUSION_VIOLATION: '23P01',
  /** A unique constraint rejected the row, such as an email that is already registered. */
  UNIQUE_VIOLATION: '23505',
  /** A referenced row does not exist, such as booking with a doctor id that was just deleted. */
  FOREIGN_KEY_VIOLATION: '23503',
  /** A CHECK constraint rejected the row. */
  CHECK_VIOLATION: '23514',
  /** Two transactions deadlocked and Postgres picked one to fail. Safe to retry. */
  DEADLOCK_DETECTED: '40P01',
  /** A serialisation failure under a strict isolation level. Also safe to retry. */
  SERIALIZATION_FAILURE: '40001',
} as const;

export type PgErrorCode = (typeof PG_ERROR)[keyof typeof PG_ERROR];

/**
 * Digs the Postgres error code out of whatever was thrown.
 *
 * Query builders wrap the driver's error in one of their own to add the failing SQL, so the code we
 * need is usually one or two levels down under `cause`. Reading `error.code` directly looks right
 * and silently returns nothing, which turns a clean "slot already taken" into an unexplained 500.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  // A fixed number of hops rather than `while (true)`: an error whose cause points back at itself
  // would otherwise spin forever, and nothing legitimate nests this deep.
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const code: unknown = (current as { code?: unknown }).code;
    // Postgres codes are always five characters, which rules out Node's ECONNREFUSED and friends.
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

export function isPostgresError(error: unknown, code: PgErrorCode): boolean {
  return postgresErrorCode(error) === code;
}

/** True when the failure was a timing collision that a retry could still win. */
export function isRetryablePostgresError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === PG_ERROR.DEADLOCK_DETECTED || code === PG_ERROR.SERIALIZATION_FAILURE;
}

/**
 * The name of the constraint that rejected the row.
 *
 * Two exclusion constraints can both mean "already taken" but need different messages — one is a
 * booked appointment, the other is a slot somebody is holding right now.
 */
export function postgresConstraintName(error: unknown): string | undefined {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const constraint: unknown = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && constraint.length > 0) {
      return constraint;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}
