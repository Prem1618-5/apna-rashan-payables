import { describe, expect, it } from "vitest";
import {
  balanceHints,
  classifyQr,
  computeLine,
  financialYear,
  formatInr,
  gstinCheckChar,
  isValidGstin,
  runChecks,
  toMilli,
  toPaise,
  verificationBalance,
  type InvoiceLine,
  type InvoiceTotals,
} from "../src/index.js";

const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const SELLER = gstin("20AABCS1234F1Z");
const BUYER = gstin("20AAACA9999K1Z");
const OUT_OF_STATE = gstin("19AABCS1234F1Z");

function line(idx: number, qty: string, rate: string, gst: number, status: InvoiceLine["status"] = "pending"): InvoiceLine {
  const base = { qtyMilli: toMilli(qty), ratePaise: toPaise(rate), discountPaise: 0, gstRateBp: gst };
  return { id: `l${idx}`, idx, description: `Item ${idx}`, ...base, ...computeLine(base), status };
}

function totalsFor(lines: InvoiceLine[], extra: Partial<InvoiceTotals> = {}): InvoiceTotals {
  const taxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
  const t = { taxablePaise: taxable, cgstPaise: Math.round(tax / 2), sgstPaise: tax - Math.round(tax / 2), igstPaise: 0, otherChargesPaise: 0, discountPaise: 0, roundOffPaise: 0, grandTotalPaise: 0, ...extra };
  t.grandTotalPaise = extra.grandTotalPaise ?? taxable + tax + t.otherChargesPaise - t.discountPaise + t.roundOffPaise;
  return t;
}

describe("money", () => {
  it("parses rupees to paise exactly", () => {
    expect(toPaise("1,23,456.7")).toBe(12345670);
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise("₹ 99")).toBe(9900);
    expect(() => toPaise("12.345")).toThrow();
  });
  it("formats with Indian grouping", () => {
    expect(formatInr(12345670)).toBe("₹1,23,456.70");
    expect(formatInr(-5)).toBe("-₹0.05");
    expect(formatInr(99900)).toBe("₹999.00");
  });
});

describe("gstin", () => {
  it("validates checksum", () => {
    expect(isValidGstin(SELLER)).toBe(true);
    const wrong = SELLER.slice(0, 14) + (SELLER[14] === "A" ? "B" : "A");
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true); // widely published sample
  });
});

describe("line maths", () => {
  it("computes qty × rate − discount + GST", () => {
    expect(computeLine({ qtyMilli: 50_000, ratePaise: 4_500, discountPaise: 1_000, gstRateBp: 1200 })).toEqual({
      taxablePaise: 224_000,
      taxPaise: 26_880,
      totalPaise: 250_880,
    });
  });
});

describe("checks", () => {
  const lines = [line(0, "50", "45", 1200), line(1, "2.5", "120", 500)];
  const header = { sellerGstin: SELLER, buyerGstin: BUYER, invoiceNo: "INV-1", invoiceDate: "2026-10-20" };

  it("passes a correct invoice", () => {
    const checks = runChecks({ header, totals: totalsFor(lines), lines }, { today: "2026-10-22" });
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  it("catches a wrong line, wrong tax type and future date", () => {
    const bad = [{ ...lines[0]!, totalPaise: lines[0]!.totalPaise + 100 }, lines[1]!];
    const checks = runChecks(
      { header: { ...header, buyerGstin: OUT_OF_STATE, invoiceDate: "2026-11-01" }, totals: totalsFor(lines), lines: bad },
      { today: "2026-10-22" },
    );
    const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["line_math", "tax_split", "invoice_date", "grand_total"]));
  });

  it("compares with the e-invoice QR", () => {
    const t = totalsFor(lines);
    const qr = { sellerGstin: SELLER, buyerGstin: BUYER, docNo: "INV-1", docType: "INV", docDate: "2026-10-20", totalPaise: t.grandTotalPaise, itemCount: 3, irn: "x" };
    const checks = runChecks({ header, totals: t, lines, qr }, { today: "2026-10-22" });
    expect(checks.find((c) => c.id === "qr_item_count")?.status).toBe("fail");
    expect(checks.find((c) => c.id === "qr_total")?.status).toBe("pass");
  });
});

describe("balance to zero", () => {
  it("reaches zero only when every line is confirmed", () => {
    const ls = [line(0, "10", "10", 0, "accepted"), line(1, "1", "5.5", 0, "pending")];
    const totals = { otherChargesPaise: 0, discountPaise: 0, roundOffPaise: 50 };
    const locked = 10_000 + 550 + 50;
    expect(verificationBalance(locked, ls, totals)).toMatchObject({ remainingPaise: 550, pendingCount: 1, balanced: false });
    ls[1]!.status = "accepted";
    expect(verificationBalance(locked, ls, totals)).toMatchObject({ remainingPaise: 0, balanced: true });
  });
  it("suggests a missing or duplicated line", () => {
    const ls = [line(0, "10", "10", 0, "accepted"), line(1, "10", "10", 0, "accepted")];
    expect(balanceHints(-10_000, ls).map((h) => h.kind)).toContain("duplicate_line");
    expect(balanceHints(700, ls)[0]?.kind).toBe("missing_line");
  });
});

describe("qr", () => {
  it("parses an e-invoice JWT", () => {
    const data = { SellerGstin: SELLER, BuyerGstin: BUYER, DocNo: "INV-1", DocTyp: "INV", DocDt: "20/10/2026", TotInvVal: 1234.5, ItemCnt: 2, MainHsnCode: "2103", Irn: "abc", IrnDt: "2026-10-20 10:00:00" };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "RS256" })}.${b64({ data: JSON.stringify(data) })}.sig`;
    const q = classifyQr(jwt);
    expect(q.kind).toBe("einvoice");
    if (q.kind === "einvoice") expect(q.data).toMatchObject({ docDate: "2026-10-20", totalPaise: 123450, itemCount: 2 });
  });
  it("treats UPI QR as a hint only", () => {
    expect(classifyQr("upi://pay?pa=shop@okhdfc&pn=Shop").kind).toBe("upi");
    expect(classifyQr("hello").kind).toBe("other");
  });
});

it("financial year", () => {
  expect(financialYear("2026-10-22")).toBe("2026-27");
  expect(financialYear("2027-03-31")).toBe("2026-27");
});
