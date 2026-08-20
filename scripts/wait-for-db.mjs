import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// `docker compose up -d` returns as soon as the container starts, which is several seconds before
// Postgres will accept a connection. Running migrations in that gap fails for no real reason, so
// this waits for the healthcheck declared in docker-compose.yml to go green first.

const CONTAINER = 'health-appointment-db';
const TIMEOUT_MS = 60_000;
const POLL_MS = 1000;

const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline) {
  let status = 'unknown';

  try {
    status = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', CONTAINER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // The container may not exist yet on the very first poll. Keep waiting rather than giving up.
  }

  if (status === 'healthy') {
    console.log('Database is ready.');
    process.exit(0);
  }

  await sleep(POLL_MS);
}

console.error(`Database did not become healthy within ${TIMEOUT_MS / 1000}s.`);
process.exit(1);
