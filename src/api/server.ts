import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig } from "../core/config.js";
import { log } from "../core/log.js";
import { buildRuntime } from "../app/build.js";
import { createApp } from "./app.js";
import { loadLocalEnv } from "../core/env.js";

loadLocalEnv();
const config = loadConfig();
const runtime = await buildRuntime(config);

const app = createApp({
  config,
  database: runtime.database,
  auth: runtime.auth,
  models: runtime.models,
  artifactStore: runtime.artifactStore,
  engine: runtime.engine,
});
app.use("/*", serveStatic({ root: "./public" }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("Talisman API listening", {
    port: info.port,
    database: runtime.opened.kind,
    browser: config.browserMode,
    artifacts: config.artifactStore,
  });
});

async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });
  server.close();
  if (runtime.opened.stop) await runtime.opened.stop().catch(() => undefined);
  else await runtime.database.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
