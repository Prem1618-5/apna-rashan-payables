/**
 * Simulated readers for offline evaluation of the merger (no network): each one reads the truth
 * with independent, OCR-like mistakes. Error rates are rough guesses, not measurements.
 */

import type { RawExtraction } from "@arad/core";
import { MockProvider, type Provider } from "@arad/extraction";
import type { TruthFile } from "./cases.js";

class Rng {
  constructor(private s: number) {}
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number) {
    return this.next() < p;
  }
  int(a: number, b: number) {
    return a + Math.floor(this.next() * (b - a + 1));
  }
}

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);

export interface SimRates {
  /** Per numeric field: one digit misread. */
  digit: number;
  /** Per line: the line is skipped. */
  dropLine: number;
  /** Per GSTIN / invoice number: one confusable character. */
  char: number;
  /** Per invoice: day and month swapped. */
  dateSwap: number;
  /** Per field: value not read (null). */
  missing: number;
}

export const DEFAULT_SIM: SimRates = { digit: 0.02, dropLine: 0.02, char: 0.04, dateSwap: 0.03, missing: 0.02 };

const CONFUSE: Record<string, string> = { "0": "O", O: "0", "1": "I", I: "1", "5": "S", S: "5", "8": "B", B: "8", "6": "G", Z: "2", "2": "Z" };

function misreadDigit(n: number, r: Rng): number {
  const s = n.toFixed(2);
  const idx = [...s].map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
  const i = idx[r.int(0, idx.length - 1)]!;
  const d = Number(s[i]);
  const nd = (d + r.int(1, 9)) % 10;
  return Number(s.slice(0, i) + nd + s.slice(i + 1));
}

function confuse(s: string, r: Rng): string {
  const idx = [...s].map((c, i) => (CONFUSE[c] ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return s;
  const i = idx[r.int(0, idx.length - 1)]!;
  return s.slice(0, i) + CONFUSE[s[i]!]! + s.slice(i + 1);
}

/** One simulated reading of the truth. */
export function simulateReading(truth: TruthFile, seed: number, rates: SimRates = DEFAULT_SIM): RawExtraction {
  if (!truth.raw) throw new Error("simulation needs truth.raw");
  const r = new Rng(seed);
  const raw = structuredClone(truth.raw);
  const num = (v: number | undefined) => (v === undefined ? v : r.chance(rates.missing) ? undefined : r.chance(rates.digit) ? misreadDigit(v, r) : v);
  const h = raw.header;
  if (h.sellerGstin && r.chance(rates.char)) h.sellerGstin = confuse(h.sellerGstin, r);
  if (h.buyerGstin && r.chance(rates.char)) h.buyerGstin = confuse(h.buyerGstin, r);
  if (h.invoiceNo && r.chance(rates.char)) h.invoiceNo = confuse(h.invoiceNo, r);
  if (h.invoiceDate && r.chance(rates.dateSwap)) {
    const [y, m, d] = h.invoiceDate.split("-");
    if (Number(d) <= 12) h.invoiceDate = `${y}-${d}-${m}`;
  }
  delete h.irn;
  const printedLineTax = truth.layout === "a4-table" || truth.layout === "igst";
  const inclRate = !!truth.printedRates && truth.layout === "thermal";
  raw.lines = raw.lines
    .map((l, i) => {
      const out = { ...l, qty: num(l.qty) ?? NaN, rate: num(inclRate ? truth.printedRates![i]! : l.rate) ?? NaN, amount: num(l.amount) ?? NaN, gstRate: r.chance(rates.missing) ? undefined : l.gstRate } as RawExtraction["lines"][number] & { rateIncludesTax?: boolean };
      if (inclRate) out.rateIncludesTax = true;
      if (printedLineTax) {
        out.taxable = num(l.taxable);
        out.tax = num(l.tax);
      } else {
        delete out.taxable;
        delete out.tax;
      }
      if (out.discount !== undefined) out.discount = num(out.discount);
      out.confidence = 0.85 + r.next() * 0.1;
      return out;
    })
    .filter(() => !r.chance(rates.dropLine));
  for (const k of Object.keys(raw.totals) as (keyof RawExtraction["totals"])[]) {
    const v = raw.totals[k];
    if (v === 0) delete raw.totals[k];
    else raw.totals[k] = num(v);
  }
  raw.confidence = { vendorName: 0.9, sellerGstin: 0.9, buyerGstin: 0.9, invoiceNo: 0.9, invoiceDate: 0.9, "totals.grandTotal": 0.9 };
  return raw;
}

/** Two independent simulated readers (different "vendors"). */
export function simProviders(truth: TruthFile, caseId: string, rates?: SimRates): Provider[] {
  return [
    new MockProvider(simulateReading(truth, hash(`${caseId}:a`), rates), { id: "sim-a", vendor: "sim-a" }),
    new MockProvider(simulateReading(truth, hash(`${caseId}:b`), rates), { id: "sim-b", vendor: "sim-b" }),
  ];
}
