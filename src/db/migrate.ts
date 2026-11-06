import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Driver } from "./database.js";

const schemaUrl = new URL("./schema.sql", import.meta.url);

/**
 * Splits a migration into individual statements, respecting quoted strings,
 * dollar-quoted blocks (DO $$ ... $$), and comments. Applying one statement at a
 * time keeps memory bounded and keeps a failing statement identifiable when a
 * migration is applied over a slow or memory-constrained connection.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let state: "normal" | "single" | "double" | "line" | "block" | "dollar" = "normal";
  let dollarTag = "";

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (state === "normal") {
      if (character === "'") state = "single";
      else if (character === '"') state = "double";
      else if (character === "-" && next === "-") {
        state = "line";
        index += 1;
      } else if (character === "/" && next === "*") {
        state = "block";
        index += 1;
      } else if (character === "$") {
        const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(index));
        if (match) {
          dollarTag = match[0];
          state = "dollar";
          index += dollarTag.length - 1;
        }
      } else if (character === ";") {
        const statement = sql.slice(start, index).trim();
        if (statement) statements.push(statement);
        start = index + 1;
      }
    } else if (state === "single") {
      if (character === "'") {
        if (next === "'") index += 1;
        else state = "normal";
      }
    } else if (state === "double") {
      if (character === '"') state = "normal";
    } else if (state === "line") {
      if (character === "\n") state = "normal";
    } else if (state === "block") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
    } else if (state === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        state = "normal";
      }
    }
    index += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function applySchema(driver: Driver): Promise<void> {
  // Bundlers (Vercel, esbuild) resolve the schema differently from tsx. Try the
  // module-relative path first, then the project layout, and fail loudly if
  // neither exists rather than reporting a healthy but empty database.
  const candidates = [fileURLToPath(schemaUrl), resolve(process.cwd(), "src/db/schema.sql")];
  for (const candidate of candidates) {
    try {
      const sql = await readFile(candidate, "utf8");
      await applySchemaSql(driver, sql);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }
  throw new Error("Could not locate schema.sql in this deployment");
}

export async function applySchemaSql(driver: Driver, sql: string): Promise<void> {
  const statements = splitSqlStatements(sql);
  for (const [index, statement] of statements.entries()) {
    try {
      await driver.exec(`${statement};`);
    } catch (error) {
      throw new Error(
        `Migration statement ${index + 1} failed: ${statement.slice(0, 120)} — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export async function applySchemaFrom(driver: Driver, path: string): Promise<void> {
  const sql = await readFile(path, "utf8");
  await applySchemaSql(driver, sql);
}
