import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Pool } from "pg";
import type { Config } from "../core/config.js";
import { log } from "../core/log.js";
import { Database } from "./database.js";
import { applySchema } from "./migrate.js";

export interface OpenDatabaseResult {
  database: Database;
  kind: "postgres" | "embedded";
  /** Stops a locally started server. Absent when connecting to an existing one. */
  stop?: () => Promise<void>;
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(600);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Postgres is the supported deployment. Without DATABASE_URL a local embedded
 * Postgres cluster is started on a fixed port so the API and worker in separate
 * processes share it. Production requires DATABASE_URL.
 */
export async function openDatabase(config: Config): Promise<OpenDatabaseResult> {
  if (config.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    const database = Database.fromPool(pool);
    if (config.autoMigrate) await applySchema(database.driver);
    return { database, kind: "postgres" };
  }
  if (config.production) {
    throw new Error("DATABASE_URL is required in production");
  }

  const port = Number(process.env.TALISMAN_DEV_PG_PORT ?? 55_432);
  const directory = join(config.dataDir, "postgres");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let started: { stop: () => Promise<void> } | null = null;

  if (!(await portInUse(port))) {
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const pg = new EmbeddedPostgres({
      databaseDir: directory,
      port,
      user: "postgres",
      password: "postgres",
      persistent: true,
      autoRehydrateSymlinks: true,
      postgresFlags: ["-c", "shared_buffers=16MB", "-c", "max_connections=20"],
      onLog: () => undefined,
      onError: () => undefined,
    } as never);
    try {
      await pg.initialise();
    } catch (error) {
      // An already-initialised data directory is fine; anything else is not.
      const message = error instanceof Error ? error.message : String(error);
      if (!/already|exists|initiali/i.test(message)) throw error;
    }
    await pg.start();
    await pg.createDatabase("talisman").catch(() => undefined);
    started = pg;
    log.info("started local embedded Postgres", { port });
  }

  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "postgres",
    database: "talisman",
    max: 10,
  });
  const database = Database.fromPool(pool);
  if (config.autoMigrate) await applySchema(database.driver);
  log.warn("using local embedded Postgres; set DATABASE_URL for a real deployment");
  return {
    database,
    kind: "embedded",
    ...(started
      ? {
          stop: async () => {
            await database.close().catch(() => undefined);
            await started!.stop().catch(() => undefined);
          },
        }
      : {}),
  };
}
