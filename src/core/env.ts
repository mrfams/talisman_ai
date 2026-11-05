import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env` from the working directory when present. Variables already set in
 * the real environment win, so tests and CI are unaffected. Missing files are
 * ignored: development falls back to embedded Postgres and no model key.
 */
export function loadLocalEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}
