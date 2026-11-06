import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { loadConfig } from "../src/core/config.js";
import { log } from "../src/core/log.js";
import { buildRuntime } from "../src/app/build.js";
import { createApp } from "../src/api/app.js";

/**
 * Vercel Node function entry point. Every `/api/*` request is rewritten here by
 * `vercel.json`, so there is a single warm runtime per instance: one pool, one
 * model router, one executor. Static files are served by Vercel from `public/`.
 */
let appPromise: Promise<Hono<never>> | null = null;

function boot(): Promise<Hono<never>> {
  if (!appPromise) {
    appPromise = (async () => {
      const config = loadConfig();
      const runtime = await buildRuntime(config);
      log.info("Talisman serverless runtime ready", {
        browser: config.browserMode,
        artifacts: config.artifactStore,
        database: runtime.opened.kind,
      });
      return createApp({
        config,
        database: runtime.database,
        auth: runtime.auth,
        models: runtime.models,
        artifactStore: runtime.artifactStore,
        engine: runtime.engine,
      }) as unknown as Hono<never>;
    })().catch((error: unknown) => {
      // Do not cache a boot failure: the next invocation retries with fresh env.
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

const listener = getRequestListener(async (request: Request): Promise<Response> => {
  try {
    return await (await boot()).fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("serverless runtime failed to start", { error: message });
    return Response.json(
      {
        error: "Talisman is not configured for this deployment",
        code: "unavailable",
        detail: message,
      },
      { status: 503 },
    );
  }
});

export default listener;
