import { describe, expect, it } from "vitest";
import { align, descSimilarity, isNonItemRow, normaliseDate, normaliseDocType, normaliseGstin, normaliseHsn, normaliseInvoiceNo, normaliseRaw, normaliseUnit, parseNum } from "../src/index.js";
import { SELLER } from "./helpers.js";

describe("normalise", () => {
  it("GSTIN: uppercase, no spaces", () => {
    expect(normaliseGstin(` ${SELLER.slice(0, 5).toLowerCase()} ${SELLER.slice(5)} `).value).toBe(SELLER);
  });

  it("GSTIN: fixes O/0-style confusions only when the checksum confirms", () => {
    // SELLER = 20AABCS1234F1Z5; read "2O AABCS I234 F1Z5"
    const misread = "2OAABCSI234F1Z5";
    const r = normaliseGstin(misread);
    expect(r.value).toBe(SELLER);
    expect(r.corrected).toBe(true);
    // A substitution that does not pass the checksum is left as read.
    expect(normaliseGstin("2OAABCSI234F1Z6").value).toBe("2OAABCSI234F1Z6");
    expect(normaliseGstin("2OAABCSI234F1Z6").corrected).toBeUndefined();
  });

  it("invoice number trimmed, label removed", () => {
    expect(normaliseInvoiceNo("  Invoice No.:  RD/2026-27/ 1043 ")).toBe("RD/2026-27/ 1043");
    expect(normaliseInvoiceNo("# A-17")).toBe("A-17");
    expect(normaliseInvoiceNo("GST/1043")).toBe("GST/1043");
  });

  it("dates to YYYY-MM-DD, day first", () => {
    expect(normaliseDate("05/04/2026")).toBe("2026-04-05");
    expect(normaliseDate("5-4-26")).toBe("2026-04-05");
    expect(normaliseDate("22-Oct-2026")).toBe("2026-10-22");
    expect(normaliseDate("22 Sept 2026")).toBe("2026-09-22");
    expect(normaliseDate("2026-10-22")).toBe("2026-10-22");
    expect(normaliseDate("31/02/2026")).toBeUndefined();
    expect(normaliseDate("yesterday")).toBeUndefined();
  });

  it("HSN digits only; units short uppercase", () => {
    expect(normaliseHsn("3402 20 90")).toBe("34022090");
    expect(normaliseHsn("HSN: —")).toBeUndefined();
    expect(normaliseUnit("Kgs.")).toBe("KG");
    expect(normaliseUnit("pcs")).toBe("PCS");
    expect(normaliseUnit("Nos")).toBe("NOS");
    expect(normaliseUnit("Ltr")).toBe("L");
    expect(normaliseUnit("किलो")).toBe("KG");
    expect(normaliseUnit("Pouch")).toBe("POUCH");
  });

  it("doc type from printed title", () => {
    expect(normaliseDocType("Tax Invoice")).toBe("INV");
    expect(normaliseDocType("CREDIT NOTE")).toBe("CRN");
    expect(normaliseDocType("Debit Note")).toBe("DBN");
    expect(normaliseDocType("कर बीजक")).toBe("INV");
  });

  it("numbers from printed text", () => {
    expect(parseNum("1,23,456.70")).toBe(123456.7);
    expect(parseNum("(12.50)")).toBe(-12.5);
    expect(parseNum("Rs. 99")).toBe(99);
    expect(parseNum("-0.40")).toBe(-0.4);
    expect(parseNum("—")).toBeUndefined();
    expect(parseNum("12 kg")).toBeUndefined();
  });

  it("non-item rows", () => {
    expect(isNonItemRow({ description: "B/F" })).toBe(true);
    expect(isNonItemRow({ description: "Brought Forward", qty: 0 })).toBe(true);
    expect(isNonItemRow({ description: "Sub Total" })).toBe(true);
    expect(isNonItemRow({ description: "कुल योग" })).toBe(true);
    expect(isNonItemRow({ description: "Total Wash 1L", qty: 2, rate: 99 })).toBe(false);
    expect(isNonItemRow({ description: "Tata Salt" })).toBe(false);
  });

  it("normaliseRaw keeps unreadable values out instead of guessing", () => {
    const { raw, notes } = normaliseRaw({ header: { invoiceDate: "3?/10/2026", sellerGstin: null }, totals: { grandTotal: "illegible" }, lines: [] } as never);
    expect(raw.header.invoiceDate).toBeUndefined();
    expect(raw.header.sellerGstin).toBeUndefined();
    expect(raw.totals.grandTotal).toBeUndefined();
    expect(notes.join(" ")).toMatch(/invoiceDate/);
  });

  it("boxes in per-mille are scaled to 0..1 and clamped", () => {
    const { raw } = normaliseRaw({ header: {}, totals: {}, lines: [{ description: "X", qty: 1, rate: 1, amount: 1, box: { page: 0, x: 100, y: 200, w: 800, h: 30 } }] } as never);
    expect(raw.lines[0]!.box).toEqual({ page: 0, x: 0.1, y: 0.2, w: 0.8, h: 0.03 });
  });
});

describe("similarity and alignment", () => {
  it("description similarity", () => {
    expect(descSimilarity("Tata Salt 1kg", "TATA SALT 1 KG")).toBeGreaterThan(0.8);
    expect(descSimilarity("Tata Salt 1kg", "Parle-G 800g")).toBeLessThan(0.3);
  });

  it("order-preserving alignment with gaps", () => {
    const a = ["salt", "sugar", "oil", "tea"];
    const b = ["salt", "oil", "tea", "soap"];
    const pairs = align(a, b, (x, y) => (x === y ? 1 : 0), 0.5);
    expect(pairs).toEqual([{ a: 0, b: 0, score: 1 }, { a: 1 }, { a: 2, b: 1, score: 1 }, { a: 3, b: 2, score: 1 }, { b: 3 }]);
  });
});
