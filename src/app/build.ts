import type { Config } from "../core/config.js";
import { AuthService } from "../auth/service.js";
import { createModelRouter } from "../intelligence/factory.js";
import type { ModelRouter } from "../intelligence/router.js";
import { openDatabase, type OpenDatabaseResult } from "../db/runtime.js";
import type { Database } from "../db/database.js";
import { TaskEngine } from "../runtime/engine.js";
import { defaultHandlers } from "../runtime/handlers.js";
import { createBrowser } from "../browser/factory.js";
import type { BrowserDriver } from "../browser/driver.js";
import { createArtifactStore, type ArtifactStoreLike } from "../workspace/workspace.js";

export interface Runtime {
  config: Config;
  opened: OpenDatabaseResult;
  database: Database;
  auth: AuthService;
  models: ModelRouter;
  artifactStore: ArtifactStoreLike;
  engine: TaskEngine;
  browserFactory: () => BrowserDriver | null;
}

/**
 * One place that assembles the runtime for every entry point (long-running server,
 * worker loop, and serverless function). Keeping it together is what stops the
 * deployed function from drifting away from the tested code paths.
 */
export async function buildRuntime(config: Config): Promise<Runtime> {
  const opened = await openDatabase(config);
  const database = opened.database;
  const auth = new AuthService(database, config.sessionSecret);
  const models = createModelRouter(config);
  const artifactStore = createArtifactStore(config, database);
  const browserFactory = () => createBrowser(config);
  const engine = new TaskEngine({
    database,
    config,
    models,
    handlers: defaultHandlers,
    artifactStore,
    workerId: config.workerId,
    browserFactory,
  });
  return {
    config,
    opened,
    database,
    auth,
    models,
    artifactStore,
    engine,
    browserFactory,
  };
}
