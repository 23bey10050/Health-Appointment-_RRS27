import { defineConfig, devices } from '@playwright/test';

/**
 * Not wired into `npm run check` - unlike the API's own test suite, this needs two live servers
 * (the API on :4000 and this app's own dev server on :5173) plus Postgres already running, which
 * is real infrastructure `npm run check` should never have to assume exists. Run `npm run dev` and
 * `npm run dev:web` in two terminals first, then `npm run e2e` here - the same two-terminal shape
 * docs/setup.txt already asks for.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  // Every spec here books against the same doctor's first open slot - two files racing for it in
  // separate workers is exactly the same collision two real patients would hit, just not what
  // either test is trying to prove. One worker keeps them out of each other's way.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
