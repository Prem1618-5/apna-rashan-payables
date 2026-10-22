import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "../src/audit.js";
import { addDays, istToday } from "../src/services/invoices.js";
import { createTestEnv, gstin, insertVerifiedInvoice, json, login, seedBasic, type Fixture, type TestEnv } from "./helpers.js";

let env: TestEnv;
let fx: Fixture;
let owner: string;
let staffA: string;
let both: string; // staff member working in both stores
const today = istToday();
const ids: Record<string, string> = {};
const vendors: Record<string, string> = {};

const req = (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) => env.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function vendorWithBank(name: string, g: string, bank?: { accountNumber: string; ifsc: string; beneCode?: string }) {
  const v = json(await req(owner, "POST", "/api/vendors", { name, gstin: g }));
  if (bank) {
    const p = json(await req(staffA, "POST", `/api/vendors/${v.id}/bank`, { ...bank, accountNumberConfirm: bank.accountNumber }));
    await req(owner, "POST", `/api/vendors/${v.id}/bank/${p.bankVersions[0].id}/approve`);
    // Pretend the cooling-off period and the "new vendor" window have passed.
    await env.pool.query("UPDATE vendor_bank_accounts SET usable_from = now() - interval '1 hour' WHERE vendor_id = $1", [v.id]);
    await env.pool.query("UPDATE vendors SET created_at = now() - interval '90 days' WHERE id = $1", [v.id]);
  }
  return v.id as string;
}

beforeAll(async () => {
  env = await createTestEnv();
  fx = await seedBasic(env.pool);
  owner = await login(env.app, fx.owner);
  staffA = await login(env.app, fx.staffA);
  await req(owner, "POST", "/api/users", { name: "Chandan (S1+S2)", phone: "9000000013", pin: "3333", role: "staff", storeIds: [fx.storeA, fx.storeB] });
  both = await login(env.app, { phone: "9000000013", pin: "3333" });

  vendors.dairy = await vendorWithBank("Jharkhand Dairy Pvt Ltd", gstin("20AACCJ5555D1Z"), { accountNumber: "00601110000123", ifsc: "HDFC0000060", beneCode: "JHDAIRY01" });
  vendors.fmcg = await vendorWithBank("Ranchi FMCG Distributors", gstin("20AABCR4444F1Z"), { accountNumber: "123456789012", ifsc: "SBIN0001234" });
  vendors.nobank = await vendorWithBank("New Snacks Co", gstin("19AABCN3333S1Z"));
  vendors.credit = await vendorWithBank("Credit Only Traders", gstin("20AABCC2222C1Z"), { accountNumber: "998877665544", ifsc: "ICIC0000456" });
  const bill = (key: string, storeId: string, vendorId: string, invoiceNo: string, totalPaise: number, dueDate: string, docType: "INV" | "CRN" = "INV") =>
    insertVerifiedInvoice(env.pool, { storeId, vendorId, userId: fx.staffA.id, invoiceNo, invoiceDate: addDays(today, -20), dueDate, totalPaise, docType }).then((id) => (ids[key] = id));
  await bill("d1", fx.storeA, vendors.dairy, "JD-101", 10_000_00, addDays(today, -1));
  await bill("d2", fx.storeB, vendors.dairy, "JD-102", 5_000_00, today);
  await bill("dc", fx.storeA, vendors.dairy, "CN-7", 1_000_00, today, "CRN");
  await bill("f1", fx.storeB, vendors.fmcg, "RFD-9001", 2_50_000_00, addDays(today, 5));
  await bill("n1", fx.storeA, vendors.nobank, "NS-1", 3_000_00, addDays(today, 20));
  await bill("c1", fx.storeA, vendors.credit, "CR-1", 2_000_00, today, "CRN");
});
afterAll(() => env.close());

describe("payables", () => {
  it("groups verified bills per vendor across stores, with credit notes negative", async () => {
    const p = json(await req(owner, "GET", "/api/payables?due=all"));
    const dairy = p.vendors.find((v: { vendorId: string }) => v.vendorId === vendors.dairy);
    expect(dairy).toMatchObject({ vendorName: "Jharkhand Dairy Pvt Ltd", bankReady: true, totalPaise: 14_000_00 });
    expect(dairy.bills.map((b: { invoiceNo: string; amountPaise: number; storeName: string; docType: string }) => [b.invoiceNo, b.amountPaise, b.storeName, b.docType])).toEqual([
      ["JD-101", 10_000_00, "Store One Lalpur", "INV"],
      ["CN-7", -1_000_00, "Store One Lalpur", "CRN"],
      ["JD-102", 5_000_00, "Store Two Doranda", "INV"],
    ]);
    const nb = p.vendors.find((v: { vendorId: string }) => v.vendorId === vendors.nobank);
    expect(nb).toMatchObject({ bankReady: false, blockedReason: "No approved bank account" });
    expect(p.totalPaise).toBe(14_000_00 + 2_50_000_00 + 3_000_00 - 2_000_00);
  });

  it("filters by due date", async () => {
    const count = async (due: string) => json(await req(owner, "GET", `/api/payables?due=${due}`)).vendors.flatMap((v: { bills: unknown[] }) => v.bills).length;
    expect(await count("overdue")).toBe(1);
    expect(await count("today")).toBe(4);
    expect(await count("week")).toBe(5);
    expect(await count("all")).toBe(6);
    expect((await req(owner, "GET", "/api/payables?due=soon")).statusCode).toBe(400);
  });

  it("staff only see their stores' bills", async () => {
    const p = json(await req(staffA, "GET", "/api/payables"));
    const dairy = p.vendors.find((v: { vendorId: string }) => v.vendorId === vendors.dairy);
    expect(dairy.totalPaise).toBe(9_000_00);
    expect(p.vendors.find((v: { vendorId: string }) => v.vendorId === vendors.fmcg)).toBeUndefined();
  });
});

let runId: string;

describe("payment runs", () => {

  it("refuses a run whose credit notes cancel the bills, or bills the user cannot see", async () => {
    const r = await req(owner, "POST", "/api/payment-runs", { invoiceIds: [ids.c1], valueDate: today });
    expect(r.statusCode).toBe(422);
    expect(json(r).error.code).toBe("NOTHING_TO_PAY");
    const hidden = await req(staffA, "POST", "/api/payment-runs", { invoiceIds: [ids.f1], valueDate: today });
    expect(hidden.statusCode).toBe(404);
    const past = await req(owner, "POST", "/api/payment-runs", { invoiceIds: [ids.d1], valueDate: addDays(today, -1) });
    expect(json(past).error.code).toBe("VALUE_DATE_PAST");
  });

  it("maker-checker: whoever prepares a run cannot approve it", async () => {
    const own = json(await req(owner, "POST", "/api/payment-runs", { invoiceIds: [ids.d1], valueDate: today }));
    expect(own.state).toBe("DRAFT");
    expect(own.warnings).toContainEqual(expect.objectContaining({ code: "same_preparer" }));
    const r = await req(owner, "POST", `/api/payment-runs/${own.id}/approve`);
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe("SAME_APPROVER");
    const cancelled = json(await req(owner, "POST", `/api/payment-runs/${own.id}/cancel`));
    expect(cancelled.state).toBe("CANCELLED");
    expect((await env.pool.query("SELECT state FROM invoices WHERE id = $1", [ids.d1])).rows[0].state).toBe("VERIFIED");
  });

  it("staff prepare a DRAFT with one payment per vendor; staff cannot approve", async () => {
    const r = await req(both, "POST", "/api/payment-runs", { invoiceIds: [ids.d1, ids.d2, ids.dc, ids.f1], valueDate: today });
    expect(r.statusCode, r.body).toBe(201);
    const run = json(r);
    runId = run.id;
    expect(run).toMatchObject({ state: "DRAFT", count: 2, totalPaise: 14_000_00 + 2_50_000_00, preparedBy: "Chandan (S1+S2)" });
    const dairy = run.items.find((i: { vendorId: string }) => i.vendorId === vendors.dairy);
    expect(dairy).toMatchObject({ amountPaise: 14_000_00, txnType: "I", accountMasked: "XXXXXXXXXX0123", ifsc: "HDFC0000060", state: "PENDING" });
    expect(dairy.bills).toHaveLength(3);
    expect(run.items.find((i: { vendorId: string }) => i.vendorId === vendors.fmcg).txnType).toBe("R");
    expect(run.warnings.filter((w: { level: string }) => w.level === "block")).toEqual([]);
    expect((await req(both, "POST", `/api/payment-runs/${runId}/approve`)).statusCode).toBe(403);
    // The bills left the payables list.
    const p = json(await req(owner, "GET", "/api/payables"));
    expect(p.vendors.find((v: { vendorId: string }) => v.vendorId === vendors.dairy)).toBeUndefined();
  });

  it("an invoice cannot be in two open runs (API check and DB constraint)", async () => {
    const r = await req(owner, "POST", "/api/payment-runs", { invoiceIds: [ids.d1], valueDate: today });
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe("ALREADY_IN_RUN");
    // Bypass the API: the partial unique index still refuses it.
    const c = await env.pool.connect();
    try {
      await c.query("BEGIN");
      const run = await c.query("INSERT INTO payment_runs (ref, value_date, prepared_by) VALUES ('PRTEST1', $1, $2) RETURNING id", [today, fx.owner.id]);
      const item = await c.query("INSERT INTO payment_run_items (run_id, vendor_id, amount_paise, customer_ref) VALUES ($1, $2, 100, 'PRTEST1001') RETURNING id", [run.rows[0].id, vendors.dairy]);
      await expect(c.query("INSERT INTO payment_run_bills (run_id, item_id, invoice_id, amount_paise) VALUES ($1, $2, $3, 100)", [run.rows[0].id, item.rows[0].id, ids.d1])).rejects.toMatchObject({
        code: "23505",
        constraint: "payment_run_bills_one_open_run",
      });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("owner approval generates a valid HDFC file once; control totals match the rows", async () => {
    const r = await req(owner, "POST", `/api/payment-runs/${runId}/approve`);
    expect(r.statusCode, r.body).toBe(200);
    const run = json(r);
    expect(run.state).toBe("APPROVED");
    expect(run.approvedBy).toBe("Owner");
    const [y, m, d] = today.split("-");
    expect(run.file.name).toBe(`ARAD01${d}${m}.001`);
    void y;
    expect(run.file.control).toMatchObject({ count: 2, total: "264000.00", byType: { I: { count: 1, totalPaise: 14_000_00 }, R: { count: 1, totalPaise: 2_50_000_00 }, N: { count: 0 } } });

    const f = await req(owner, "GET", `/api/payment-runs/${runId}/file`);
    expect(f.statusCode).toBe(200);
    expect(f.headers["content-disposition"]).toBe(`attachment; filename="${run.file.name}"`);
    expect(createHash("sha256").update(f.rawPayload).digest("hex")).toBe(run.file.sha256);
    const content = f.rawPayload.toString("ascii");
    expect(content.endsWith("\r\n")).toBe(true);
    const rows = content.trimEnd().split("\r\n").map((l) => l.split(","));
    expect(rows).toHaveLength(run.file.control.count);
    for (const row of rows) expect(row).toHaveLength(28);
    const sum = rows.reduce((s, row) => s + Math.round(Number(row[3]) * 100), 0);
    expect(sum).toBe(14_000_00 + 2_50_000_00);
    const dairyRow = rows.find((row) => row[1] === "JHDAIRY01")!;
    expect(dairyRow.slice(0, 5)).toEqual(["I", "JHDAIRY01", "00601110000123", "14000.00", "Jharkhand Dairy Pvt Ltd"]);
    expect(dairyRow[24]).toBe("HDFC0000060");
    expect(dairyRow[22]).toBe(`${d}/${m}/${today.slice(0, 4)}`);
    // Customer refs in the file are the items' refs.
    expect(rows.map((row) => row[13]).sort()).toEqual(run.items.map((i: { customerRef: string }) => i.customerRef).sort());

    // Invoices moved on; the file never changes; staff cannot download it.
    const st = await env.pool.query("SELECT DISTINCT state FROM invoices WHERE id = ANY($1::uuid[])", [[ids.d1, ids.d2, ids.dc, ids.f1]]);
    expect(st.rows.map((x) => x.state)).toEqual(["IN_PAYMENT_RUN"]);
    expect((await req(both, "GET", `/api/payment-runs/${runId}/file`)).statusCode).toBe(403);
    expect((await req(owner, "POST", `/api/payment-runs/${runId}/approve`)).statusCode).toBe(409);
    const again = await req(owner, "GET", `/api/payment-runs/${runId}/file`);
    expect(again.rawPayload.equals(f.rawPayload)).toBe(true);
    // Stored encrypted.
    const stored = (await env.pool.query("SELECT file_content FROM payment_runs WHERE id = $1", [runId])).rows[0].file_content;
    expect(stored).not.toContain("00601110000123");
  });

  it("advice CSV lists vendor, bills, stores and amounts", async () => {
    const r = await req(owner, "GET", `/api/payment-runs/${runId}/advice.csv`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    const lines = r.body.trimEnd().split("\r\n");
    expect(lines[0]).toContain("Vendor");
    expect(lines).toHaveLength(1 + 4);
    expect(r.body).toContain("Jharkhand Dairy Pvt Ltd");
    expect(r.body).toContain("CN-7");
    expect(r.body).toContain("-1000.00");
    expect(r.body).toContain("Store Two Doranda");
    expect(r.body).not.toContain("00601110000123");
  });

  it("mark-uploaded, mark-failed releases the bills, mark-paid records UTRs", async () => {
    expect(json(await req(owner, "POST", `/api/payment-runs/${runId}/mark-uploaded`)).state).toBe("UPLOADED");
    expect((await req(owner, "POST", `/api/payment-runs/${runId}/cancel`)).statusCode).toBe(409);
    const run = json(await req(owner, "GET", `/api/payment-runs/${runId}`));
    const fmcgItem = run.items.find((i: { vendorId: string }) => i.vendorId === vendors.fmcg);
    const dairyItem = run.items.find((i: { vendorId: string }) => i.vendorId === vendors.dairy);

    const failed = json(await req(owner, "POST", `/api/payment-runs/${runId}/items/${fmcgItem.id}/mark-failed`, { reason: "beneficiary account closed" }));
    expect(failed.items.find((i: { id: string }) => i.id === fmcgItem.id)).toMatchObject({ state: "FAILED", failReason: "beneficiary account closed" });
    expect(failed).toMatchObject({ count: 1, totalPaise: 14_000_00 });
    expect((await env.pool.query("SELECT state FROM invoices WHERE id = $1", [ids.f1])).rows[0].state).toBe("VERIFIED");
    const p = json(await req(owner, "GET", "/api/payables"));
    expect(p.vendors.find((v: { vendorId: string }) => v.vendorId === vendors.fmcg).bills[0].invoiceId).toBe(ids.f1);

    const bad = await req(owner, "POST", `/api/payment-runs/${runId}/mark-paid`, { utrs: { [dairyItem.id]: "bad utr!" } });
    expect(bad.statusCode).toBe(400);
    const paid = json(await req(owner, "POST", `/api/payment-runs/${runId}/mark-paid`, { utrs: { [dairyItem.id]: "hdfcr52026102200001" } }));
    expect(paid.state).toBe("PAID");
    expect(paid.items.find((i: { id: string }) => i.id === dairyItem.id)).toMatchObject({ state: "PAID", utr: "HDFCR52026102200001" });
    const st = await env.pool.query("SELECT DISTINCT state FROM invoices WHERE id = ANY($1::uuid[])", [[ids.d1, ids.d2, ids.dc]]);
    expect(st.rows.map((x) => x.state)).toEqual(["PAID"]);
    // The released bill can go into a new run.
    const next = await req(both, "POST", "/api/payment-runs", { invoiceIds: [ids.f1], valueDate: today });
    expect(next.statusCode).toBe(201);
    await req(both, "POST", `/api/payment-runs/${json(next).id}/cancel`);
  });

  it("warns about unusual amounts and possible duplicate bill numbers; second file of the day is .002", async () => {
    const big = await insertVerifiedInvoice(env.pool, { storeId: fx.storeB, vendorId: vendors.dairy!, userId: fx.staffA.id, invoiceNo: "JD-900", invoiceDate: addDays(today, -2), dueDate: today, totalPaise: 60_000_00 });
    const dupNo = await insertVerifiedInvoice(env.pool, { storeId: fx.storeB, vendorId: vendors.dairy!, userId: fx.staffA.id, invoiceNo: "jd 101", invoiceDate: addDays(today, -2), dueDate: today, totalPaise: 1_00 });
    const run = json(await req(both, "POST", "/api/payment-runs", { invoiceIds: [big, dupNo], valueDate: today }));
    const codes = run.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain("amount_unusual");
    expect(codes).toContain("possible_duplicate");
    const ok = json(await req(owner, "POST", `/api/payment-runs/${run.id}/approve`));
    expect(ok.file.name.endsWith(".002")).toBe(true);
    const cancelled = json(await req(owner, "POST", `/api/payment-runs/${run.id}/cancel`));
    expect(cancelled.state).toBe("CANCELLED");
    expect((await env.pool.query("SELECT state FROM invoices WHERE id = $1", [big])).rows[0].state).toBe("VERIFIED");
    const list = json(await req(owner, "GET", "/api/payment-runs"));
    expect(list.length).toBeGreaterThanOrEqual(3);
    const staffList = json(await req(staffA, "GET", "/api/payment-runs"));
    expect(staffList).toEqual([]);
  });

  it("dashboard summarises what is owed", async () => {
    const d = json(await req(owner, "GET", "/api/dashboard"));
    expect(d.stores).toHaveLength(2);
    expect(d.owedPaise).toBeGreaterThan(0);
    expect(d.recentRuns.length).toBeGreaterThan(0);
    expect(d.pendingApprovals).toMatchObject({ bankChanges: 0 });
  });
});

describe("audit log", () => {
  it("is append-only and its hash chain verifies; tampering is detected", async () => {
    const n = (await env.pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;
    expect(n).toBeGreaterThan(20);
    expect(await verifyAuditChain(env.pool)).toBeUndefined();
    await expect(env.pool.query("UPDATE audit_log SET actor = 'mallory' WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(env.pool.query("DELETE FROM audit_log WHERE id = 1")).rejects.toThrow(/append-only/);
    await expect(env.pool.query("TRUNCATE audit_log")).rejects.toThrow(/append-only/);

    const entries = json(await req(owner, "GET", `/api/audit?entity=payment_run&id=${runId}`));
    expect(entries.map((e: { action: string }) => e.action)).toContain("payment_run.approve");

    // A superuser who disables the trigger can edit a row, but the chain exposes it.
    await env.pool.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update");
    await env.pool.query("UPDATE audit_log SET detail = '{\"amountPaise\": 1}' WHERE id = 5");
    await env.pool.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update");
    expect(await verifyAuditChain(env.pool)).toEqual({ id: 5, problem: "hash does not match row content" });
  });
});

