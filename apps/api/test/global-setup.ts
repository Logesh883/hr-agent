/**
 * Runs once before the e2e suite against a separate test database, so tests
 * never depend on (or change) the data you use in the dev app. Applies any
 * pending migrations and re-seeds; the seed is idempotent and puts the demo
 * records back to their known state. Each spec removes what it creates.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { testEnv, workspaceRoot } from './test-env.js';

export default function setup() {
  const env = { ...process.env, ...testEnv };
  const cwd = path.join(workspaceRoot, 'packages/db');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd, env, stdio: 'pipe' });
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'seed'], { cwd, env, stdio: 'pipe' });
}
