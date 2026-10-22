import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_RAW, TextractProvider, mapTextractExpense, mergeDrafts, toDraft } from "../src/index.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/textract-analyze-expense.json", import.meta.url), "utf8"));

describe("Textract AnalyzeExpense mapping", () => {
  it("maps summary fields and line items to RawExtraction", () => {
    const raw = mapTextractExpense([fixture]);
    expect(raw.header).toEqual({
      vendorName: "SHREE GANESH DISTRIBUTORS",
      sellerGstin: "20AABCS1234F1Z5",
      buyerGstin: "20AAACA9999K1Z9",
      invoiceNo: "SGD/26-27/0412",
      invoiceDate: "20/10/2026",
    });
    expect(raw.totals).toEqual({ taxable: 2757.18, cgst: 161.47, sgst: 161.47, roundOff: -0.12, grandTotal: 3080 });
    expect(raw.lines).toHaveLength(2);
    expect(raw.lines[0]).toMatchObject({ description: "Tata Salt 1kg", hsn: "25010020", qty: 50, unit: "PKT", rate: 26.67, gstRate: 5, amount: 1333.5 });
    expect(raw.lines[0]!.box).toEqual({ page: 0, x: 0.06, y: 0.38, w: 0.88, h: 0.03 });
    expect(raw.lines[1]).toMatchObject({ hsn: "34022090", qty: 12, gstRate: 18, amount: 1423.68 });
    expect(raw.confidence!.invoiceNo).toBeCloseTo(0.985);
    expect(raw.confidence!["totals.grandTotal"]).toBeCloseTo(0.988);
  });

  it("merges cleanly with an agreeing Gemini-style reading (different vendors)", () => {
    const t = toDraft("textract", "aws", mapTextractExpense([fixture]));
    const g = toDraft("gemini", "google", DEMO_RAW);
    const d = mergeDrafts([t, g], { independent: true, checkConfig: { today: "2026-10-22" } });
    const flagged = [...Object.values(d.headerMeta), ...Object.values(d.totalsMeta), ...d.lines.flatMap((l) => Object.values(l.meta ?? {}))].filter((m) => m?.flagged);
    expect(flagged).toEqual([]);
    expect(d.header.invoiceDate).toBe("2026-10-20");
    expect(d.totals.grandTotalPaise).toBe(308_000);
  });

  it("is off unless TEXTRACT_ENABLED and never trains on input", async () => {
    expect(new TextractProvider({ enabled: false }).available()).toBe(false);
    const p = new TextractProvider({ enabled: true, client: { send: async () => fixture } as never });
    expect(p.info.trainsOnInput).toBe(false);
    const r = await p.extract([{ mime: "image/jpeg", data: new Uint8Array([1]) }]);
    expect(r.raw.lines).toHaveLength(2);
  });

  it("maps AWS errors to provider error kinds", async () => {
    const p = new TextractProvider({ enabled: true, client: { send: async () => { throw Object.assign(new Error("slow down"), { name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }); } } as never });
    await expect(p.extract([{ mime: "image/png", data: new Uint8Array([1]) }])).rejects.toMatchObject({ kind: "rate_limited" });
  });
});
