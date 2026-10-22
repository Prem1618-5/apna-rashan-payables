import pg from "pg";

// bigint (int8) and numeric come back as strings by default. All our int8 columns are paise or
// counts well inside Number.MAX_SAFE_INTEGER, and SUM() over them returns numeric.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE stays a calendar string (YYYY-MM-DD); never let a time zone shift the day.
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Guard against runaway queries holding locks.
    statement_timeout: 30_000,
    application_name: "arad-api",
  });
  pool.on("error", () => {
    // An idle client died (e.g. DB restart). pg removes it from the pool; nothing else to do.
  });
  return pool;
}

/** Run fn in a READ COMMITTED transaction (the audit hash chain relies on READ COMMITTED). */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(db: Db, text: string, values: unknown[] = []): Promise<T | undefined> {
  const r = await db.query<T>(text, values);
  return r.rows[0];
}

export async function many<T extends pg.QueryResultRow>(db: Db, text: string, values: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(text, values);
  return r.rows;
}

export const isUniqueViolation = (e: unknown, constraint?: string) =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "23505" && (!constraint || (e as { constraint?: string }).constraint === constraint);
