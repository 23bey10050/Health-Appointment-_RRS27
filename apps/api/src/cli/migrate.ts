import { loadConfig } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrator.js';
import { describeUnknownError } from '../shared/errors.js';

/**
 * Brings the database up to date, then exits.
 *
 * Kept as a command you run rather than something the server does on boot. On a free tier the app
 * can restart at any moment, and a schema change is not something that should happen by surprise
 * halfway through a clinic day.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDatabase(config);

  try {
    const result = await runMigrations(db.pool, {
      logger: {
        info: (message) => console.warn(message),
        warn: (message) => console.warn(message),
      },
    });

    if (result.applied.length === 0) {
      console.warn(`Database is already up to date (${result.alreadyApplied.length} migrations).`);
      return;
    }

    console.warn(`Applied ${result.applied.length} migration(s).`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Migration failed: ${describeUnknownError(error)}`);
  process.exit(1);
});
