import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Walks up from this file to the monorepo root (works from src/ and dist/). */
function findWorkspaceRoot(dir: string): string | undefined {
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
  const parent = path.dirname(dir);
  return parent === dir ? undefined : findWorkspaceRoot(parent);
}

/** Monorepo root; falls back to the working directory outside the repo. */
export const workspaceRoot = findWorkspaceRoot(import.meta.dirname) ?? process.cwd();

// Env vars live in the monorepo root .env; real env vars take precedence.
loadDotenv({ path: path.join(workspaceRoot, '.env'), quiet: true });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(28800),
  /** Local storage driver root; relative paths resolve from the monorepo root. */
  STORAGE_DIR: z
    .string()
    .default('storage')
    .transform((dir) => path.resolve(workspaceRoot, dir)),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated environment. Throws at startup if anything required is missing. */
export function env(): Env {
  if (!cached) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const problems = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid environment:\n${problems}`);
    }
    cached = result.data;
  }
  return cached;
}
