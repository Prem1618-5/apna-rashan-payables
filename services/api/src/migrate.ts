/** Tiny forward-only migration runner: migrations/NNN_name.sql, applied in order under an advisory lock. */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type pg from "pg";

const LOCK_KEY = 7243100000;

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface MigrationLog {
  info(obj: object, msg?: string): void;
}

export async function migrate(pool: pg.Pool, log?: MigrationLog, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Session-level lock: several API containers starting together run migrations once.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map((await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const version = file.slice(0, 3);
      const sql = readFileSync(`${dir}/${file}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prev = done.get(version);
      if (prev) {
        if (prev !== checksum) throw new Error(`migration ${file} was changed after it was applied; add a new migration instead`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [version, file, checksum]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
      applied.push(file);
      log?.info({ migration: file }, "migration applied");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
