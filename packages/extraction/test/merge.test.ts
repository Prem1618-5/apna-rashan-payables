import { describe, expect, it } from "vitest";
import { computeLine, runChecks, toMilli, toPaise, type EInvoiceQr, type InvoiceLine } from "@arad/core";
import { decideIncludesTax, mergeDrafts, normaliseRaw, toDraft, type MergedDraft } from "../src/index.js";
import { BUYER, OTHER_STATE_BUYER, SELLER, STD_LINES, TODAY, clone, gstin, invoice, printedLine } from "./helpers.js";

const opts = { checkConfig: { today: TODAY }, independent: true };
const merge = (a: Parameters<typeof toDraft>[2], b?: Parameters<typeof toDraft>[2], o: Parameters<typeof mergeDrafts>[1] = opts) =>
  mergeDrafts(b ? [toDraft("A", "va", a), toDraft("B", "vb", b)] : [toDraft("A", "va", a)], o);

const flaggedFields = (d: MergedDraft) => {
  const out: string[] = [];
  for (const [k, m] of Object.entries(d.headerMeta)) if (m?.flagged) out.push(`header.${k}`);
  for (const [k, m] of Object.entries(d.totalsMeta)) if (m?.flagged) out.push(`totals.${k}`);
  d.lines.forEach((l, i) => {
    for (const [k, m] of Object.entries(l.meta ?? {})) if (m?.flagged) out.push(`line${i}.${k}`);
  });
  return out;
};

const checksOf = (d: MergedDraft, qr?: EInvoiceQr) =>
  runChecks({ header: d.header, totals: d.totals, lines: d.lines.map((l) => ({ ...l, id: `l${l.idx}` }) as InvoiceLine), qr }, { today: TODAY }).filter((c) => c.status === "fail");

describe("merger: agreement", () => {
  it("two identical readings -> no flags, high confidence, paise values, checks pass", () => {
    const raw = invoice(STD_LINES());
    const d = merge(raw, clone(raw));
    expect(flaggedFields(d)).toEqual([]);
    expect(d.header.sellerGstin).toBe(SELLER);
    expect(d.headerMeta.sellerGstin!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(d.lines).toHaveLength(4);
    const l0 = d.lines[0]!;
    expect(l0.qtyMilli).toBe(50_000);
    expect(l0.ratePaise).toBe(2667);
    expect(l0.gstRateBp).toBe(500);
    expect(l0.taxablePaise).toBe(133_350);
    expect(l0.taxPaise).toBe(6668);
    expect(l0.totalPaise).toBe(140_018);
    expect(l0.status).toBe("pending");
    expect(l0.meta!.totalPaise!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(checksOf(d)).toEqual([]);
    expect(d.totals.grandTotalPaise).toBe(toPaise(raw.totals.grandTotal!));
  });

  it("same-vendor readers agreeing get a slightly lower confidence", () => {
    const raw = invoice(STD_LINES());
    const d = merge(raw, clone(raw), { ...opts, independent: false });
    expect(d.headerMeta.invoiceNo!.confidence).toBeCloseTo(0.9);
    expect(flaggedFields(d)).toEqual([]);
  });

  it("invoice number spacing/case and vendor 'Pvt. Ltd.' variants count as agreement", () => {
    const a = invoice(STD_LINES(), { header: { invoiceNo: "sgd/26-27/0412", vendorName: "Shree Ganesh Distributors Pvt. Ltd." } });
    const b = invoice(STD_LINES(), { header: { invoiceNo: "SGD/26-27/ 0412", vendorName: "SHREE GANESH DISTRIBUTORS PVT LTD" } });
    const d = merge(a, b);
    expect(d.headerMeta.invoiceNo!.flagged).toBeFalsy();
    expect(d.headerMeta.vendorName!.flagged).toBeFalsy();
  });

  it("a single reader is never above 0.79", () => {
    const d = merge(invoice(STD_LINES()));
    expect(d.headerMeta.invoiceNo!.confidence).toBeLessThanOrEqual(0.79);
    expect(d.lines[0]!.meta!.totalPaise!.confidence).toBeLessThanOrEqual(0.79);
  });
});

describe("merger: header disagreements", () => {
  it("GSTIN: the value that passes the checksum wins and both readings are kept as sources", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    const bad = SELLER.slice(0, 7) + "8" + SELLER.slice(8); // one digit misread -> checksum fails
    a.header.sellerGstin = bad;
    a.confidence!.sellerGstin = 0.99;
    const d = merge(a, b);
    expect(d.header.sellerGstin).toBe(SELLER);
    const m = d.headerMeta.sellerGstin!;
    expect(m.flagged).toBe(true);
    expect(m.sources).toEqual({ A: bad, B: SELLER });
    expect(m.reason).toMatch(/checksum/);
  });

  it("QR-consistent value beats higher confidence", () => {
    const a = invoice(STD_LINES(), { header: { invoiceNo: "SGD/26-27/0412" } });
    const b = invoice(STD_LINES(), { header: { invoiceNo: "SGD/26-27/0472" } });
    a.confidence!.invoiceNo = 0.6;
    b.confidence!.invoiceNo = 0.99;
    const qr: EInvoiceQr = { sellerGstin: SELLER, buyerGstin: BUYER, docNo: "SGD/26-27/0412", docType: "INV", docDate: "2026-10-20", totalPaise: toPaise(a.totals.grandTotal!), itemCount: 4, irn: "a".repeat(64) };
    const d = merge(a, b, { ...opts, qr });
    expect(d.header.invoiceNo).toBe("SGD/26-27/0412");
    expect(d.headerMeta.invoiceNo!.flagged).toBe(true);
    expect(d.headerMeta.invoiceNo!.reason).toMatch(/QR/);
    expect(d.headerMeta.invoiceNo!.sources).toMatchObject({ A: "SGD/26-27/0412", B: "SGD/26-27/0472", qr: "SGD/26-27/0412" });
  });

  it("without other evidence the higher-confidence reading wins, flagged", () => {
    const a = invoice(STD_LINES(), { header: { invoiceDate: "2026-10-20" } });
    const b = invoice(STD_LINES(), { header: { invoiceDate: "2026-10-28" } });
    a.confidence!.invoiceDate = 0.7;
    b.confidence!.invoiceDate = 0.95;
    const d = merge(a, b);
    // 2026-10-28 is after "today" (2026-10-22): the plausible date wins despite lower confidence.
    expect(d.header.invoiceDate).toBe("2026-10-20");
    expect(d.headerMeta.invoiceDate!.flagged).toBe(true);
  });

  it("one reader missing a header field -> taken from the other, flagged", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    delete b.header.buyerGstin;
    const d = merge(a, b);
    expect(d.header.buyerGstin).toBe(BUYER);
    expect(d.headerMeta.buyerGstin!.flagged).toBe(true);
    expect(d.headerMeta.buyerGstin!.reason).toMatch(/not found by B/);
  });

  it("readers agree but the QR differs -> QR value, flagged", () => {
    const a = invoice(STD_LINES());
    const qr: EInvoiceQr = { sellerGstin: SELLER, buyerGstin: BUYER, docNo: "SGD/26-27/0413", docType: "INV", docDate: "2026-10-20", totalPaise: toPaise(a.totals.grandTotal!), itemCount: 4, irn: "b".repeat(64) };
    const d = merge(a, clone(a), { ...opts, qr });
    expect(d.header.invoiceNo).toBe("SGD/26-27/0413");
    expect(d.headerMeta.invoiceNo!.flagged).toBe(true);
    expect(d.header.irn).toBe("b".repeat(64));
  });
});

describe("merger: lines", () => {
  it("aligns lines when one reader missed a line, and flags the extra line", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    b.lines.splice(1, 1); // B skipped Surf Excel
    const d = merge(a, b);
    expect(d.lines.map((l) => l.description)).toEqual(["Tata Salt 1kg", "Surf Excel Easy Wash 1kg", "Fortune Soyabean Oil 1L", "Parle-G 800g"]);
    expect(d.lines[1]!.meta!.description!.flagged).toBe(true);
    expect(d.lines[1]!.meta!.description!.reason).toMatch(/only A found this line/);
    expect(d.lines[1]!.meta!.totalPaise!.confidence).toBeLessThan(0.6);
    // The neighbours were matched correctly (not shifted) and stay clean.
    for (const i of [0, 2, 3]) expect(d.lines[i]!.meta!.totalPaise!.flagged).toBeFalsy();
    expect(d.lines.map((l) => l.idx)).toEqual([0, 1, 2, 3]);
  });

  it("aligns a line that only the second reader found", () => {
    const b = invoice(STD_LINES());
    const a = clone(b);
    a.lines.splice(3, 1);
    const d = merge(a, b);
    expect(d.lines).toHaveLength(4);
    expect(d.lines[3]!.description).toBe("Parle-G 800g");
    expect(d.lines[3]!.meta!.totalPaise!.reason).toMatch(/only B found this line/);
  });

  it("matches lines whose names were read in different scripts when the numbers agree", () => {
    const a = invoice([printedLine("चीनी 1 किलो", 20, 42, 5), printedLine("Tata Salt 1kg", 10, 26.67, 5)]);
    const b = clone(a);
    b.lines[0]!.description = "Cheeni 1 kilo";
    const d = merge(a, b);
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0]!.meta!.description!.flagged).toBe(true);
    expect(d.lines[0]!.meta!.description!.sources).toEqual({ A: "चीनी 1 किलो", B: "Cheeni 1 kilo" });
    expect(d.lines[0]!.meta!.qtyMilli!.flagged).toBeFalsy();
  });

  it("a numeric disagreement is flagged with sources; the value that makes the line add up is chosen", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    b.lines[2]!.qty = 1; // misread 10 as 1; amount still 1381.00
    b.lines[2]!.confidence = 0.99;
    const d = merge(a, b);
    const l = d.lines[2]!;
    expect(l.qtyMilli).toBe(10_000);
    expect(l.meta!.qtyMilli!.flagged).toBe(true);
    expect(l.meta!.qtyMilli!.sources).toEqual({ A: "10000", B: "1000" });
    expect(l.meta!.qtyMilli!.reason).toMatch(/add up/);
    expect(checksOf(d)).toEqual([]);
  });

  it("disagreeing amount: picks the reading consistent with qty × rate", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    a.lines[1]!.amount = 1428.68; // A misread a digit
    const d = merge(a, b);
    expect(d.lines[1]!.taxablePaise).toBe(142_368);
    expect(d.lines[1]!.meta!.taxablePaise!.flagged).toBe(true);
  });

  it("both readers agree on a line that does not add up -> checks push confidence below 0.6", () => {
    const a = invoice(STD_LINES());
    a.lines[0]!.amount = 1383.5; // printed wrong (or both misread)
    const d = merge(a, clone(a));
    const m = d.lines[0]!.meta!;
    expect(m.totalPaise!.confidence).toBeLessThan(0.6);
    expect(m.totalPaise!.flagged).toBe(true);
    expect(m.totalPaise!.reason).toMatch(/check/);
    expect(d.totalsMeta.taxablePaise!.confidence).toBeLessThan(0.6);
  });

  it("drops brought-forward / sub-total rows of continued tables", () => {
    const a = invoice(STD_LINES());
    a.lines.splice(2, 0, { description: "B/F", qty: NaN, rate: NaN, amount: 2757.18 } as never, { description: "Sub Total", amount: 2757.18 } as never);
    const d = merge(a, invoice(STD_LINES()));
    expect(d.lines).toHaveLength(4);
    expect(flaggedFields(d)).toEqual([]);
  });

  it("extra disagreement on HSN and unit is flagged", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    b.lines[0]!.hsn = "2502";
    b.lines[0]!.unit = "KG";
    const d = merge(a, b);
    expect(d.lines[0]!.meta!.hsn!.flagged).toBe(true);
    expect(d.lines[0]!.meta!.unit!.flagged).toBe(true);
  });
});

describe("merger: totals", () => {
  it("grand total disagreement: the one matching the lines wins", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    b.totals.grandTotal = a.totals.grandTotal! + 90; // 9 read as 0 somewhere
    b.confidence!["totals.grandTotal"] = 0.99;
    const d = merge(a, b);
    expect(d.totals.grandTotalPaise).toBe(toPaise(a.totals.grandTotal!));
    expect(d.totalsMeta.grandTotalPaise!.flagged).toBe(true);
    expect(d.totalsMeta.grandTotalPaise!.reason).toMatch(/lines add up/);
  });

  it("QR total beats both readers", () => {
    const a = invoice(STD_LINES());
    const b = clone(a);
    b.totals.grandTotal = a.totals.grandTotal! + 1;
    const qr: EInvoiceQr = { sellerGstin: SELLER, buyerGstin: BUYER, docNo: a.header.invoiceNo!, docType: "INV", docDate: a.header.invoiceDate!, totalPaise: toPaise(a.totals.grandTotal!), itemCount: 4, irn: "c".repeat(64) };
    const d = merge(a, b, { ...opts, qr });
    expect(d.totals.grandTotalPaise).toBe(qr.totalPaise);
    expect(d.totalsMeta.grandTotalPaise!.reason).toMatch(/QR/);
  });

  it("missing other charges / discount mean zero; tax not printed for IGST is zero", () => {
    const a = invoice(STD_LINES(), { header: { buyerGstin: OTHER_STATE_BUYER } });
    a.totals.igst = (a.totals.cgst ?? 0) + (a.totals.sgst ?? 0);
    delete a.totals.cgst;
    delete a.totals.sgst;
    const d = merge(a, clone(a));
    expect(d.totals.cgstPaise).toBe(0);
    expect(d.totals.igstPaise).toBe(toPaise(a.totals.igst));
    expect(d.totals.otherChargesPaise).toBe(0);
    expect(checksOf(d)).toEqual([]);
  });

  it("freight is kept as other charges", () => {
    const a = invoice(STD_LINES(), { otherCharges: 150 });
    const d = merge(a, clone(a));
    expect(d.totals.otherChargesPaise).toBe(15_000);
    expect(checksOf(d)).toEqual([]);
  });

  it("round-off not printed: computed from the gap, flagged", () => {
    const a = invoice(STD_LINES());
    delete a.totals.roundOff;
    const d = merge(a, clone(a));
    expect(Math.abs(d.totals.roundOffPaise)).toBeLessThan(100);
    expect(d.totalsMeta.roundOffPaise!.flagged).toBe(true);
    expect(checksOf(d)).toEqual([]);
  });

  it("grand total not found by anyone: computed but very low confidence", () => {
    const a = invoice(STD_LINES());
    delete a.totals.grandTotal;
    const d = merge(a, clone(a));
    expect(d.totalsMeta.grandTotalPaise!.confidence).toBeLessThan(0.3);
    expect(d.totalsMeta.grandTotalPaise!.flagged).toBe(true);
  });
});

describe("paise conversion and tax basis", () => {
  it("converts rupees, decimal qty and GST % exactly", () => {
    const raw = invoice([printedLine("Basmati Rice", 2.5, 96.4, 5), printedLine("Ghee", 1, 0.1 + 0.2, 12)]);
    const d = toDraft("A", "v", raw);
    expect(d.lines[0]!.qtyMilli).toBe(2500);
    expect(d.lines[0]!.ratePaise).toBe(9640);
    expect(d.lines[0]!.gstRateBp).toBe(500);
    expect(d.lines[0]!.taxablePaise).toBe(24_100);
    expect(d.lines[1]!.ratePaise).toBe(30);
    expect(d.lines[1]!.gstRateBp).toBe(1200);
  });

  it("parses printed text numbers", () => {
    const raw = { header: {}, totals: { grandTotal: "1,23,456.50" }, lines: [{ description: "X", qty: "2.000", rate: "₹ 1,000.00", amount: "2,000.00", gstRate: "18%" }] };
    const { raw: n } = normaliseRaw(raw as never);
    expect(n.totals.grandTotal).toBe(123456.5);
    expect(n.lines[0]!.rate).toBe(1000);
    expect(n.lines[0]!.qty).toBe(2);
  });

  it("amounts before tax: tax and total are computed with the shared maths", () => {
    const raw = invoice([printedLine("Surf", 12, 118.64, 18)]);
    const d = toDraft("A", "v", raw);
    const c = computeLine({ qtyMilli: 12_000, ratePaise: 11_864, discountPaise: 0, gstRateBp: 1800 });
    expect(d.amountIncludesTax).toBe(false);
    expect(d.lines[0]!.taxPaise).toBe(c.taxPaise);
    expect(d.lines[0]!.totalPaise).toBe(c.totalPaise);
  });

  it("amounts including tax: printed amount is kept as the line total", () => {
    const lines = [printedLine("Surf", 12, 118.64, 18), printedLine("Salt", 50, 26.67, 5)];
    const raw = invoice(lines);
    for (const l of raw.lines) {
      const c = computeLine({ qtyMilli: toMilli(l.qty), ratePaise: toPaise(l.rate), discountPaise: 0, gstRateBp: l.gstRate! * 100 });
      l.amount = c.totalPaise / 100;
    }
    raw.amountIncludesTax = undefined; // reader did not say; totals decide
    const d = toDraft("A", "v", raw);
    expect(d.amountIncludesTax).toBe(true);
    expect(d.lines[0]!.totalPaise).toBe(toPaise(raw.lines[0]!.amount));
    expect(d.lines[0]!.taxablePaise).toBe(142_368);
  });

  it("overrides the reader's tax-basis answer when the totals clearly say otherwise", () => {
    const raw = invoice(STD_LINES());
    raw.amountIncludesTax = true; // wrong: amounts add up to the taxable value
    const n = normaliseRaw(raw).raw;
    expect(decideIncludesTax(n).amountIncludesTax).toBe(false);
  });

  it("retail bill with tax-inclusive rates: rate converted to before-tax, line still adds up", () => {
    // MRP-style: qty × rate = amount incl. 18% GST.
    const raw = {
      header: { sellerGstin: SELLER, buyerGstin: BUYER, invoiceNo: "T-99", invoiceDate: "2026-10-21" },
      lines: [
        { description: "Colgate 200g", qty: 2, rate: 118, gstRate: 18, amount: 236, rateIncludesTax: true },
        { description: "Lux Soap", qty: 3, rate: 42, gstRate: 18, amount: 126, rateIncludesTax: true },
      ],
      totals: { taxable: 306.78, cgst: 27.61, sgst: 27.61, grandTotal: 362 },
    };
    const d = toDraft("A", "v", raw as never);
    expect(d.amountIncludesTax).toBe(true);
    expect(d.rateIncludesTax).toBe(true);
    expect(d.lines[0]!.totalPaise).toBe(23_600);
    expect(d.lines[0]!.taxablePaise).toBe(20_000);
    expect(d.lines[0]!.ratePaise).toBe(10_000);
    const m = mergeDrafts([d, toDraft("B", "w", raw as never)], opts);
    expect(checksOf(m).map((c) => c.id)).toEqual([]);
  });

  it("derives the GST rate from printed taxable and tax when the % column is missing", () => {
    const raw = invoice([printedLine("Atta 10kg", 2, 380, 5)]);
    delete raw.lines[0]!.gstRate;
    raw.lines[0]!.taxable = 760;
    raw.lines[0]!.tax = 38;
    const d = toDraft("A", "v", raw);
    expect(d.lines[0]!.gstRateBp).toBe(500);
    expect(d.lines[0]!.derived.has("gstRateBp")).toBe(true);
  });

  it("discount percent becomes a discount amount", () => {
    const raw = invoice([printedLine("Oil", 10, 100, 5, { discount: 50 })]);
    const pct = clone(raw);
    delete pct.lines[0]!.discount;
    (pct.lines[0] as unknown as Record<string, unknown>).discountPercent = 5;
    const d = toDraft("A", "v", pct);
    expect(d.lines[0]!.discountPaise).toBe(5000);
    expect(d.lines[0]!.taxablePaise).toBe(95_000);
  });
});

describe("merger: empty and edge cases", () => {
  it("no readers -> empty draft", () => {
    const d = mergeDrafts([], opts);
    expect(d.lines).toEqual([]);
    expect(d.header).toEqual({});
    expect(d.totals.grandTotalPaise).toBe(0);
  });

  it("no readers but a QR -> header and total from the QR", () => {
    const qr: EInvoiceQr = { sellerGstin: SELLER, buyerGstin: BUYER, docNo: "X/1", docType: "INV", docDate: "2026-10-01", totalPaise: 123_400, itemCount: 2, irn: "d".repeat(64) };
    const d = mergeDrafts([], { ...opts, qr });
    expect(d.header.invoiceNo).toBe("X/1");
    expect(d.totals.grandTotalPaise).toBe(123_400);
  });

  it("invalid GSTIN that both readers agree on still gets low confidence via checks", () => {
    const a = invoice(STD_LINES(), { header: { sellerGstin: gstin("20AABCS1234F1Z").slice(0, 14) + "Q" } });
    const d = merge(a, clone(a));
    expect(d.headerMeta.sellerGstin!.confidence).toBeLessThan(0.6);
    expect(d.headerMeta.sellerGstin!.flagged).toBe(true);
  });
});
