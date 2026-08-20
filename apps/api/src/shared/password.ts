import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP's lightest approved setting for Argon2id: 19 MiB of memory, 2 passes, 1 thread. It is also
 * this library's own default, written out explicitly so the choice is visible in a diff rather than
 * inherited silently. Deliberately not the strongest OWASP option (47 MiB) — a free-tier instance
 * has roughly 512 MB of RAM total, and every concurrent login pays this memory cost, so the lightest
 * setting that is still on the approved list is the responsible one here.
 *
 * `algorithm: 2` is `Algorithm.Argon2id`. The numeric value is written directly instead of
 * importing the `Algorithm` enum, because that enum is declared `const enum` in this library's
 * generated types, and the project's `verbatimModuleSyntax` setting refuses to import const enums
 * as values — each file has to be compilable on its own, and inlining a const enum breaks that.
 */
const HASH_OPTIONS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/**
 * Checks a password against a hash.
 *
 * No options are passed to `verify` on purpose — an Argon2 hash string carries its own algorithm,
 * memory cost, time cost and salt, so `verify` reads them from there. If `HASH_OPTIONS` above is
 * ever tightened, every password hashed under the old, lighter setting must keep verifying
 * correctly, and passing today's options here would risk breaking that.
 */
export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;

/**
 * A real Argon2 hash of a password nobody will ever type.
 *
 * Login always calls `verifyPassword` — even for an email that does not exist — checking the
 * submitted password against this instead. Without it, "no such user" would return in microseconds
 * while "wrong password" takes the tens of milliseconds Argon2 needs, and that timing gap is enough
 * for an attacker to work out which emails are registered without ever seeing an error message.
 */
export function unknownUserPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('correct-horse-battery-staple-but-nobody-will-ever-use-this-one');
  return dummyHash;
}
