import { loadConfig } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { seedDevelopmentData } from '../db/seed.js';
import { describeUnknownError } from '../shared/errors.js';

/**
 * Fills an empty database with a clinic you can actually click around in.
 *
 * Refuses to run against production. Seeding writes fake patients and fake doctors, and doing that
 * to a real clinic's database would be a very bad afternoon.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (config.isProduction) {
    throw new Error('Seeding is blocked when NODE_ENV is production.');
  }

  const db = createDatabase(config);

  try {
    const summary = await seedDevelopmentData(db);
    console.warn(
      `Seeded ${summary.doctors} doctors, ${summary.patients} patients and 1 admin.\n` +
        `Sign in with any of these. The password for every seeded account is: ${summary.password}\n` +
        summary.accounts.map((line) => `  ${line}`).join('\n'),
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Seeding failed: ${describeUnknownError(error)}`);
  process.exit(1);
});
