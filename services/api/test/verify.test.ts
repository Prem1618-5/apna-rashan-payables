import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeLine } from "@arad/core";
import { mockFixture } from "../src/extraction.js";
import { createTestEnv, json, login, seedBasic, upload, type Fixture, type TestEnv } from "./helpers.js";

let env: TestEnv;
let fx: Fixture;
let cookie: string;
const GRAND = mockFixture().totals.grandTotalPaise;

beforeAll(async () => {
  env = await createTestEnv();
  fx = await seedBasic(env.pool);
  cookie = await login(env.app, fx.staffA);
});
afterAll(() => env.close());

async function extractedBill(): Promise<string> {
  const cap = json(await upload(env.app, cookie, { storeId: fx.storeA }));
  await env.worker.drain();
  return cap.invoiceId;
}
const post = (url: string, payload?: object) => env.app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const put = (url: string, payload: object) => env.app.inject({ method: "PUT", url, headers: { cookie }, payload });
const detail = async (id: string) => json(await env.app.inject({ url: `/api/invoices/${id}`, headers: { cookie } }));

describe("blind lock-total", () => {
  it("hides the machine total until typed, reveals it after, and locks on a match", async () => {
    const id = await extractedBill();
    const before = await detail(id);
    expect(before.totals.grandTotalPaise).toBe(0);
    expect(before.lockedTotalPaise).toBeUndefined();

    const res = json(await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND }));
    expect(res).toMatchObject({ match: true, extractedTotalPaise: GRAND, attempts: 1 });
    expect(res.invoice.lockedTotalPaise).toBe(GRAND);
    expect(res.invoice.totals.grandTotalPaise).toBe(GRAND);
    expect(res.invoice.checks.find((c: { id: string }) => c.id === "locked_total").status).toBe("pass");
    const again = await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND });
    expect(again.statusCode).toBe(409);
    expect(json(again).error.code).toBe("ALREADY_LOCKED");
  });

  it("after two mismatches stores the typed total, flags the bill and blocks sealing until fixed", async () => {
    const id = await extractedBill();
    const first = json(await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND + 1000 }));
    expect(first).toMatchObject({ match: false, attempts: 1, extractedTotalPaise: GRAND });
    expect(first.invoice.lockedTotalPaise).toBeUndefined();
    const second = json(await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND + 1000 }));
    expect(second).toMatchObject({ match: false, attempts: 2 });
    expect(second.invoice.lockedTotalPaise).toBe(GRAND + 1000);
    expect(second.invoice.totalsMeta.grandTotalPaise.flagged).toBe(true);
    const summary = json(await env.app.inject({ url: `/api/invoices?state=NEEDS_VERIFICATION`, headers: { cookie } })).items.find((i: { id: string }) => i.id === id);
    expect(summary.flaggedCount).toBeGreaterThanOrEqual(1);

    for (const l of second.invoice.lines) await put(`/api/invoices/${id}/lines/${l.id}`, { action: "accept" });
    const seal = await post(`/api/invoices/${id}/seal`, { durationMs: 1000 });
    expect(seal.statusCode).toBe(409);
    expect(json(seal).error.code).toBe("NOT_BALANCED");
    expect(json(seal).error.details.remainingPaise).toBe(1000);
    expect(json(seal).error.details.hints[0]).toMatchObject({ kind: "missing_line", amountPaise: 1000 });

    // The paper says ₹10 more: a freight charge the machine missed.
    const fixedTotals = { otherChargesPaise: 1000, grandTotalPaise: GRAND + 1000 };
    expect((await put(`/api/invoices/${id}/header`, { totals: fixedTotals })).statusCode).toBe(200);
    const ok = await post(`/api/invoices/${id}/seal`, { durationMs: 1000 });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("rejects bad input", async () => {
    const id = await extractedBill();
    expect((await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: 12.5 })).statusCode).toBe(400);
    expect((await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: -5 })).statusCode).toBe(400);
  });
});

describe("line verification and seal", () => {
  it("refuses to seal with pending lines or before the total is locked", async () => {
    const id = await extractedBill();
    const notLocked = await post(`/api/invoices/${id}/seal`, { durationMs: 10 });
    expect(json(notLocked).error.code).toBe("TOTAL_NOT_LOCKED");
    await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND });
    const pending = await post(`/api/invoices/${id}/seal`, { durationMs: 10 });
    expect(pending.statusCode).toBe(409);
    expect(json(pending).error).toMatchObject({ code: "NOT_BALANCED", details: { pendingCount: 5 } });
    const refused = await env.pool.query("SELECT count(*)::int AS n FROM verification_events WHERE invoice_id = $1 AND action = 'seal_refused'", [id]);
    expect(refused.rows[0].n).toBe(2);
  });

  it("edit recomputes the line, unbalanced edits block sealing, and a balanced bill seals", async () => {
    const id = await extractedBill();
    const lock = json(await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND }));
    const lines = lock.invoice.lines as { id: string; description: string; qtyMilli: number; ratePaise: number; discountPaise: number; gstRateBp: number; totalPaise: number }[];
    const [first, ...rest] = lines;
    for (const l of rest) expect((await put(`/api/invoices/${id}/lines/${l.id}`, { action: "accept" })).statusCode).toBe(200);

    // Staff changes qty 5 -> 4 (totalPaise omitted -> computed).
    const edited = json(await put(`/api/invoices/${id}/lines/${first!.id}`, { action: "edit", line: { description: first!.description, qtyMilli: 4000, ratePaise: first!.ratePaise, discountPaise: 0, gstRateBp: first!.gstRateBp } }));
    const l1 = edited.lines.find((l: { id: string }) => l.id === first!.id);
    const expected = computeLine({ qtyMilli: 4000, ratePaise: first!.ratePaise, discountPaise: 0, gstRateBp: first!.gstRateBp });
    expect(l1).toMatchObject({ status: "edited", qtyMilli: 4000, ...expected });

    const unbalanced = await post(`/api/invoices/${id}/seal`, { durationMs: 5000 });
    expect(unbalanced.statusCode).toBe(409);
    expect(json(unbalanced).error.code).toBe("NOT_BALANCED");
    expect(json(unbalanced).error.details.remainingPaise).toBe(first!.totalPaise - expected.totalPaise);
    expect((await detail(id)).state).toBe("NEEDS_VERIFICATION");

    // Paper actually said 5: fix it, seal.
    await put(`/api/invoices/${id}/lines/${first!.id}`, { action: "edit", line: { description: first!.description, qtyMilli: 5000, ratePaise: first!.ratePaise, discountPaise: 0, gstRateBp: first!.gstRateBp } });
    const sealed = await post(`/api/invoices/${id}/seal`, { durationMs: 42_000 });
    expect(sealed.statusCode, sealed.body).toBe(200);
    const s = json(sealed);
    expect(s.state).toBe("VERIFIED");
    expect(s.verifiedBy).toBe("Asha (S1)");
    expect(s.dueDate).toBeTruthy();
    const row = (await env.pool.query("SELECT verify_duration_ms, edit_count, verified_by FROM invoices WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ verify_duration_ms: 42_000, edit_count: 2, verified_by: fx.staffA.id });
    const events = await env.pool.query("SELECT action FROM verification_events WHERE invoice_id = $1 ORDER BY id", [id]);
    expect(events.rows.map((r) => r.action)).toEqual(["lock_total", "accept", "accept", "accept", "accept", "edit", "seal_refused", "edit", "seal"]);
    const timing = await env.pool.query("SELECT ms_since_prev FROM verification_events WHERE invoice_id = $1 AND action = 'seal'", [id]);
    expect(timing.rows[0].ms_since_prev).toBeGreaterThanOrEqual(0);

    // Verified data is frozen: only audited, owner-only vendor re-link remains.
    const change = await put(`/api/invoices/${id}/header`, { invoiceNo: "CHANGED" });
    expect(json(change).error.code).toBe("INVOICE_SEALED");
    const lineChange = await put(`/api/invoices/${id}/lines/${first!.id}`, { action: "remove" });
    expect(lineChange.statusCode).toBe(409);
  });

  it("removing a line and adding a missing one keeps the balance maths right", async () => {
    const id = await extractedBill();
    const lock = json(await post(`/api/invoices/${id}/lock-total`, { typedTotalPaise: GRAND }));
    const lines = lock.invoice.lines as { id: string; description: string; qtyMilli: number; ratePaise: number; discountPaise: number; gstRateBp: number; totalPaise: number }[];
    const last = lines[lines.length - 1]!;
    for (const l of lines.slice(0, -1)) await put(`/api/invoices/${id}/lines/${l.id}`, { action: "accept" });
    await put(`/api/invoices/${id}/lines/${last.id}`, { action: "remove" });
    const r = await post(`/api/invoices/${id}/seal`, { durationMs: 1 });
    expect(json(r).error.details.remainingPaise).toBe(last.totalPaise);
    const added = await post(`/api/invoices/${id}/lines`, { description: last.description, qtyMilli: last.qtyMilli, ratePaise: last.ratePaise, discountPaise: last.discountPaise, gstRateBp: last.gstRateBp });
    expect(added.statusCode).toBe(201);
    expect(json(added).lines).toHaveLength(6);
    expect((await post(`/api/invoices/${id}/seal`, { durationMs: 1 })).statusCode).toBe(200);
  });

  it("hold / unhold / reject are audited state changes", async () => {
    const id = await extractedBill();
    const h = json(await post(`/api/invoices/${id}/hold`, { reason: "vendor disputes rate" }));
    expect(h).toMatchObject({ state: "ON_HOLD", holdReason: "vendor disputes rate" });
    expect(json(await post(`/api/invoices/${id}/unhold`)).state).toBe("NEEDS_VERIFICATION");
    expect(json(await post(`/api/invoices/${id}/reject`, { reason: "not our bill" })).state).toBe("REJECTED");
    const audit = await env.pool.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id", [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["invoice.capture", "invoice.extracted", "invoice.hold", "invoice.unhold", "invoice.reject"]);
  });
});
