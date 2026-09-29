// Runs the Next.js CLI with the monorepo root .env loaded, so the web app
// shares one env file with the API and Prisma. Usage: node scripts/next-with-env.mjs dev
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const envFile = path.resolve(import.meta.dirname, "../../../.env");
// Variables already set in the environment take precedence over the file.
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
