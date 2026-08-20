import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// TypeScript only emits .ts files, so the .sql migrations would be missing from the compiled build
// and the migrator would find an empty folder in production. This copies them across after every
// build. It runs on plain Node with no dependencies, so it works before anything is installed.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repoRoot, 'apps', 'api', 'src', 'db', 'migrations');
const target = join(repoRoot, 'apps', 'api', 'dist', 'db', 'migrations');

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log(`Copied migrations to ${target}`);
