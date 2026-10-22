import { describe, expect, it } from "vitest";
import { isValidGstin, parseEInvoiceQr, runChecks, type InvoiceLine } from "@arad/core";
import { LAYOUTS, Rng, amountInWords, makeInvoice, renderHtml, truthOf } from "../src/index.js";

describe("synthetic invoice ground truth", () => {
  it("passes every deterministic check for all layouts over many seeds", () => {
    for (const layout of LAYOUTS) {
      for (let i = 0; i < 40; i++) {
        const inv = makeInvoice({ seed: 1, index: i, layout });
        const t = truthOf(inv, [], []);
        const lines = t.expected.lines.map((l) => ({ ...l, id: `l${l.idx}` }) as InvoiceLine);
        const qr = t.qr ? parseEInvoiceQr(t.qr.raw) : undefined;
        const fails = runChecks({ header: t.expected.header, totals: t.expected.totals, lines, qr }, { today: inv.generatedOn }).filter((c) => c.status === "fail");
        expect(fails, `${t.id}`).toEqual([]);
        expect(isValidGstin(t.expected.header.sellerGstin)).toBe(true);
      }
    }
  });

  it("e-invoice QR is a JWT with the official field names that core can parse", () => {
    let found = 0;
    for (let i = 0; i < 30 && found < 3; i++) {
      const inv = makeInvoice({ seed: 3, index: i, layout: "a4-table" });
      if (!inv.qr) continue;
      found++;
      const q = parseEInvoiceQr(inv.qr.jwt)!;
      expect(q.sellerGstin).toBe(inv.header.sellerGstin);
      expect(q.docNo).toBe(inv.header.invoiceNo);
      expect(q.docDate).toBe(inv.header.invoiceDate);
      expect(q.totalPaise).toBe(inv.totals.grandTotalPaise);
      expect(q.itemCount).toBe(inv.lines.length);
      expect(q.irn).toBe(inv.header.irn);
      const payload = JSON.parse(Buffer.from(inv.qr.jwt.split(".")[1]!, "base64url").toString());
      expect(Object.keys(JSON.parse(payload.data))).toEqual(["SellerGstin", "BuyerGstin", "DocNo", "DocTyp", "DocDt", "TotInvVal", "ItemCnt", "MainHsnCode", "Irn", "IrnDt"]);
    }
    expect(found).toBeGreaterThan(0);
  });

  it("is reproducible for a seed", () => {
    const a = makeInvoice({ seed: 42, index: 3 });
    const b = makeInvoice({ seed: 42, index: 3 });
    expect({ ...a, qr: undefined }).toEqual({ ...b, qr: undefined });
  });

  it("covers the GST slabs and both tax types", () => {
    const rates = new Set<number>();
    const types = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const inv = makeInvoice({ seed: 9, index: i });
      types.add(inv.taxType);
      for (const l of inv.lines) rates.add(l.gstRateBp);
    }
    for (const bp of [0, 500, 1800, 4000]) expect(rates.has(bp)).toBe(true);
    expect([...rates].some((bp) => bp === 1200 || bp === 2800)).toBe(true);
    expect(types).toEqual(new Set(["CGST_SGST", "IGST"]));
  });

  it("multi-page invoices carry B/F and C/F rows", () => {
    const inv = makeInvoice({ seed: 5, index: 0, layout: "a4-table", multiPage: true });
    const html = renderHtml(inv, new Rng(1));
    expect(html.pages).toHaveLength(2);
    expect(html.pages[0]).toMatch(/C\/F/);
    expect(html.pages[1]).toMatch(/B\/F/);
  });

  it("amount in words, Indian numbering", () => {
    expect(amountInWords(308_000)).toBe("Rupees Three Thousand Eighty Only");
    expect(amountInWords(1_23_45_678_50)).toBe("Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only");
  });
});
