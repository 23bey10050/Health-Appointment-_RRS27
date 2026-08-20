import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests that talk to a real database share one schema, so letting files run side by side would
    // have them deleting each other's rows. Single file at a time is slower and correct.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
  },
});
