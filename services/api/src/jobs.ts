/** Postgres job queue. Enqueue inside the same transaction as the change that needs the job. */
import type { Db } from "./db.js";

export type JobType = "extract";

export interface JobRow {
  id: number;
  type: JobType;
  payload: Record<string, unknown>;
  state: "queued" | "running" | "done" | "dead";
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_until: Date | null;
  locked_by: string | null;
  last_error: string | null;
  dedupe_key: string | null;
}

export const MAX_ATTEMPTS: Record<JobType, number> = { extract: 3 };

/** Enqueue a job; a queued/running job with the same dedupe key makes this a no-op. */
export async function enqueue(db: Db, type: JobType, payload: Record<string, unknown>, opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}): Promise<number | undefined> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO jobs (type, payload, dedupe_key, run_at, max_attempts)
     VALUES ($1, $2, $3, coalesce($4, now()), $5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running') DO NOTHING
     RETURNING id`,
    [type, JSON.stringify(payload), opts.dedupeKey ?? null, opts.runAt ?? null, opts.maxAttempts ?? MAX_ATTEMPTS[type]],
  );
  return r.rows[0]?.id;
}
