import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Creates and migrates the test database once, before anything runs.
    globalSetup: ['tests/setup/global-database.ts'],
    // Test files share one database, so letting them run side by side would have them truncating
    // each other's rows mid-assertion. One file at a time is slower and correct.
    fileParallelism: false,
    // Vitest's default pool runs each file in a worker_thread, not a separate process - threads
    // in the same process can still share low-level state a real `pg` connection pool depends on,
    // which surfaced as one file's leftover pool occasionally corrupting the very next file's
    // query results (traced by hand: a row `queueNotification` had just inserted would
    // intermittently go missing from the very next file's claim query, only when that next file
    // followed one that had also opened a database pool). Forks give each file a real, separate
    // OS process instead, which is what actually fixed it, not a coincidence.
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
    },
  },
});
