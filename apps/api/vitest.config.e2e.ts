import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { testEnv } from './test/test-env.js';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // A separate database and storage folder, rebuilt and seeded before each run.
    env: testEnv,
    globalSetup: ['./test/global-setup.ts'],
    // Database-backed specs share one database; run files one at a time.
    fileParallelism: false,
  },
});
