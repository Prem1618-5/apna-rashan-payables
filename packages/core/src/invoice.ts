/** Invoice model shared by phone and server. All money in integer paise, quantity in thousandths, GST rate in basis points. */

import { gstinState, isValidGstin } from "./gstin.js";
import type { EInvoiceQr } from "./qr.js";

export type InvoiceState =
  | "CAPTURED"
  | "EXTRACTING"
  | "NEEDS_VERIFICATION"
  | "VERIFIED"
  | "IN_PAYMENT_RUN"
  | "PAID"
  | "ON_HOLD"
  | "DUPLICATE"
  | "REJECTED"
  | "EXTRACTION_FAILED";

export interface FieldMeta {
  /** 0..1. Below 0.8 the UI highlights the field. */
  confidence: number;
  /** True when extractors disagree or a check failed on this field. */
  flagged?: boolean;
  reason?: string;
  /** Value seen by each extractor, for showing disagreements. */
  sources?: Record<string, string>;
}

/** Normalised rectangle on a page image (0..1), used to crop a line for the verify card. */
export interface Box {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InvoiceHeader {
  vendorName?: string;
  sellerGstin?: string;
  buyerGstin?: string;
  invoiceNo?: string;
  /** YYYY-MM-DD */
  invoiceDate?: string;
  irn?: string;
  docType?: "INV" | "CRN" | "DBN";
}
export type HeaderField = keyof InvoiceHeader;

export interface InvoiceTotals {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** Freight, packing etc. Signed. */
  otherChargesPaise: number;
  /** Invoice-level discount (positive number reduces the total). */
  discountPaise: number;
  /** Signed, usually within ±100 paise. */
  roundOffPaise: number;
  grandTotalPaise: number;
}
export type TotalsField = keyof InvoiceTotals;

export type LineStatus = "pending" | "accepted" | "edited" | "removed";

export interface InvoiceLine {
  id: string;
  idx: number;
  description: string;
  hsn?: string;
  qtyMilli: number;
  unit?: string;
  mrpPaise?: number;
  /** Per unit, before tax. */
  ratePaise: number;
  /** Line discount amount. */
  discountPaise: number;
  gstRateBp: number;
  taxablePaise: number;
  taxPaise: number;
  /** Line amount including tax. */
  totalPaise: number;
  status: LineStatus;
  meta?: Partial<Record<LineField, FieldMeta>>;
  box?: Box;
}
export type LineField = "description" | "hsn" | "qtyMilli" | "unit" | "mrpPaise" | "ratePaise" | "discountPaise" | "gstRateBp" | "taxablePaise" | "taxPaise" | "totalPaise";

/** taxable = qty × rate − discount; tax = taxable × rate; total = taxable + tax. */
export function computeLine(l: Pick<InvoiceLine, "qtyMilli" | "ratePaise" | "discountPaise" | "gstRateBp">) {
  const gross = Math.round((l.qtyMilli * l.ratePaise) / 1000);
  const taxablePaise = gross - l.discountPaise;
  const taxPaise = Math.round((taxablePaise * l.gstRateBp) / 10000);
  return { taxablePaise, taxPaise, totalPaise: taxablePaise + taxPaise };
}

export type TaxType = "CGST_SGST" | "IGST";

/** Same state for seller and buyer = CGST + SGST; different states = IGST. */
export function expectedTaxType(sellerGstin?: string, buyerGstin?: string): TaxType | undefined {
  const s = gstinState(sellerGstin);
  const b = gstinState(buyerGstin);
  if (!s || !b) return undefined;
  return s === b ? "CGST_SGST" : "IGST";
}

export const activeLines = (lines: InvoiceLine[]) => lines.filter((l) => l.status !== "removed");

/** What the lines add up to, plus invoice-level charges. */
export function computedGrandTotal(lines: InvoiceLine[], totals: Pick<InvoiceTotals, "otherChargesPaise" | "discountPaise" | "roundOffPaise">): number {
  const sum = activeLines(lines).reduce((s, l) => s + l.totalPaise, 0);
  return sum + totals.otherChargesPaise - totals.discountPaise + totals.roundOffPaise;
}

/**
 * Balance-to-zero meter for the verify screen.
 * remaining = locked total − accepted lines − other charges + discount − round-off.
 */
export function verificationBalance(
  lockedTotalPaise: number,
  lines: InvoiceLine[],
  totals: Pick<InvoiceTotals, "otherChargesPaise" | "discountPaise" | "roundOffPaise">,
) {
  const live = activeLines(lines);
  const confirmed = live.filter((l) => l.status === "accepted" || l.status === "edited");
  const confirmedSum = confirmed.reduce((s, l) => s + l.totalPaise, 0);
  const remainingPaise = lockedTotalPaise - confirmedSum - totals.otherChargesPaise + totals.discountPaise - totals.roundOffPaise;
  const pendingCount = live.length - confirmed.length;
  return { remainingPaise, confirmedCount: confirmed.length, pendingCount, balanced: pendingCount === 0 && remainingPaise === 0 };
}

/** When lines are done but the balance isn't zero, suggest likely causes. */
export function balanceHints(remainingPaise: number, lines: InvoiceLine[]): { kind: "missing_line" | "duplicate_line" | "line_off"; lineId?: string; amountPaise: number }[] {
  if (remainingPaise === 0) return [];
  const live = activeLines(lines);
  const hints: { kind: "missing_line" | "duplicate_line" | "line_off"; lineId?: string; amountPaise: number }[] = [];
  if (remainingPaise > 0) hints.push({ kind: "missing_line", amountPaise: remainingPaise });
  if (remainingPaise < 0) {
    for (const l of live) if (l.totalPaise === -remainingPaise) hints.push({ kind: "duplicate_line", lineId: l.id, amountPaise: l.totalPaise });
  }
  for (const l of live) {
    const c = computeLine(l);
    if (c.totalPaise !== l.totalPaise && Math.abs(c.totalPaise - l.totalPaise - remainingPaise) <= 5) {
      hints.push({ kind: "line_off", lineId: l.id, amountPaise: c.totalPaise - l.totalPaise });
    }
  }
  return hints;
}

// ---------------------------------------------------------------- checks

export type CheckId =
  | "seller_gstin"
  | "buyer_gstin"
  | "buyer_is_store"
  | "invoice_no"
  | "invoice_date"
  | "line_math"
  | "lines_sum_taxable"
  | "tax_split"
  | "tax_sum"
  | "grand_total"
  | "round_off"
  | "gst_rate"
  | "qr_header"
  | "qr_total"
  | "qr_item_count"
  | "locked_total";

export interface CheckResult {
  id: CheckId;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  lineId?: string;
}

export interface CheckConfig {
  /** Per-line tolerance between printed and computed amounts. Default 5 paise. */
  lineTolerancePaise: number;
  /** Max absolute round-off. Default 100 paise (Rs 1). */
  roundOffMaxPaise: number;
  /** Allowed GST rates in basis points. */
  allowedGstRatesBp: number[];
  /** GSTINs of our stores; the buyer GSTIN should be one of them. */
  storeGstins: string[];
  /** YYYY-MM-DD, defaults to today. */
  today?: string;
}

export const DEFAULT_CHECK_CONFIG: CheckConfig = {
  lineTolerancePaise: 5,
  roundOffMaxPaise: 100,
  // Includes old (12, 28) and current (5, 18, 40) slabs; confirm with CA.
  allowedGstRatesBp: [0, 10, 25, 100, 150, 300, 500, 1200, 1800, 2800, 4000],
  storeGstins: [],
};

export interface CheckInput {
  header: InvoiceHeader;
  totals: InvoiceTotals;
  lines: InvoiceLine[];
  qr?: EInvoiceQr;
  lockedTotalPaise?: number;
}

/** Deterministic checks. "fail" blocks sealing; "warn" needs a human look. */
export function runChecks(input: CheckInput, cfg: Partial<CheckConfig> = {}): CheckResult[] {
  const c = { ...DEFAULT_CHECK_CONFIG, ...cfg };
  const { header: h, totals: t, qr } = input;
  const lines = activeLines(input.lines);
  const out: CheckResult[] = [];
  const add = (id: CheckId, status: CheckResult["status"], message: string, lineId?: string) => out.push({ id, status, message, lineId });

  add("seller_gstin", !h.sellerGstin ? "warn" : isValidGstin(h.sellerGstin) ? "pass" : "fail", !h.sellerGstin ? "Seller GSTIN not found" : isValidGstin(h.sellerGstin) ? "Seller GSTIN valid" : "Seller GSTIN fails checksum");
  add("buyer_gstin", !h.buyerGstin ? "warn" : isValidGstin(h.buyerGstin) ? "pass" : "fail", !h.buyerGstin ? "Buyer GSTIN not found" : isValidGstin(h.buyerGstin) ? "Buyer GSTIN valid" : "Buyer GSTIN fails checksum");
  if (c.storeGstins.length && h.buyerGstin) {
    add("buyer_is_store", c.storeGstins.includes(h.buyerGstin) ? "pass" : "warn", c.storeGstins.includes(h.buyerGstin) ? "Billed to our store" : "Buyer GSTIN is not one of our stores");
  }
  add("invoice_no", h.invoiceNo ? "pass" : "fail", h.invoiceNo ? "Invoice number present" : "Invoice number missing");

  const today = c.today ?? new Date().toISOString().slice(0, 10);
  if (!h.invoiceDate) add("invoice_date", "fail", "Invoice date missing");
  else if (h.invoiceDate > today) add("invoice_date", "fail", "Invoice date is in the future");
  else if (daysBetween(h.invoiceDate, today) > 180) add("invoice_date", "warn", "Invoice is older than 6 months");
  else add("invoice_date", "pass", "Date looks right");

  let lineFails = 0;
  for (const l of lines) {
    const calc = computeLine(l);
    if (Math.abs(calc.totalPaise - l.totalPaise) > c.lineTolerancePaise) {
      lineFails++;
      add("line_math", "fail", `Line ${l.idx + 1}: qty × rate − discount + GST does not match the amount`, l.id);
    }
    if (!c.allowedGstRatesBp.includes(l.gstRateBp)) add("gst_rate", "warn", `Line ${l.idx + 1}: unusual GST rate ${l.gstRateBp / 100}%`, l.id);
  }
  if (lines.length && !lineFails) add("line_math", "pass", "Every line adds up");

  const tol = Math.max(lines.length, 1) * 1;
  const sumTaxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  add("lines_sum_taxable", Math.abs(sumTaxable - t.taxablePaise) <= tol ? "pass" : "fail", Math.abs(sumTaxable - t.taxablePaise) <= tol ? "Lines add up to taxable value" : "Lines do not add up to the taxable value");

  const taxType = expectedTaxType(h.sellerGstin, h.buyerGstin);
  if (!taxType) add("tax_split", "skip", "Cannot tell tax type without both GSTINs");
  else if (taxType === "CGST_SGST") add("tax_split", t.igstPaise === 0 ? "pass" : "fail", t.igstPaise === 0 ? "Same state: CGST + SGST" : "Same state but IGST charged");
  else add("tax_split", t.cgstPaise === 0 && t.sgstPaise === 0 ? "pass" : "fail", t.cgstPaise === 0 && t.sgstPaise === 0 ? "Different states: IGST" : "Different states but CGST/SGST charged");

  const sumTax = lines.reduce((s, l) => s + l.taxPaise, 0);
  const printedTax = t.cgstPaise + t.sgstPaise + t.igstPaise;
  add("tax_sum", Math.abs(sumTax - printedTax) <= tol ? "pass" : "fail", Math.abs(sumTax - printedTax) <= tol ? "Tax adds up" : "Line taxes do not add up to the tax total");

  const grand = computedGrandTotal(lines, t);
  add("grand_total", grand === t.grandTotalPaise ? "pass" : "fail", grand === t.grandTotalPaise ? "Grand total adds up" : "Lines + charges + round-off do not equal the grand total");
  add("round_off", Math.abs(t.roundOffPaise) <= c.roundOffMaxPaise ? "pass" : "fail", Math.abs(t.roundOffPaise) <= c.roundOffMaxPaise ? "Round-off within limit" : "Round-off is larger than allowed");

  if (qr) {
    const headerOk = qr.sellerGstin === h.sellerGstin && qr.docNo === h.invoiceNo && qr.docDate === h.invoiceDate && (!qr.buyerGstin || qr.buyerGstin === h.buyerGstin);
    add("qr_header", headerOk ? "pass" : "fail", headerOk ? "Matches e-invoice QR" : "GSTIN, number or date differs from the e-invoice QR");
    add("qr_total", qr.totalPaise === t.grandTotalPaise ? "pass" : "fail", qr.totalPaise === t.grandTotalPaise ? "Total matches QR" : "Total differs from the e-invoice QR");
    add("qr_item_count", qr.itemCount === lines.length ? "pass" : "fail", qr.itemCount === lines.length ? "Line count matches QR" : `QR says ${qr.itemCount} items, bill has ${lines.length}`);
  }

  if (input.lockedTotalPaise !== undefined) {
    add("locked_total", input.lockedTotalPaise === t.grandTotalPaise ? "pass" : "fail", input.lockedTotalPaise === t.grandTotalPaise ? "Matches the total typed from paper" : "Differs from the total typed from paper");
  }
  return out;
}

export const blockingFailures = (checks: CheckResult[]) => checks.filter((x) => x.status === "fail");

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Indian financial year label for a date: 2026-10-22 -> "2026-27". */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
