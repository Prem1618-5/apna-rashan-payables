/**
 * Starts a throwaway Postgres 16 cluster (or uses TEST_DATABASE_URL, an admin URL to an existing server),
 * creates a migrated template database, and lets each test file clone its own database from it.
 */
import { execFileSync } from "node:child_process";
import { chownSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrate } from "../src/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

const PGBIN = process.env.PGBIN ?? "/usr/lib/postgresql/16/bin";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function postgresUid(): { uid: number; gid: number } | undefined {
  if (process.getuid?.() !== 0) return undefined;
  const line = execFileSync("getent", ["passwd", "postgres"], { encoding: "utf8" }).trim();
  const [, , uid, gid] = line.split(":");
  return { uid: Number(uid), gid: Number(gid) };
}

function run(cmd: string, args: string[], asPg: boolean) {
  if (asPg) return execFileSync("runuser", ["-u", "postgres", "--", cmd, ...args], { stdio: "pipe" });
  return execFileSync(cmd, args, { stdio: "pipe" });
}

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let stopCluster: (() => void) | undefined;

  if (!adminUrl) {
    const dir = mkdtempSync(join(tmpdir(), "arad-pg-"));
    const owner = postgresUid();
    const asPg = !!owner;
    if (owner) chownSync(dir, owner.uid, owner.gid);
    const data = join(dir, "data");
    const port = await freePort();
    const pw = join(dir, "pw");
    writeFileSync(pw, "arad\n");
    if (owner) chownSync(pw, owner.uid, owner.gid);
    run(`${PGBIN}/initdb`, ["-D", data, "-U", "arad", `--pwfile=${pw}`, "-A", "scram-sha-256", "-E", "UTF8", "--no-locale"], asPg);
    const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300`;
    run(`${PGBIN}/pg_ctl`, ["-D", data, "-o", opts, "-l", join(dir, "server.log"), "-w", "-t", "60", "start"], asPg);
    adminUrl = `postgres://arad:arad@127.0.0.1:${port}/postgres`;
    stopCluster = () => {
      try {
        run(`${PGBIN}/pg_ctl`, ["-D", data, "-m", "immediate", "-w", "stop"], asPg);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  const template = `arad_tmpl_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${template}`);
  await admin.end();
  const tmplUrl = new URL(adminUrl);
  tmplUrl.pathname = `/${template}`;
  const pool = new pg.Pool({ connectionString: tmplUrl.toString(), max: 1 });
  await migrate(pool);
  await pool.end();

  project.provide("pgAdminUrl", adminUrl);
  project.provide("pgTemplate", template);

  return async () => {
    if (stopCluster) return stopCluster();
    // Shared server: drop what this run created.
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    const run = template.replace("arad_tmpl_", "");
    const dbs = await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname = $2", [`arad_t_${run}_%`, template]);
    for (const d of dbs.rows) await c.query(`DROP DATABASE IF EXISTS ${d.datname} WITH (FORCE)`);
    await c.end();
  };
}
