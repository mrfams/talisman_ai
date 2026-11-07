#!/usr/bin/env node
/**
 * Applies the schema during a production build, before the new deployment can
 * take traffic. Without this a deploy that adds a column ships ahead of the
 * migration and every request touching it fails until someone migrates by hand.
 *
 * Only production builds run it: preview deployments have no database of their
 * own and must never touch the production one. Run it manually with `--force`
 * against DATABASE_URL when you need to migrate another environment.
 */
import { spawnSync } from "node:child_process";

const force = process.argv.includes("--force");
const productionBuild = process.env.VERCEL_ENV === "production";

if (!productionBuild && !force) {
  console.log("skip schema migration: only production builds apply it");
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to migrate a production build");
  process.exit(1);
}

console.log(`applying schema for ${force ? "manual" : "production"} build`);
const result = spawnSync("npm", ["run", "migrate", "--silent"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});
process.exit(result.status ?? 1);
