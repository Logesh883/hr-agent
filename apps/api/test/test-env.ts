import path from 'node:path';

export const workspaceRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * The e2e suite's own database and storage folder. Override the database with
 * TEST_DATABASE_URL; by default it's `hr_test` next to the dev database.
 */
export const testEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://hr:hr@localhost:5433/hr_test',
  STORAGE_DIR: path.join(workspaceRoot, 'storage-test'),
};
