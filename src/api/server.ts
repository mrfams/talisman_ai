import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig } from "../core/config.js";
import { log } from "../core/log.js";
import { openDatabase } from "../db/runtime.js";
import { AuthService } from "../auth/service.js";
import { createModelRouter } from "../intelligence/factory.js";
import { ArtifactStore } from "../workspace/workspace.js";
import { createApp } from "./app.js";

const config = loadConfig();
const opened = await openDatabase(config);
const { database, kind } = opened;
const auth = new AuthService(database, config.sessionSecret);
const models = createModelRouter(config);
const artifactStore = new ArtifactStore(config.dataDir);

const app = createApp({ config, database, auth, models, artifactStore });
app.use("/*", serveStatic({ root: "./public" }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("Talisman API listening", { port: info.port, database: kind });
});

async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });
  server.close();
  if (opened.stop) await opened.stop().catch(() => undefined);
  else await database.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
