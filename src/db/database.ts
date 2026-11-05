import { Pool, type QueryResultRow } from "pg";

export interface Conn {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Driver extends Conn {
  transaction<T>(fn: (conn: Conn) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export class PgDriver implements Driver {
  constructor(private readonly pool: Pool) {}

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
    const result = await this.pool.query<T>(sql, params as unknown[]);
    return { rows: result.rows };
  }

  async transaction<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conn: Conn = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params?: unknown[],
        ) => {
          const result = await client.query<R>(sql, params as unknown[]);
          return { rows: result.rows };
        },
      };
      const value = await fn(conn);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class Database {
  constructor(readonly driver: Driver) {}

  static fromPool(pool: Pool): Database {
    return new Database(new PgDriver(pool));
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
    return this.driver.query<T>(sql, params);
  }

  exec(sql: string): Promise<void> {
    return this.driver.exec(sql);
  }

  /**
   * Run work as a tenant. Switches to the non-superuser app role and sets the
   * organisation/user context, so RLS applies. Fails closed when the role is
   * missing rather than silently running without isolation.
   */
  withTenant<T>(orgId: string, userId: string, fn: (conn: Conn) => Promise<T>): Promise<T> {
    if (!orgId || !userId) {
      return Promise.reject(new Error("Tenant context requires orgId and userId"));
    }
    return this.driver.transaction(async (conn) => {
      await conn.query("SET LOCAL ROLE talisman_app");
      await conn.query(
        "SELECT set_config('talisman.org_id', $1, true), set_config('talisman.user_id', $2, true)",
        [orgId, userId],
      );
      return fn(conn);
    });
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}

export function createPgPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
