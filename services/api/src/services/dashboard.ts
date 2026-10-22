import type { AuditEntry, Dashboard, Settings, StoreToday } from "@arad/core";
import type { AppContext } from "../context.js";
import { many, one } from "../db.js";
import { addDays, istToday } from "./invoices.js";
import { listRuns } from "./payment-runs.js";
import { SIGNED_AMOUNT_SQL } from "./vendors.js";
import type { SessionUser } from "../context.js";

/** Start of "today" in India as a timestamptz expression. */
const IST_TODAY_START = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

export async function dashboard(ctx: AppContext, user: SessionUser): Promise<Dashboard> {
  const db = ctx.pool;
  const today = istToday();
  const stores = await many<{ id: string; name: string; captured: number; needs: number; verified: number; flagged: number }>(
    db,
    `SELECT s.id, s.name,
            count(i.id) FILTER (WHERE i.created_at >= ${IST_TODAY_START})::int AS captured,
            count(i.id) FILTER (WHERE i.state = 'NEEDS_VERIFICATION')::int AS needs,
            count(i.id) FILTER (WHERE i.verified_at >= ${IST_TODAY_START})::int AS verified,
            count(i.id) FILTER (WHERE i.state IN ('EXTRACTION_FAILED', 'ON_HOLD', 'DUPLICATE')
                                 OR (i.state = 'NEEDS_VERIFICATION' AND (i.flagged_count > 0 OR i.lock_flagged)))::int AS flagged
       FROM stores s LEFT JOIN invoices i ON i.store_id = s.id
      GROUP BY s.id ORDER BY s.code`,
  );
  const money = await one<{ owed: number; overdue: number; week: number; vendors_due: number }>(
    db,
    `SELECT coalesce(sum(${SIGNED_AMOUNT_SQL()}) FILTER (WHERE i.state IN ('VERIFIED', 'IN_PAYMENT_RUN')), 0)::bigint AS owed,
            coalesce(sum(${SIGNED_AMOUNT_SQL()}) FILTER (WHERE i.state = 'VERIFIED' AND i.due_date < $1::date), 0)::bigint AS overdue,
            coalesce(sum(${SIGNED_AMOUNT_SQL()}) FILTER (WHERE i.state = 'VERIFIED' AND i.due_date BETWEEN $1::date AND $2::date), 0)::bigint AS week,
            count(DISTINCT i.vendor_id) FILTER (WHERE i.state = 'VERIFIED' AND i.due_date <= $2::date)::int AS vendors_due
       FROM invoices i WHERE i.state IN ('VERIFIED', 'IN_PAYMENT_RUN')`,
    [today, addDays(today, 7)],
  );
  const pending = await one<{ vendors: number; banks: number; runs: number }>(
    db,
    `SELECT (SELECT count(*)::int FROM vendors WHERE status = 'PENDING') AS vendors,
            (SELECT count(*)::int FROM vendor_bank_accounts WHERE status = 'PENDING') AS banks,
            (SELECT count(*)::int FROM payment_runs WHERE state = 'DRAFT') AS runs`,
  );
  const out: StoreToday[] = stores.map((s) => ({ storeId: s.id, storeName: s.name, captured: s.captured, needsVerification: s.needs, verified: s.verified, flagged: s.flagged }));
  return {
    stores: out,
    owedPaise: money?.owed ?? 0,
    overduePaise: money?.overdue ?? 0,
    dueThisWeekPaise: money?.week ?? 0,
    vendorsDue: money?.vendors_due ?? 0,
    pendingApprovals: { vendors: pending?.vendors ?? 0, bankChanges: pending?.banks ?? 0, runs: pending?.runs ?? 0 },
    recentRuns: await listRuns(ctx, user, 5),
  };
}

export function settings(ctx: AppContext): Settings {
  const c = ctx.config;
  return {
    hdfcClientCode: c.HDFC_CLIENT_CODE,
    rtgsFromPaise: c.RTGS_FROM_PAISE,
    coolingOffHours: c.COOLING_OFF_HOURS,
    requireDifferentApprover: c.REQUIRE_DIFFERENT_APPROVER,
    // Only counts and flags; never the keys themselves.
    aiProviders: ctx.extractor.providers().map((p) => ({ id: p.id, enabled: p.enabled, keys: p.keys, trainsOnInput: p.trainsOnInput, allowedForRealData: p.allowedForRealData, model: p.model })),
  };
}

export async function auditEntries(ctx: AppContext, q: { entity?: string; id?: string; limit?: number }): Promise<AuditEntry[]> {
  const params: unknown[] = [];
  const where: string[] = ["TRUE"];
  if (q.entity) where.push(`entity = $${params.push(q.entity)}`);
  if (q.id) where.push(`entity_id = $${params.push(q.id)}`);
  params.push(Math.min(Math.max(q.limit ?? 200, 1), 1000));
  const rows = await many<{ id: number; at: Date; actor: string; action: string; entity: string; entity_id: string; detail: unknown; reason: string | null }>(
    ctx.pool,
    `SELECT id, at, actor, action, entity, entity_id, detail, reason FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    detail: r.reason ? { ...(typeof r.detail === "object" && r.detail ? r.detail : {}), reason: r.reason } : (r.detail ?? undefined),
  }));
}
