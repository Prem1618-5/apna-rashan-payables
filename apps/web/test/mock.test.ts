import { blockingFailures, verificationBalance } from "@arad/core";
import { describe, expect, it } from "vitest";
import { invoiceSvg } from "../src/api/mock/invoice-svg";
import { isoDay } from "../src/api/mock/seed";
import { MockServer } from "../src/api/mock/server";
import { sha256Hex } from "../src/api/mock/sha256";

const fresh = () => new MockServer({ persist: false });

describe("mock backend", () => {
  it("seeds six stores, ~30 vendors and bills in every important state", () => {
    const s = fresh();
    expect(s.db.stores).toHaveLength(6);
    expect(s.db.vendors.length).toBeGreaterThanOrEqual(30);
    const states = new Set(s.db.invoices.map((i) => i.state));
    for (const st of ["NEEDS_VERIFICATION", "EXTRACTING", "VERIFIED", "IN_PAYMENT_RUN", "PAID", "ON_HOLD", "DUPLICATE", "REJECTED"]) expect(states).toContain(st);
    expect(s.db.runs.map((r) => r.state).sort()).toEqual(["DRAFT", "PAID"]);
  });

  it("every seeded verified bill passes the deterministic checks", () => {
    const s = fresh();
    const owner = s.requireUser("u_owner");
    for (const inv of s.db.invoices.filter((i) => ["VERIFIED", "PAID", "IN_PAYMENT_RUN"].includes(i.state))) {
      const d = s.getInvoice(owner, inv.id);
      expect(blockingFailures(d.checks), `${inv.id}: ${JSON.stringify(blockingFailures(d.checks))}`).toEqual([]);
    }
  });

  it("verifies the demo bill end to end: blind total, accept, fix the misread line, seal", () => {
    const s = fresh();
    const staff = s.requireUser("u_sunita");
    const paperTotal = s.db.invoices.find((i) => i.id === "inv_demo1")!.paper.totals.grandTotalPaise;
    const wrong = s.lockTotal(staff, "inv_demo1", paperTotal + 1000);
    expect(wrong.match).toBe(false);
    expect(wrong.invoice.lockedTotalPaise).toBeUndefined();
    const ok = s.lockTotal(staff, "inv_demo1", paperTotal);
    expect(ok.match).toBe(true);
    let d = ok.invoice;
    for (const l of d.lines) {
      if (l.meta?.qtyMilli?.flagged) {
        d = s.updateLine(staff, d.id, l.id, { action: "edit", line: { ...l, qtyMilli: 12000, totalPaise: undefined } });
      } else d = s.updateLine(staff, d.id, l.id, { action: "accept" });
    }
    expect(verificationBalance(d.lockedTotalPaise!, d.lines, d.totals).balanced).toBe(true);
    expect(blockingFailures(d.checks)).toEqual([]);
    const sealed = s.seal(staff, d.id, 61000);
    expect(sealed.state).toBe("VERIFIED");
    expect(sealed.dueDate).toBeTruthy();
  });

  it("demo bill 2 is missing a line until it is added", () => {
    const s = fresh();
    const staff = s.requireUser("u_sunita");
    const inv = s.db.invoices.find((i) => i.id === "inv_demo2")!;
    let d = s.lockTotal(staff, inv.id, inv.paper.totals.grandTotalPaise).invoice;
    for (const l of d.lines) d = s.updateLine(staff, d.id, l.id, { action: "accept" });
    const bal = verificationBalance(d.lockedTotalPaise!, d.lines, d.totals);
    expect(bal.remainingPaise).toBe(inv.paper.lines[4]!.totalPaise);
    const p = inv.paper.lines[4]!;
    d = s.addLine(staff, d.id, { description: p.description, hsn: p.hsn, qtyMilli: p.qtyMilli, unit: p.unit, mrpPaise: p.mrpPaise, ratePaise: p.ratePaise, discountPaise: p.discountPaise, gstRateBp: p.gstRateBp });
    expect(verificationBalance(d.lockedTotalPaise!, d.lines, d.totals).balanced).toBe(true);
    expect(s.seal(staff, d.id, 1000).state).toBe("VERIFIED");
  });

  it("makes a payment run, approves it and produces an HDFC file with one row per vendor", () => {
    const s = fresh();
    const owner = s.requireUser("u_owner");
    const pay = s.payables(owner, "all");
    const eligible = pay.vendors.filter((v) => v.bankReady && v.totalPaise > 0);
    expect(eligible.length).toBeGreaterThan(3);
    expect(pay.vendors.some((v) => !v.bankReady)).toBe(true);
    const run = s.createRun(owner, eligible.flatMap((v) => v.bills.map((b) => b.invoiceId)), isoDay());
    expect(run.state).toBe("DRAFT");
    expect(run.items).toHaveLength(eligible.length);
    expect(run.warnings.some((w) => w.code === "same_preparer")).toBe(true);
    const approved = s.approveRun(owner, run.id);
    expect(approved.state).toBe("APPROVED");
    expect(approved.file?.control.count).toBe(eligible.length);
    const f = s.runFile(owner, run.id);
    const rows = f.content.split("\r\n").filter(Boolean);
    expect(rows).toHaveLength(eligible.length);
    expect(rows.every((r) => r.split(",").length === 28)).toBe(true);
    expect(approved.file?.sha256).toBe(sha256Hex(f.content));
    expect(s.markUploaded(owner, run.id).state).toBe("UPLOADED");
    const paid = s.markPaid(owner, run.id, { [approved.items[0]!.id]: "utr123" });
    expect(paid.state).toBe("PAID");
    expect(paid.items[0]!.utr).toBe("UTR123");
  });

  it("bank details: typed twice, IFSC checked, owner approval starts a cooling-off", () => {
    const s = fresh();
    const staff = s.requireUser("u_sunita");
    const owner = s.requireUser("u_owner");
    const v = s.createVendor(staff, { name: "Test Traders" });
    expect(v.status).toBe("PENDING");
    expect(() => s.addBank(staff, v.id, { accountNumber: "123456789012", accountNumberConfirm: "123456789013", ifsc: "SBIN0001234" })).toThrow(/do not match/);
    expect(() => s.addBank(staff, v.id, { accountNumber: "123456789012", accountNumberConfirm: "123456789012", ifsc: "SBI0001234" })).toThrow(/IFSC/);
    const withBank = s.addBank(staff, v.id, { accountNumber: "123456789012", accountNumberConfirm: "123456789012", ifsc: "sbin0001234" });
    expect(withBank.bankVersions[0]!.accountMasked).toBe("XXXXXX9012");
    expect(JSON.stringify(withBank)).not.toContain("123456789012");
    expect(() => s.approveBank(staff, v.id, withBank.bankVersions[0]!.id)).toThrow(/owner/);
    const ok = s.approveBank(owner, v.id, withBank.bankVersions[0]!.id);
    expect(Date.parse(ok.bankVersions[0]!.usableFrom!)).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it("draws every bill page as well-formed SVG (no duplicate attributes, escaped text)", () => {
    const s = fresh();
    for (const inv of s.db.invoices) {
      const svg = invoiceSvg(inv.paper);
      for (const tag of svg.match(/<[a-z]+\s[^>]*>/g) ?? []) {
        const names = [...tag.matchAll(/\s([a-z-]+)="/g)].map((m) => m[1]);
        expect(new Set(names).size, `${inv.id}: ${tag.slice(0, 80)}`).toBe(names.length);
      }
      expect(svg.replace(/&(amp|lt|gt|quot|#\d+);/g, "")).not.toMatch(/&/);
    }
  });

  it("sha256 matches a known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
