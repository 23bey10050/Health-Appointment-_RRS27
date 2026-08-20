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
    env: {
      NODE_ENV: 'test',
    },
  },
});
