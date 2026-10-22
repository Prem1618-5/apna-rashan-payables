/**
 * Background worker: claims jobs with SELECT … FOR UPDATE SKIP LOCKED, holds a lease while running
 * (renewed by a heartbeat), retries with exponential backoff + jitter, and marks a job 'dead' after
 * max_attempts. Jobs must be idempotent: a job whose lease expires (worker killed) simply runs again.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { Pool } from "./db.js";
import type { JobRow, JobType } from "./jobs.js";

export interface WorkerLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface JobHandler {
  run(job: JobRow): Promise<void>;
  /** Called once when the job gives up for good (after max attempts). */
  onDead?(job: JobRow, error: Error): Promise<void>;
}

export interface WorkerOptions {
  id?: string;
  pollMs?: number;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface Worker {
  readonly id: string;
  /** Claim and process one job. Resolves true if a job was processed. */
  runOnce(): Promise<boolean>;
  /** Process jobs until none are ready (tests, one-off tasks). Returns how many ran. */
  drain(max?: number): Promise<number>;
  start(): void;
  /** Stop claiming, wait for the running job (up to timeoutMs), then release any lease still held. */
  stop(timeoutMs?: number): Promise<void>;
}

export function backoffMs(attempts: number, base: number, max: number): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp + Math.random() * exp * 0.2);
}

export function createWorker(pool: Pool, handlers: Partial<Record<JobType, JobHandler>>, log: WorkerLog, opts: WorkerOptions = {}): Worker {
  const id = opts.id ?? `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  const pollMs = opts.pollMs ?? 1000;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const backoffBase = opts.backoffBaseMs ?? 5000;
  const backoffMax = opts.backoffMaxMs ?? 10 * 60_000;
  const types = Object.keys(handlers);

  let running = false;
  let loop: Promise<void> | undefined;
  let inflight: Promise<boolean> | undefined;
  let wake: (() => void) | undefined;

  async function claim(): Promise<JobRow | undefined> {
    const r = await pool.query<JobRow>(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, locked_by = $1,
              locked_until = now() + ($2::int * interval '1 millisecond'), updated_at = now()
        WHERE id = (
          SELECT id FROM jobs
           WHERE type = ANY($3::text[])
             AND ((state = 'queued' AND run_at <= now()) OR (state = 'running' AND locked_until < now()))
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING *`,
      [id, leaseMs, types],
    );
    return r.rows[0];
  }

  async function finish(job: JobRow) {
    await pool.query(`UPDATE jobs SET state = 'done', locked_until = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND locked_by = $2`, [job.id, id]);
  }

  async function fail(job: JobRow, err: Error) {
    const message = (err.message || String(err)).slice(0, 2000);
    if (job.attempts >= job.max_attempts) {
      const r = await pool.query(
        `UPDATE jobs SET state = 'dead', last_error = $3, locked_until = NULL, finished_at = now(), updated_at = now() WHERE id = $1 AND locked_by = $2`,
        [job.id, id, message],
      );
      log.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, "job is dead");
      if (r.rowCount) await handlers[job.type]?.onDead?.(job, err).catch((e: Error) => log.error({ jobId: job.id, err: e.message }, "onDead failed"));
      return;
    }
    const delay = backoffMs(job.attempts, backoffBase, backoffMax);
    await pool.query(
      `UPDATE jobs SET state = 'queued', last_error = $3, locked_until = NULL, locked_by = NULL,
              run_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND locked_by = $2`,
      [job.id, id, message, delay],
    );
    log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, retryInMs: delay, err: message }, "job failed, will retry");
  }

  async function processJob(job: JobRow): Promise<void> {
    const handler = handlers[job.type];
    if (!handler) return fail(job, new Error(`no handler for job type ${job.type}`));
    if (job.attempts > job.max_attempts) return fail({ ...job, attempts: job.max_attempts }, new Error(job.last_error ?? "lease expired too many times"));
    const heartbeat = setInterval(() => {
      pool
        .query(`UPDATE jobs SET locked_until = now() + ($3::int * interval '1 millisecond') WHERE id = $1 AND locked_by = $2 AND state = 'running'`, [job.id, id, leaseMs])
        .catch(() => undefined);
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    const started = Date.now();
    try {
      await handler.run(job);
      await finish(job);
      log.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, "job done");
    } catch (e) {
      await fail(job, e instanceof Error ? e : new Error(String(e)));
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function runOnce(): Promise<boolean> {
    const job = await claim();
    if (!job) return false;
    await processJob(job);
    return true;
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  return {
    id,
    runOnce,
    async drain(max = 1000) {
      let n = 0;
      while (n < max && (await runOnce())) n++;
      return n;
    },
    start() {
      if (running) return;
      running = true;
      log.info({ workerId: id, types }, "worker started");
      loop = (async () => {
        while (running) {
          try {
            inflight = runOnce();
            const did = await inflight;
            inflight = undefined;
            if (!did && running) await sleep(pollMs);
          } catch (e) {
            inflight = undefined;
            log.error({ err: (e as Error).message }, "worker loop error");
            if (running) await sleep(Math.min(30_000, pollMs * 5));
          }
        }
      })();
    },
    async stop(timeoutMs = 25_000) {
      running = false;
      wake?.();
      if (inflight) {
        await Promise.race([inflight.catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))]);
      }
      await Promise.race([loop?.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
      // Whatever is still ours goes back to the queue right away (no need to wait for the lease to expire).
      const r = await pool.query(
        `UPDATE jobs SET state = 'queued', locked_until = NULL, locked_by = NULL, attempts = greatest(attempts - 1, 0), run_at = now(), updated_at = now()
          WHERE state = 'running' AND locked_by = $1`,
        [id],
      );
      if (r.rowCount) log.warn({ workerId: id, released: r.rowCount }, "released job leases on shutdown");
      log.info({ workerId: id }, "worker stopped");
    },
  };
}
