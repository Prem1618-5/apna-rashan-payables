/**
 * One reader's normalised output -> paise/milli/bp draft.
 * Printed values are kept; missing ones are derived with computeLine and marked as derived.
 */

import { computeLine, toBp, toMilli, type HeaderField, type InvoiceHeader, type InvoiceTotals, type LineField, type RawExtraction, type Box } from "@arad/core";
import { normaliseRaw, type NormRaw, type RawLine } from "./normalise.js";

export interface DraftLine {
  description: string;
  hsn?: string;
  qtyMilli: number;
  unit?: string;
  mrpPaise?: number;
  ratePaise: number;
  discountPaise: number;
  gstRateBp: number;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  box?: Box;
  confidence: number;
  /** Fields the reader did not give at all (values above are placeholders or derived). */
  missing: Set<LineField>;
  /** Fields computed from other fields rather than read from the page. */
  derived: Set<LineField>;
}

export interface ReaderDraft {
  provider: string;
  vendor: string;
  header: InvoiceHeader;
  headerConf: Partial<Record<HeaderField, number>>;
  totals: Partial<InvoiceTotals>;
  totalsConf: Partial<Record<keyof InvoiceTotals, number>>;
  lines: DraftLine[];
  amountIncludesTax: boolean;
  rateIncludesTax: boolean;
  notes: string[];
}

const DEFAULT_CONF = 0.8;
const GST_SLABS_BP = [0, 10, 25, 100, 150, 300, 500, 1200, 1800, 2800, 4000];

const fin = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);
/** Rupees (float as printed) -> paise. Rounds to the nearest paisa. */
export const rupeesToPaise = (n: number) => Math.round(Number((n * 100).toFixed(4)));
const qtyToMilli = (n: number) => toMilli(Math.round(n * 1000) / 1000);

/** Tax / taxable -> nearest GST slab, if close enough to be unambiguous. */
export function inferGstBp(taxablePaise: number, taxPaise: number): number | undefined {
  if (taxablePaise <= 0) return undefined;
  const bp = (taxPaise / taxablePaise) * 10000;
  let best: number | undefined;
  for (const s of GST_SLABS_BP) if (best === undefined || Math.abs(s - bp) < Math.abs(best - bp)) best = s;
  // Allowed gap: 1 paisa of rounding on the tax, plus 0.2 percentage points.
  const tolBp = (1 / taxablePaise) * 10000 + 20;
  return best !== undefined && Math.abs(best - bp) <= tolBp ? best : undefined;
}

interface InclDecision {
  amountIncludesTax: boolean;
  rateIncludesTax: boolean;
  reason: string;
}

/**
 * Do printed line amounts include GST? Evidence order: invoice totals > line maths > the reader's own answer.
 * Also detects retail bills where the printed rate already includes GST (qty × rate = amount incl. GST).
 */
export function decideIncludesTax(raw: NormRaw): InclDecision {
  const lines = raw.lines;
  const t = raw.totals;
  const amounts = lines.map((l) => (fin(l.amount) ? rupeesToPaise(l.amount) : undefined));
  const all = amounts.every((a) => a !== undefined) && amounts.length > 0;
  const sum = all ? amounts.reduce((s, a) => s! + a!, 0)! : undefined;
  const tol = Math.max(2, lines.length);
  const other = fin(t.otherCharges) ? rupeesToPaise(t.otherCharges) : 0;
  const disc = fin(t.discount) ? rupeesToPaise(t.discount) : 0;
  const ro = fin(t.roundOff) ? rupeesToPaise(t.roundOff) : 0;
  const taxable = fin(t.taxable) ? rupeesToPaise(t.taxable) : undefined;
  const grand = fin(t.grandTotal) ? rupeesToPaise(t.grandTotal) : undefined;
  const taxSum = (fin(t.cgst) ? rupeesToPaise(t.cgst) : 0) + (fin(t.sgst) ? rupeesToPaise(t.sgst) : 0) + (fin(t.igst) ? rupeesToPaise(t.igst) : 0);

  // Line evidence: does qty × rate − disc land on the amount (rate and amount same basis) or on amount/(1+gst)?
  let samebasis = 0;
  let inclVotes = 0;
  for (const l of lines) {
    if (!fin(l.qty) || !fin(l.rate) || !fin(l.amount) || !fin(l.gstRate) || l.gstRate === 0) continue;
    const base = { qtyMilli: qtyToMilli(l.qty), ratePaise: rupeesToPaise(l.rate), discountPaise: fin(l.discount) ? rupeesToPaise(l.discount) : 0, gstRateBp: toBp(l.gstRate) };
    const c = computeLine(base);
    const amt = rupeesToPaise(l.amount);
    const lt = Math.max(5, Math.ceil(base.qtyMilli / 1000));
    if (Math.abs(c.taxablePaise - amt) <= lt) samebasis++;
    else if (Math.abs(c.totalPaise - amt) <= lt) inclVotes++;
  }

  let amountIncludesTax: boolean | undefined;
  let reason = "";
  if (sum !== undefined) {
    const itemsGrand = grand !== undefined ? grand - other + disc - ro : undefined;
    const matchTaxable = taxable !== undefined && Math.abs(sum - taxable) <= tol;
    const matchGrand = itemsGrand !== undefined && Math.abs(sum - itemsGrand) <= tol;
    const matchGrandLoose = itemsGrand !== undefined && Math.abs(sum - itemsGrand) <= 100 + tol;
    if (matchTaxable && !matchGrand) {
      amountIncludesTax = false;
      reason = "line amounts add up to the taxable value";
    } else if (matchGrand && !matchTaxable && taxSum > 0) {
      amountIncludesTax = true;
      reason = "line amounts add up to the grand total";
    } else if (!matchTaxable && matchGrandLoose && taxSum > 0 && taxable === undefined) {
      amountIncludesTax = true;
      reason = "line amounts add up to the grand total (within round-off)";
    }
  }
  if (amountIncludesTax === undefined && inclVotes + samebasis > 0 && inclVotes !== samebasis) {
    // samebasis votes mean either "both pre-tax" or "both incl. tax"; without totals the reader's word decides that.
    if (inclVotes > samebasis) {
      amountIncludesTax = true;
      reason = "qty × rate + GST matches line amounts";
    }
  }
  if (amountIncludesTax === undefined) {
    amountIncludesTax = raw.amountIncludesTax ?? false;
    reason = raw.amountIncludesTax === undefined ? "assumed amounts are before tax" : "as stated by the reader";
  }
  const hinted = lines.filter((l) => l.rateIncludesTax).length;
  const rateIncludesTax = amountIncludesTax && (samebasis > inclVotes || (hinted > lines.length / 2 && inclVotes === 0));
  return { amountIncludesTax, rateIncludesTax, reason };
}

function convertLine(l: RawLine, d: InclDecision): DraftLine {
  const missing = new Set<LineField>();
  const derived = new Set<LineField>();
  const conf = l.confidence ?? DEFAULT_CONF;
  if (!fin(l.qty)) missing.add("qtyMilli");
  if (!fin(l.rate)) missing.add("ratePaise");
  if (!fin(l.amount)) missing.add("totalPaise");
  if (!l.hsn) missing.add("hsn");
  if (!l.unit) missing.add("unit");
  if (!fin(l.mrp)) missing.add("mrpPaise");
  if (!fin(l.discount)) missing.add("discountPaise");

  let qtyMilli = fin(l.qty) ? qtyToMilli(l.qty) : 0;
  let ratePaise = fin(l.rate) ? rupeesToPaise(l.rate) : 0;
  let discountPaise = fin(l.discount) ? rupeesToPaise(l.discount) : 0;
  if (!fin(l.discount) && fin(l.discountPercent) && fin(l.qty) && fin(l.rate)) {
    discountPaise = Math.round((Math.round((qtyMilli * ratePaise) / 1000) * l.discountPercent) / 100);
    missing.delete("discountPaise");
    derived.add("discountPaise");
  }
  const printedTaxable = fin(l.taxable) ? rupeesToPaise(l.taxable) : undefined;
  const printedTax = fin(l.tax) ? rupeesToPaise(l.tax) : undefined;
  const amountPaise = fin(l.amount) ? rupeesToPaise(l.amount) : undefined;

  let gstRateBp: number;
  if (fin(l.gstRate)) gstRateBp = toBp(l.gstRate);
  else {
    const inferred = printedTaxable !== undefined && printedTax !== undefined ? inferGstBp(printedTaxable, printedTax) : undefined;
    if (inferred !== undefined) {
      gstRateBp = inferred;
      derived.add("gstRateBp");
    } else {
      gstRateBp = 0;
      missing.add("gstRateBp");
    }
  }
  let taxablePaise: number;
  let taxPaise: number;
  let totalPaise: number;

  if (d.amountIncludesTax && d.rateIncludesTax && !missing.has("ratePaise") && !missing.has("qtyMilli")) {
    // Retail style: rate and amount include GST. Convert rate to before-tax, keep the printed amount.
    totalPaise = amountPaise ?? Math.round((qtyMilli * ratePaise) / 1000) - discountPaise;
    if (amountPaise === undefined) derived.add("totalPaise");
    taxablePaise = printedTaxable ?? (printedTax !== undefined ? totalPaise - printedTax : Math.round((totalPaise * 10000) / (10000 + gstRateBp)));
    taxPaise = printedTax ?? totalPaise - taxablePaise;
    if (printedTaxable === undefined) derived.add("taxablePaise");
    if (printedTax === undefined) derived.add("taxPaise");
    if (qtyMilli > 0) {
      ratePaise = Math.round(((taxablePaise + discountPaise) * 1000) / qtyMilli);
      derived.add("ratePaise");
    }
  } else {
    const calc = computeLine({ qtyMilli, ratePaise, discountPaise, gstRateBp });
    const calcUsable = !missing.has("qtyMilli") && !missing.has("ratePaise");
    if (d.amountIncludesTax) {
      if (amountPaise !== undefined) totalPaise = amountPaise;
      else {
        totalPaise = printedTaxable !== undefined && printedTax !== undefined ? printedTaxable + printedTax : calc.totalPaise;
        derived.add("totalPaise");
      }
      taxablePaise = printedTaxable ?? (printedTax !== undefined ? totalPaise - printedTax : calcUsable ? calc.taxablePaise : Math.round((totalPaise * 10000) / (10000 + gstRateBp)));
      taxPaise = printedTax ?? totalPaise - taxablePaise;
      if (printedTaxable === undefined) derived.add("taxablePaise");
    } else {
      taxablePaise = printedTaxable ?? amountPaise ?? calc.taxablePaise;
      if (printedTaxable === undefined && amountPaise === undefined) derived.add("taxablePaise");
      taxPaise = printedTax ?? Math.round((taxablePaise * gstRateBp) / 10000);
      totalPaise = taxablePaise + taxPaise;
      derived.add("totalPaise");
      if (amountPaise !== undefined || printedTaxable !== undefined) missing.delete("totalPaise");
    }
    if (printedTax === undefined) derived.add("taxPaise");
  }

  const out: DraftLine = { description: l.description, qtyMilli, ratePaise, discountPaise, gstRateBp, taxablePaise, taxPaise, totalPaise, confidence: conf, missing, derived };
  if (l.hsn) out.hsn = l.hsn;
  if (l.unit) out.unit = l.unit;
  if (fin(l.mrp)) out.mrpPaise = rupeesToPaise(l.mrp);
  if (l.box) out.box = l.box;
  return out;
}

/** Normalise + convert one reader's output. */
export function toDraft(provider: string, vendor: string, input: RawExtraction): ReaderDraft {
  const { raw, notes } = normaliseRaw(input);
  const d = decideIncludesTax(raw);
  notes.push(`amounts ${d.amountIncludesTax ? "include" : "exclude"} GST: ${d.reason}${d.rateIncludesTax ? "; printed rates include GST" : ""}`);
  const lines = raw.lines.map((l) => convertLine(l, d));
  const totals: Partial<InvoiceTotals> = {};
  const map: [keyof RawExtraction["totals"], keyof InvoiceTotals][] = [
    ["taxable", "taxablePaise"], ["cgst", "cgstPaise"], ["sgst", "sgstPaise"], ["igst", "igstPaise"],
    ["otherCharges", "otherChargesPaise"], ["discount", "discountPaise"], ["roundOff", "roundOffPaise"], ["grandTotal", "grandTotalPaise"],
  ];
  const totalsConf: ReaderDraft["totalsConf"] = {};
  const conf = (raw.confidence ?? {}) as Record<string, number>;
  for (const [rk, tk] of map) {
    const v = raw.totals[rk];
    if (fin(v)) totals[tk] = rupeesToPaise(v);
    totalsConf[tk] = conf[`totals.${rk}`] ?? DEFAULT_CONF;
  }
  // Discount on invoices is printed as a positive number that reduces the total.
  if (totals.discountPaise !== undefined) totals.discountPaise = Math.abs(totals.discountPaise);
  const headerConf: ReaderDraft["headerConf"] = {};
  for (const k of ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "irn", "docType"] as HeaderField[]) headerConf[k] = conf[k] ?? DEFAULT_CONF;
  return { provider, vendor, header: raw.header, headerConf, totals, totalsConf, lines, amountIncludesTax: d.amountIncludesTax, rateIncludesTax: d.rateIncludesTax, notes };
}
