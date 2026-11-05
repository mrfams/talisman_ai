import { loadConfig } from "../core/config.js";
import { log } from "../core/log.js";
import { openDatabase } from "../db/runtime.js";
import { listOrgIds } from "../db/repos.js";
import { createModelRouter } from "../intelligence/factory.js";
import { TaskEngine } from "../runtime/engine.js";
import { defaultHandlers } from "../runtime/handlers.js";
import { ArtifactStore } from "../workspace/workspace.js";
import { PlaywrightBrowser } from "../browser/playwright.js";

const config = loadConfig();
const opened = await openDatabase(config);
const { database, kind } = opened;
const models = createModelRouter(config);
const engine = new TaskEngine({
  database,
  config,
  models,
  handlers: defaultHandlers,
  artifactStore: new ArtifactStore(config.dataDir),
  workerId: config.workerId,
  browserFactory: () =>
    new PlaywrightBrowser({
      policy: {
        allowedHosts: config.browserAllowedHosts,
        allowPrivateNetwork: config.browserAllowPrivate,
      },
      channel: process.env.TALISMAN_BROWSER_CHANNEL ?? "chrome",
    }),
});

let running = true;
let active = 0;

async function tick(): Promise<void> {
  const orgIds = await listOrgIds(database.driver);
  for (const orgId of orgIds) {
    while (running && active < config.workerConcurrency) {
      const task = await engine.claim(orgId);
      if (!task) break;
      active += 1;
      log.info("task claimed", { taskId: task.id, orgId, worker: config.workerId });
      void engine
        .runClaimed(task)
        .catch((error) => {
          log.error("task execution crashed", {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          active -= 1;
        });
    }
  }
}

log.info("Talisman worker started", {
  worker: config.workerId,
  concurrency: config.workerConcurrency,
  database: kind,
});

while (running) {
  try {
    await tick();
  } catch (error) {
    // A database blip must not kill the loop.
    log.warn("worker tick failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function shutdown(): Promise<void> {
  running = false;
  const deadline = Date.now() + 15_000;
  while (active > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (opened.stop) await opened.stop().catch(() => undefined);
  else await database.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
