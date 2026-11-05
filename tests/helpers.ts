import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { Database } from "../src/db/database.js";
import { applySchema } from "../src/db/migrate.js";
import { loadConfig, type Config } from "../src/core/config.js";
import { AuthService } from "../src/auth/service.js";
import type { TaskPlan, User } from "../src/core/types.js";
import { createTask } from "../src/db/repos.js";

interface Cluster {
  pg: EmbeddedPostgres;
  port: number;
}

let clusterPromise: Promise<Cluster> | null = null;
let databaseCounter = 0;
const externalUrl = process.env.TALISMAN_TEST_PG_URL;

async function cluster(): Promise<Cluster> {
  if (!clusterPromise) {
    clusterPromise = (async () => {
      const directory = await mkdtemp(join(tmpdir(), "talisman-pg-"));
      const port = 55_000 + Math.floor(Math.random() * 900);
      const pg = new EmbeddedPostgres({
        databaseDir: directory,
        port,
        user: "postgres",
        password: "postgres",
        persistent: false,
        autoRehydrateSymlinks: true,
        postgresFlags: ["-c", "shared_buffers=16MB", "-c", "max_connections=20"],
        onLog: () => undefined,
        onError: () => undefined,
      } as never);
      await pg.initialise();
      await pg.start();
      return { pg, port };
    })();
  }
  return clusterPromise;
}

after(async () => {
  if (!clusterPromise) return;
  const running = await clusterPromise.catch(() => null);
  await running?.pg.stop().catch(() => undefined);
});

export async function makeDatabaseWithUrl(): Promise<{
  database: Database;
  connectionString: string;
}> {
  const name = `talisman_${process.pid}_${++databaseCounter}`;
  let connectionString: string;

  if (externalUrl) {
    const admin = new Pool({ connectionString: externalUrl, max: 1 });
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    const target = new URL(externalUrl);
    target.pathname = `/${name}`;
    connectionString = target.toString();
  } else {
    const { pg, port } = await cluster();
    await pg.createDatabase(name);
    connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/${name}`;
  }

  const pool = new Pool({ connectionString, max: 5 });
  const database = Database.fromPool(pool);
  await applySchema(database.driver);
  return { database, connectionString };
}

export async function makeDatabase(): Promise<Database> {
  return (await makeDatabaseWithUrl()).database;
}

export function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "test-secret-that-is-long-enough-0123456789",
    DATA_DIR: join(tmpdir(), "talisman-test-data"),
    TALISMAN_AUTO_MIGRATE: "false",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export async function makeDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "talisman-test-"));
}

export async function makeUser(
  database: Database,
  email = `user-${Math.random().toString(36).slice(2)}@example.com`,
): Promise<{ user: User; auth: AuthService; token: string }> {
  const auth = new AuthService(database, "test-secret-that-is-long-enough-0123456789");
  const result = await auth.signup({
    email,
    password: "correct horse battery staple",
    name: "Test User",
    orgName: "Test Org",
  });
  return { user: result.session.user, auth, token: result.token };
}

export async function enqueueTask(
  database: Database,
  orgId: string,
  userId: string,
  plan: TaskPlan,
  options: { maxAttempts?: number } = {},
) {
  return database.withTenant(orgId, userId, (conn) =>
    createTask(conn, {
      orgId,
      userId,
      title: "Test task",
      goal: "Test goal",
      plan,
      maxAttempts: options.maxAttempts,
    }),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
