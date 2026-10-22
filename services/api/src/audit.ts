/**
 * Append-only, hash-chained audit log. The chain (id, prev_hash, hash) is computed by a database
 * trigger under an advisory lock, so every writer — API, worker, seed — is chained the same way.
 * Call audit() inside the same transaction as the change it describes.
 */
import type { Db } from "./db.js";

export interface Actor {
  id?: string;
  name: string;
}

export const SYSTEM: Actor = { name: "system" };

export interface AuditInput {
  action: string;
  entity: string;
  entityId: string;
  detail?: unknown;
  reason?: string;
}

/** Keys that must never be written to the audit log, even by mistake. */
const SECRET_KEYS = /^(pin|pinHash|pin_hash|accountNumber|accountNumberConfirm|account_number|token|password|secret|fileContent)$/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v);
    }
    return out;
  }
  return value;
}

export async function audit(db: Db, actor: Actor, e: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor, action, entity, entity_id, detail, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.id ?? null, actor.name, e.action, e.entity, e.entityId, e.detail === undefined ? null : JSON.stringify(scrub(e.detail)), e.reason ?? null],
  );
}

/** Returns undefined when the chain verifies, or the first broken row. */
export async function verifyAuditChain(db: Db): Promise<{ id: number; problem: string } | undefined> {
  const r = await db.query<{ bad_id: number; problem: string }>("SELECT bad_id, problem FROM audit_verify()");
  const row = r.rows[0];
  return row ? { id: row.bad_id, problem: row.problem } : undefined;
}
