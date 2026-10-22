import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, gstin, insertVerifiedInvoice, json, login, seedBasic, type Fixture, type TestEnv } from "./helpers.js";

let env: TestEnv;
let fx: Fixture;
let staff: string;
let owner: string;

beforeAll(async () => {
  env = await createTestEnv();
  fx = await seedBasic(env.pool);
  staff = await login(env.app, fx.staffA);
  owner = await login(env.app, fx.owner);
});
afterAll(() => env.close());

const req = (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) => env.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

describe("vendors", () => {
  it("staff create PENDING vendors, the owner approves, duplicates by GSTIN / PAN are refused", async () => {
    const g = gstin("20AABCG1234G1Z");
    const created = await req(staff, "POST", "/api/vendors", { name: "Ganesh Traders", gstin: g, phone: "9876543210" });
    expect(created.statusCode).toBe(201);
    const v = json(created);
    expect(v).toMatchObject({ status: "PENDING", gstin: g, pan: "AABCG1234G", paymentTermsDays: 30, bankStatus: "NONE", bankVersions: [] });

    const dupG = await req(staff, "POST", "/api/vendors", { name: "Ganesh Traders Again", gstin: g });
    expect(dupG.statusCode).toBe(409);
    expect(json(dupG).error).toMatchObject({ code: "DUPLICATE_VENDOR", details: { matches: [{ vendorId: v.id, field: "gstin" }] } });
    const dupP = await req(staff, "POST", "/api/vendors", { name: "Ganesh Bihar", gstin: gstin("10AABCG1234G1Z") });
    expect(json(dupP).error).toMatchObject({ code: "DUPLICATE_VENDOR", details: { matches: [{ field: "pan" }] } });
    expect(json(await req(staff, "POST", "/api/vendors", { name: "Bad", gstin: "20AABCG1234G1Z0" })).error.code).toBe("INVALID_GSTIN");

    expect((await req(staff, "POST", `/api/vendors/${v.id}/approve`)).statusCode).toBe(403);
    const ok = json(await req(owner, "POST", `/api/vendors/${v.id}/approve`));
    expect(ok.status).toBe("ACTIVE");
    // Staff may no longer edit an approved vendor; the owner may.
    expect((await req(staff, "PUT", `/api/vendors/${v.id}`, { name: "Renamed" })).statusCode).toBe(403);
    const upd = json(await req(owner, "PUT", `/api/vendors/${v.id}`, { name: "Shree Ganesh Traders", gstin: g, paymentTermsDays: 15 }));
    expect(upd).toMatchObject({ name: "Shree Ganesh Traders", paymentTermsDays: 15 });
    const owner2 = json(await req(owner, "POST", "/api/vendors", { name: "Owner Added Co" }));
    expect(owner2.status).toBe("ACTIVE");
    const list = json(await req(staff, "GET", "/api/vendors?q=ganesh"));
    expect(list.map((x: { id: string }) => x.id)).toEqual([v.id]);
  });

  it("bank details: typed twice, IFSC checked, masked, owner-approved with cooling-off that blocks payment", async () => {
    const v = json(await req(owner, "POST", "/api/vendors", { name: "Jharkhand Dairy Pvt Ltd", gstin: gstin("20AACCJ5555D1Z") }));
    const mismatch = await req(staff, "POST", `/api/vendors/${v.id}/bank`, { accountNumber: "50200012345678", accountNumberConfirm: "50200012345679", ifsc: "HDFC0000060" });
    expect(json(mismatch).error.code).toBe("ACCOUNT_MISMATCH");
    expect(json(await req(staff, "POST", `/api/vendors/${v.id}/bank`, { accountNumber: "123", accountNumberConfirm: "123", ifsc: "HDFC0000060" })).error.code).toBe("INVALID_ACCOUNT");
    expect(json(await req(staff, "POST", `/api/vendors/${v.id}/bank`, { accountNumber: "50200012345678", accountNumberConfirm: "50200012345678", ifsc: "HDFC000060" })).error.code).toBe("INVALID_IFSC");

    const proposed = await req(staff, "POST", `/api/vendors/${v.id}/bank`, { accountNumber: "5020 0012 345678", accountNumberConfirm: "50200012345678", ifsc: "hdfc0000060", beneCode: "JHDAIRY01" });
    expect(proposed.statusCode).toBe(201);
    const p = json(proposed);
    expect(p.bankStatus).toBe("PENDING");
    expect(p.bankVersions[0]).toMatchObject({ version: 1, status: "PENDING", accountMasked: "XXXXXXXXXX5678", ifsc: "HDFC0000060", beneCode: "JHDAIRY01", createdBy: "Asha (S1)" });
    expect(proposed.body).not.toContain("50200012345678");
    const stored = (await env.pool.query("SELECT account_number_enc FROM vendor_bank_accounts WHERE vendor_id = $1", [v.id])).rows[0];
    expect(stored.account_number_enc).not.toContain("5020001234");

    // The same account number for another vendor is refused.
    const other = json(await req(owner, "POST", "/api/vendors", { name: "Shady Dairy" }));
    const dupAcct = await req(staff, "POST", `/api/vendors/${other.id}/bank`, { accountNumber: "50200012345678", accountNumberConfirm: "50200012345678", ifsc: "SBIN0001234" });
    expect(dupAcct.statusCode).toBe(409);
    expect(json(dupAcct).error).toMatchObject({ code: "DUPLICATE_VENDOR", details: { matches: [{ vendorId: v.id, field: "accountNumber" }] } });

    const versionId = p.bankVersions[0].id;
    expect((await req(staff, "POST", `/api/vendors/${v.id}/bank/${versionId}/approve`)).statusCode).toBe(403);
    const approved = json(await req(owner, "POST", `/api/vendors/${v.id}/bank/${versionId}/approve`));
    expect(approved.bankStatus).toBe("APPROVED");
    const usable = Date.parse(approved.bankVersions[0].usableFrom);
    expect(usable - Date.now()).toBeGreaterThan(23 * 3600_000);

    // A verified bill for this vendor is listed but not payable during cooling-off.
    const inv = await insertVerifiedInvoice(env.pool, { storeId: fx.storeA, vendorId: v.id, userId: fx.staffA.id, invoiceNo: "JD-1", invoiceDate: today(), dueDate: today(), totalPaise: 50_000_00 });
    const pay = json(await req(owner, "GET", "/api/payables"));
    const pv = pay.vendors.find((x: { vendorId: string }) => x.vendorId === v.id);
    expect(pv).toMatchObject({ bankReady: false, totalPaise: 50_000_00 });
    expect(pv.blockedReason).toMatch(/cooling-off/);

    const run = json(await req(staff, "POST", "/api/payment-runs", { invoiceIds: [inv], valueDate: today() }));
    expect(run.state).toBe("DRAFT");
    expect(run.warnings).toContainEqual(expect.objectContaining({ code: "bank_not_ready", level: "block", vendorId: v.id }));
    const blocked = await req(owner, "POST", `/api/payment-runs/${run.id}/approve`);
    expect(blocked.statusCode).toBe(409);
    expect(json(blocked).error.code).toBe("RUN_BLOCKED");

    // Cooling-off over: payable.
    await env.pool.query("UPDATE vendor_bank_accounts SET usable_from = now() - interval '1 minute' WHERE id = $1", [versionId]);
    // The bill sits in the draft run, so it is no longer listed as payable.
    const pay2 = json(await req(owner, "GET", "/api/payables"));
    expect(pay2.vendors.find((x: { vendorId: string }) => x.vendorId === v.id)).toBeUndefined();
    const draft = json(await req(owner, "GET", `/api/payment-runs/${run.id}`));
    expect(draft.warnings.filter((w: { level: string }) => w.level === "block")).toEqual([]);
    const approvedRun = await req(owner, "POST", `/api/payment-runs/${run.id}/approve`);
    expect(approvedRun.statusCode, approvedRun.body).toBe(200);
    expect(json(approvedRun).state).toBe("APPROVED");

    // Changing bank details: new version, old one superseded on approval, cooling-off again.
    const v2 = json(await req(staff, "POST", `/api/vendors/${v.id}/bank`, { accountNumber: "00601110000999", accountNumberConfirm: "00601110000999", ifsc: "HDFC0000060", beneCode: "JHDAIRY02" }));
    expect(v2.bankStatus).toBe("APPROVED"); // old still approved until the owner approves the new one
    const newId = v2.bankVersions.find((b: { version: number }) => b.version === 2).id;
    const after = json(await req(owner, "POST", `/api/vendors/${v.id}/bank/${newId}/approve`));
    expect(after.bankVersions.map((b: { version: number; status: string }) => [b.version, b.status])).toEqual([
      [2, "APPROVED"],
      [1, "SUPERSEDED"],
    ]);
    expect(after.accountMasked).toBe("XXXXXXXXXX0999");
    const audit = await env.pool.query("SELECT action FROM audit_log WHERE entity = 'vendor' AND entity_id = $1 ORDER BY id", [v.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["vendor.create", "vendor.bank_propose", "vendor.bank_approve", "vendor.bank_propose", "vendor.bank_approve"]);
    expect(JSON.stringify(audit.rows)).not.toContain("50200012345678");
  });
});
