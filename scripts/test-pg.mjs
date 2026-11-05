// Starts a single embedded Postgres for the whole test run. Test files create
// their own databases on it, so each file does not pay for (or risk) initdb.
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.TEST_PG_PORT ?? 55433);
const directory = await mkdtemp(join(tmpdir(), "talisman-pg-server-"));
const pg = new EmbeddedPostgres({
  databaseDir: directory,
  port,
  user: "postgres",
  password: "postgres",
  persistent: false,
  autoRehydrateSymlinks: true,
  postgresFlags: [
    "-c",
    "shared_buffers=8MB",
    "-c",
    "max_connections=20",
    "-c",
    "work_mem=2MB",
    "-c",
    "maintenance_work_mem=16MB",
    "-c",
    "fsync=off",
    "-c",
    "full_page_writes=off",
  ],
  onLog: () => undefined,
  onError: (message) => {
    const text = String(message);
    if (text.trim()) console.error(text.slice(0, 300));
  },
});

await pg.initialise();
await pg.start();
console.log(`READY ${port}`);

const stop = async () => {
  await pg.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
setInterval(() => undefined, 1 << 30);
