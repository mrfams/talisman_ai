import { Pool } from "pg";
import { loadConfig } from "../core/config.js";
import { log } from "../core/log.js";
import { Database } from "./database.js";
import { applySchema } from "./migrate.js";
import { loadLocalEnv } from "../core/env.js";

loadLocalEnv();
const config = loadConfig();
const url = config.databaseUrl;
if (!url) {
  console.error("DATABASE_URL is required to migrate");
  process.exit(1);
}
const pool = new Pool({ connectionString: url, max: 1 });
const database = Database.fromPool(pool);
try {
  await applySchema(database.driver);
  log.info("schema applied");
} finally {
  await database.close();
}
