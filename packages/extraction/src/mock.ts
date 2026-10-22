/** Deterministic provider for tests and demos (EXTRACTOR=mock). Never touches the network. */

import type { PageImage, ProviderInfo, RawExtraction } from "@arad/core";
import { ProviderError, type Provider, type ProviderResult } from "./types.js";

export type MockFixture = RawExtraction | ((pages: PageImage[]) => RawExtraction);

export interface MockOptions {
  id?: string;
  vendor?: string;
  trainsOnInput?: boolean;
  /** Throw this instead of answering (to test failover). */
  fail?: ProviderError | (() => ProviderError | undefined);
  delayMs?: number;
  available?: boolean;
}

export class MockProvider implements Provider {
  readonly id: string;
  readonly vendor: string;
  readonly info: ProviderInfo;
  calls = 0;

  constructor(
    private readonly fixture: MockFixture,
    private readonly opts: MockOptions = {},
  ) {
    this.id = opts.id ?? "mock";
    this.vendor = opts.vendor ?? this.id;
    this.info = { id: this.id, trainsOnInput: opts.trainsOnInput ?? false, model: "mock" };
  }

  available() {
    return this.opts.available ?? true;
  }

  keyCount() {
    return 0;
  }

  async extract(pages: PageImage[], signal?: AbortSignal): Promise<ProviderResult> {
    this.calls++;
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (signal?.aborted) throw new ProviderError("aborted by caller", "aborted");
    const f = typeof this.opts.fail === "function" ? this.opts.fail() : this.opts.fail;
    if (f) throw f;
    const raw = typeof this.fixture === "function" ? this.fixture(pages) : this.fixture;
    return { raw: structuredClone(raw), model: "mock" };
  }
}

/** A small, valid demo invoice (same-state CGST+SGST, two lines, round-off), used by EXTRACTOR=mock. */
export const DEMO_RAW: RawExtraction = {
  header: {
    vendorName: "Shree Ganesh Distributors",
    sellerGstin: "20AABCS1234F1Z5",
    buyerGstin: "20AAACA9999K1Z9",
    invoiceNo: "SGD/26-27/0412",
    invoiceDate: "2026-10-20",
    docType: "INV",
  },
  lines: [
    { description: "Tata Salt 1kg", hsn: "25010020", qty: 50, unit: "PKT", rate: 26.67, gstRate: 5, amount: 1333.5, confidence: 0.96, box: { page: 0, x: 0.06, y: 0.38, w: 0.88, h: 0.03 } },
    { description: "Surf Excel Easy Wash 1kg", hsn: "34022090", qty: 12, unit: "PCS", rate: 118.64, gstRate: 18, amount: 1423.68, confidence: 0.93, box: { page: 0, x: 0.06, y: 0.41, w: 0.88, h: 0.03 } },
  ],
  amountIncludesTax: false,
  totals: { taxable: 2757.18, cgst: 161.47, sgst: 161.47, roundOff: -0.12, grandTotal: 3080 },
  confidence: { vendorName: 0.97, sellerGstin: 0.95, buyerGstin: 0.94, invoiceNo: 0.96, invoiceDate: 0.97, "totals.grandTotal": 0.98 },
};
