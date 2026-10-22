/**
 * The merger: two (or one) reader drafts -> one MergedExtraction the verify screen starts from.
 *
 * Principles
 *  - Never invent a value. Every value comes from a reader, the e-invoice QR, or is computed from
 *    other values with the shared maths (and then marked as computed and flagged).
 *  - Agreement between independent readers raises confidence; any disagreement is flagged with the
 *    value each reader saw (`sources`) so the human sees exactly what is in doubt.
 *  - Ties are broken by evidence, not by guessing: QR > GSTIN checksum > line maths > confidence.
 *  - Finally the deterministic checks from @arad/core run on the draft; every field involved in a
 *    failing check gets confidence below 0.6.
 */

import {
  computeLine,
  computedGrandTotal,
  expectedTaxType,
  isValidGstin,
  runChecks,
  type CheckConfig,
  type EInvoiceQr,
  type FieldMeta,
  type HeaderField,
  type InvoiceHeader,
  type InvoiceLine,
  type InvoiceTotals,
  type LineField,
  type MergedExtraction,
  type TotalsField,
} from "@arad/core";
import type { DraftLine, ReaderDraft } from "./convert.js";
import { invoiceNoKey } from "./normalise.js";
import { align, descSimilarity, vendorSimilarity } from "./similarity.js";

export interface MergeOptions {
  qr?: EInvoiceQr;
  storeGstins?: string[];
  /** Are the two readers from different vendors? Same-vendor agreement counts for less. */
  independent?: boolean;
  checkConfig?: Partial<CheckConfig>;
}

export type MergedDraft = Omit<MergedExtraction, "runs">;

/** Confidence given to a field when two independent readers agree (same-vendor readers: AGREE_SAME). */
export const AGREE = 0.95;
export const AGREE_SAME = 0.9;
/** A lone reader is never trusted enough to skip a look (UI highlights below 0.8). */
export const SINGLE_READER_MAX = 0.79;
/** Fields that make a deterministic check fail get at most this. */
export const CHECK_FAIL_MAX = 0.55;

const HEADER_FIELDS: HeaderField[] = ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "irn", "docType"];
const REQUIRED_HEADER: HeaderField[] = ["vendorName", "sellerGstin", "invoiceNo", "invoiceDate"];
const TOTALS_FIELDS: TotalsField[] = ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "otherChargesPaise", "discountPaise", "roundOffPaise", "grandTotalPaise"];
const LINE_NUM_FIELDS = ["qtyMilli", "ratePaise", "discountPaise", "gstRateBp", "taxablePaise", "taxPaise", "totalPaise", "mrpPaise"] as const;
type LineNumField = (typeof LINE_NUM_FIELDS)[number];
/** Fields that take part in the line maths; disagreements here are settled by trying combinations. */
const MATH_FIELDS: LineNumField[] = ["qtyMilli", "ratePaise", "discountPaise", "gstRateBp", "taxablePaise", "taxPaise", "totalPaise"];

const fmt = (v: unknown) => (v === undefined || v === null ? "—" : String(v));
const today = () => new Date().toISOString().slice(0, 10);

function addReason(meta: FieldMeta, reason: string) {
  meta.reason = meta.reason ? (meta.reason.includes(reason) ? meta.reason : `${meta.reason}; ${reason}`) : reason;
}

function lower(meta: FieldMeta | undefined, max: number, reason: string, flag = true): FieldMeta {
  const m = meta ?? { confidence: max };
  m.confidence = Math.min(m.confidence, max);
  if (flag) m.flagged = true;
  addReason(m, reason);
  return m;
}

// ---------------------------------------------------------------- header

function qrValue(f: HeaderField, qr?: EInvoiceQr): string | undefined {
  if (!qr) return undefined;
  switch (f) {
    case "sellerGstin": return qr.sellerGstin || undefined;
    case "buyerGstin": return qr.buyerGstin || undefined;
    case "invoiceNo": return qr.docNo || undefined;
    case "invoiceDate": return qr.docDate || undefined;
    case "irn": return qr.irn ? qr.irn.toLowerCase() : undefined;
    case "docType": return ["INV", "CRN", "DBN"].includes(qr.docType) ? qr.docType : undefined;
    default: return undefined;
  }
}

function sameHeader(f: HeaderField, a: string, b: string): boolean {
  if (f === "vendorName") return vendorSimilarity(a, b) >= 0.85;
  if (f === "invoiceNo") return invoiceNoKey(a) === invoiceNoKey(b);
  return a === b;
}

/** Evidence score for a header candidate: QR match (100) > GSTIN checksum (10) > plausible date (5) > confidence. */
function headerEvidence(f: HeaderField, v: string, conf: number, qr: EInvoiceQr | undefined, todayIso: string): number {
  const q = qrValue(f, qr);
  let score = conf;
  if (q !== undefined && sameHeader(f, v, q)) score += 100;
  if ((f === "sellerGstin" || f === "buyerGstin") && isValidGstin(v)) score += 10;
  if (f === "invoiceDate" && v <= todayIso) score += 5;
  return score;
}

function evidenceWhy(best: number, second: number | undefined): string {
  const tier = (x: number) => (x >= 100 ? 3 : x >= 10 ? 2 : x >= 5 ? 1 : 0);
  const b = tier(best);
  if (second !== undefined && b > tier(second)) return b === 3 ? "matches the e-invoice QR" : b === 2 ? "the other value fails the GSTIN checksum" : "the other date is in the future";
  return "higher reader confidence";
}

function mergeHeader(drafts: ReaderDraft[], opts: MergeOptions) {
  const header: InvoiceHeader = {};
  const meta: Partial<Record<HeaderField, FieldMeta>> = {};
  const agreeConf = opts.independent === false ? AGREE_SAME : AGREE;
  const single = drafts.length === 1;
  for (const f of HEADER_FIELDS) {
    const cands = drafts.map((d) => ({ provider: d.provider, v: d.header[f] as string | undefined, c: d.headerConf[f] ?? 0.8 }));
    const present = cands.filter((c) => c.v !== undefined) as { provider: string; v: string; c: number }[];
    const q = qrValue(f, opts.qr);
    const sources: Record<string, string> = {};
    for (const c of cands) sources[c.provider] = fmt(c.v);
    if (q !== undefined) sources.qr = q;

    let value: string | undefined;
    let m: FieldMeta | undefined;
    if (!present.length) {
      if (q !== undefined) {
        value = q;
        m = { confidence: 0.85, reason: "taken from the e-invoice QR (readers did not find it)" };
      } else if (REQUIRED_HEADER.includes(f)) {
        m = { confidence: 0, flagged: true, reason: "not found on the invoice" };
      }
    } else if (single) {
      const c = present[0]!;
      value = c.v;
      m = { confidence: Math.min(c.c, SINGLE_READER_MAX), reason: "only one reader ran" };
      if (q !== undefined) {
        if (sameHeader(f, c.v, q)) m = { confidence: 0.97, reason: "matches the e-invoice QR" };
        else {
          value = q;
          m = { confidence: 0.6, flagged: true, reason: "reader differs from the e-invoice QR; using the QR value", sources };
        }
      }
    } else if (present.length === cands.length && present.every((c) => sameHeader(f, c.v, present[0]!.v))) {
      // All readers agree. For vendor name keep the longest spelling (usually the full legal name).
      value = f === "vendorName" ? present.map((c) => c.v).sort((a, b) => b.length - a.length)[0] : present[0]!.v;
      m = { confidence: Math.max(...present.map((c) => c.c), agreeConf) };
      if (q !== undefined) {
        if (sameHeader(f, value!, q)) m.confidence = Math.max(m.confidence, 0.99);
        else {
          value = q;
          m = { confidence: 0.6, flagged: true, reason: "readers agree with each other but not with the e-invoice QR; using the QR value", sources };
        }
      }
    } else if (present.length < cands.length) {
      const c = present[0]!;
      const missingBy = cands.filter((x) => x.v === undefined).map((x) => x.provider).join(", ");
      value = c.v;
      if (q !== undefined && sameHeader(f, c.v, q)) m = { confidence: 0.95, reason: "matches the e-invoice QR" };
      else if (q !== undefined) {
        value = q;
        m = { confidence: 0.6, flagged: true, reason: "reader differs from the e-invoice QR; using the QR value", sources };
      } else if (f === "docType" && c.v === "INV") m = { confidence: 0.85, reason: `not stated by ${missingBy}; tax invoice is the default` };
      else m = { confidence: Math.min(c.c, 0.7), flagged: true, reason: `not found by ${missingBy}`, sources };
    } else {
      // Disagreement: choose by evidence.
      const todayIso = opts.checkConfig?.today ?? today();
      const ranked = present.map((c, i) => ({ ...c, score: headerEvidence(f, c.v, c.c, opts.qr, todayIso), i })).sort((a, b) => b.score - a.score || a.i - b.i);
      const best = ranked[0]!;
      const why = evidenceWhy(best.score, ranked[1]?.score);
      value = best.v;
      if (q !== undefined && !present.some((c) => sameHeader(f, c.v, q))) {
        value = q;
        m = { confidence: 0.6, flagged: true, reason: "readers disagree and neither matches the e-invoice QR; using the QR value", sources };
      } else {
        const decisive = why.startsWith("matches") ? 0.85 : why.includes("checksum") ? 0.7 : why.includes("future") ? 0.6 : 0.45;
        m = { confidence: decisive, flagged: true, reason: `readers disagree; chose ${best.provider} (${why})`, sources };
      }
    }
    if (value !== undefined) (header as Record<string, string>)[f] = value;
    if (m) meta[f] = m;
  }
  return { header, meta };
}

// ---------------------------------------------------------------- lines

/** How alike two lines are, 0..1. Description counts most; equal amounts/qty/rate also count (handles Hindi vs English descriptions). */
export function lineSimilarity(a: DraftLine, b: DraftLine): number {
  const desc = descSimilarity(a.description, b.description);
  const close = (x: number, y: number) => (x === y ? 1 : Math.abs(x - y) <= Math.max(2, Math.abs(x) * 0.01) ? 0.6 : 0);
  const amt = Math.max(close(a.totalPaise, b.totalPaise), close(a.taxablePaise, b.taxablePaise));
  return 0.5 * desc + 0.25 * amt + 0.15 * close(a.qtyMilli, b.qtyMilli) + 0.1 * close(a.ratePaise, b.ratePaise);
}

export const LINE_MATCH_THRESHOLD = 0.35;

type MergedLine = Omit<InvoiceLine, "id">;

function lineTol(qtyMilli: number) {
  // Rate is whole paise, so qty × rounded rate can drift by up to qty/2 paise.
  return Math.max(5, Math.ceil(Math.abs(qtyMilli) / 2000));
}

function lineMathError(l: Pick<DraftLine, "qtyMilli" | "ratePaise" | "discountPaise" | "gstRateBp" | "taxablePaise" | "taxPaise" | "totalPaise">): number {
  const c = computeLine(l);
  return Math.abs(c.totalPaise - l.totalPaise) + Math.abs(l.taxablePaise + l.taxPaise - l.totalPaise) + Math.abs(c.taxablePaise - l.taxablePaise);
}

function baseLineMeta(l: DraftLine, conf: number, reason?: string): Partial<Record<LineField, FieldMeta>> {
  const meta: Partial<Record<LineField, FieldMeta>> = {};
  const fields: LineField[] = ["description", "hsn", "qtyMilli", "unit", "mrpPaise", "ratePaise", "discountPaise", "gstRateBp", "taxablePaise", "taxPaise", "totalPaise"];
  for (const f of fields) {
    if (l.missing.has(f) && (f === "hsn" || f === "unit" || f === "mrpPaise" || f === "discountPaise")) continue;
    meta[f] = { confidence: conf };
    if (reason) meta[f]!.reason = reason;
    if (l.missing.has(f)) lower(meta[f], 0.3, "not read from the invoice");
  }
  return meta;
}

function draftToLine(l: DraftLine, idx: number): MergedLine {
  const out: MergedLine = {
    idx,
    description: l.description,
    qtyMilli: l.qtyMilli,
    ratePaise: l.ratePaise,
    discountPaise: l.discountPaise,
    gstRateBp: l.gstRateBp,
    taxablePaise: l.taxablePaise,
    taxPaise: l.taxPaise,
    totalPaise: l.totalPaise,
    status: "pending",
  };
  if (l.hsn) out.hsn = l.hsn;
  if (l.unit) out.unit = l.unit;
  if (l.mrpPaise !== undefined) out.mrpPaise = l.mrpPaise;
  if (l.box) out.box = l.box;
  return out;
}

function mergeLinePair(a: DraftLine, b: DraftLine, pa: string, pb: string, idx: number, agreeConf: number): MergedLine {
  // A blank discount column means no discount, so it is compared as 0 rather than "missing".
  const has = (l: DraftLine, f: LineNumField) => f === "discountPaise" || (!l.missing.has(f) && (f !== "mrpPaise" || l.mrpPaise !== undefined));
  const val = (l: DraftLine, f: LineNumField) => l[f] as number;
  const meta: Partial<Record<LineField, FieldMeta>> = {};
  const chosen: Record<LineNumField, number | undefined> = {} as Record<LineNumField, number | undefined>;
  const differing: LineNumField[] = [];

  for (const f of LINE_NUM_FIELDS) {
    const ha = has(a, f);
    const hb = has(b, f);
    if (ha && hb) {
      if (val(a, f) === val(b, f)) {
        chosen[f] = val(a, f);
        meta[f] = { confidence: Math.max(a.confidence, b.confidence, agreeConf) };
      } else differing.push(f);
    } else if (ha || hb) {
      const src = ha ? a : b;
      chosen[f] = val(src, f);
      const optional = f === "mrpPaise" || f === "discountPaise";
      meta[f] = optional
        ? { confidence: Math.min(src.confidence, 0.75), reason: `only ${ha ? pa : pb} read this` }
        : { confidence: Math.min(src.confidence, 0.6), flagged: true, reason: `only ${ha ? pa : pb} read this`, sources: { [pa]: ha ? fmt(val(a, f)) : "—", [pb]: hb ? fmt(val(b, f)) : "—" } };
    } else if (f !== "mrpPaise") {
      chosen[f] = val(a, f);
      if (f !== "discountPaise") meta[f] = { confidence: 0.3, flagged: true, reason: "not read from the invoice" };
    }
  }

  if (differing.length) {
    // Try every combination of the disagreeing maths fields and keep the one where the line adds up.
    const mathDiff = differing.filter((f) => MATH_FIELDS.includes(f));
    let best: { pick: Record<string, "a" | "b">; score: number; ok: boolean } | undefined;
    const combos = 1 << mathDiff.length;
    for (let mask = 0; mask < combos; mask++) {
      const pick: Record<string, "a" | "b"> = {};
      const l = { ...chosen } as Record<LineNumField, number>;
      let conf = 0;
      mathDiff.forEach((f, i) => {
        const side = mask & (1 << i) ? "b" : "a";
        pick[f] = side;
        l[f] = val(side === "a" ? a : b, f);
        conf += side === "a" ? a.confidence : b.confidence;
      });
      const err = lineMathError({ qtyMilli: l.qtyMilli ?? 0, ratePaise: l.ratePaise ?? 0, discountPaise: l.discountPaise ?? 0, gstRateBp: l.gstRateBp ?? 0, taxablePaise: l.taxablePaise ?? 0, taxPaise: l.taxPaise ?? 0, totalPaise: l.totalPaise ?? 0 });
      const ok = err <= lineTol(l.qtyMilli ?? 0) * 2;
      // A combination that adds up beats any that does not; then smaller error; then reader confidence; then reader A.
      const score = (ok ? 1000 : 0) - Math.min(err, 999) / 1000 + conf / 100;
      if (!best || score > best.score + 1e-12) best = { pick, score, ok };
    }
    const mathOk = best?.ok ?? false;
    for (const f of differing) {
      let side: "a" | "b";
      if (best && f in best.pick) side = best.pick[f]!;
      else side = b.confidence > a.confidence ? "b" : "a";
      chosen[f] = val(side === "a" ? a : b, f);
      const sources = { [pa]: fmt(val(a, f)), [pb]: fmt(val(b, f)) };
      const aDerived = a.derived.has(f as LineField);
      const bDerived = b.derived.has(f as LineField);
      const why = MATH_FIELDS.includes(f) && mathOk ? "readers differ; chose the value that makes the line add up" : "readers differ";
      meta[f] = { confidence: MATH_FIELDS.includes(f) && mathOk ? 0.7 : 0.4, flagged: true, reason: why + (aDerived || bDerived ? " (one value was computed, not printed)" : ""), sources };
    }
  }

  // Text fields.
  const ds = descSimilarity(a.description, b.description);
  let description = a.description;
  if (!a.description) description = b.description;
  if (ds >= 0.9) meta.description = { confidence: Math.max(a.confidence, b.confidence, agreeConf) };
  else if (a.description && b.description) {
    description = b.confidence > a.confidence ? b.description : a.description;
    meta.description = { confidence: ds >= 0.6 ? 0.75 : 0.5, flagged: ds < 0.6, reason: "readers read the item name differently", sources: { [pa]: a.description, [pb]: b.description } };
  } else meta.description = { confidence: 0.5, flagged: true, reason: "item name read by one reader only" };

  const hsnOk = (h?: string) => !!h && [4, 6, 8].includes(h.length);
  let hsn = a.hsn ?? b.hsn;
  if (a.hsn && b.hsn && a.hsn !== b.hsn) {
    hsn = hsnOk(a.hsn) === hsnOk(b.hsn) ? (b.confidence > a.confidence ? b.hsn : a.hsn) : hsnOk(a.hsn) ? a.hsn : b.hsn;
    meta.hsn = { confidence: 0.45, flagged: true, reason: "readers differ", sources: { [pa]: a.hsn, [pb]: b.hsn } };
  } else if (a.hsn && b.hsn) meta.hsn = { confidence: Math.max(a.confidence, b.confidence, agreeConf) };
  else if (hsn) meta.hsn = { confidence: 0.7, reason: `only ${a.hsn ? pa : pb} read this` };

  let unit = a.unit ?? b.unit;
  if (a.unit && b.unit && a.unit !== b.unit) {
    unit = b.confidence > a.confidence ? b.unit : a.unit;
    meta.unit = { confidence: 0.5, flagged: true, reason: "readers differ", sources: { [pa]: a.unit, [pb]: b.unit } };
  } else if (a.unit && b.unit) meta.unit = { confidence: Math.max(a.confidence, b.confidence, agreeConf) };
  else if (unit) meta.unit = { confidence: 0.7 };

  const out: MergedLine = {
    idx,
    description,
    qtyMilli: chosen.qtyMilli ?? 0,
    ratePaise: chosen.ratePaise ?? 0,
    discountPaise: chosen.discountPaise ?? 0,
    gstRateBp: chosen.gstRateBp ?? 0,
    taxablePaise: chosen.taxablePaise ?? 0,
    taxPaise: chosen.taxPaise ?? 0,
    totalPaise: chosen.totalPaise ?? 0,
    status: "pending",
    meta,
  };
  if (hsn) out.hsn = hsn;
  if (unit) out.unit = unit;
  if (chosen.mrpPaise !== undefined) out.mrpPaise = chosen.mrpPaise;
  const box = a.box ?? b.box;
  if (box) out.box = box;
  return out;
}

function mergeLines(drafts: ReaderDraft[], opts: MergeOptions): MergedLine[] {
  if (!drafts.length) return [];
  if (drafts.length === 1) {
    return drafts[0]!.lines.map((l, i) => ({ ...draftToLine(l, i), meta: baseLineMeta(l, Math.min(l.confidence, SINGLE_READER_MAX), "only one reader ran") }));
  }
  const [A, B] = drafts as [ReaderDraft, ReaderDraft];
  const agreeConf = opts.independent === false ? AGREE_SAME : AGREE;
  const pairs = align(A.lines, B.lines, lineSimilarity, LINE_MATCH_THRESHOLD);
  const out: MergedLine[] = [];
  for (const p of pairs) {
    const idx = out.length;
    if (p.a !== undefined && p.b !== undefined) out.push(mergeLinePair(A.lines[p.a]!, B.lines[p.b]!, A.provider, B.provider, idx, agreeConf));
    else {
      const only = p.a !== undefined ? A : B;
      const other = p.a !== undefined ? B : A;
      const l = only.lines[(p.a ?? p.b)!]!;
      const line = { ...draftToLine(l, idx), meta: baseLineMeta(l, Math.min(l.confidence, 0.5)) };
      const reason = `only ${only.provider} found this line; ${other.provider} did not`;
      for (const f of ["description", "totalPaise", "qtyMilli", "ratePaise"] as LineField[]) line.meta[f] = lower(line.meta[f], 0.4, reason);
      out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------- totals

function expectedTotals(lines: MergedLine[], header: InvoiceHeader): Partial<Record<TotalsField, number>> {
  const taxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
  const tt = expectedTaxType(header.sellerGstin, header.buyerGstin);
  const exp: Partial<Record<TotalsField, number>> = { taxablePaise: taxable };
  if (tt === "IGST") Object.assign(exp, { igstPaise: tax, cgstPaise: 0, sgstPaise: 0 });
  if (tt === "CGST_SGST") Object.assign(exp, { igstPaise: 0, cgstPaise: Math.round(tax / 2), sgstPaise: tax - Math.round(tax / 2) });
  return exp;
}

function mergeTotals(drafts: ReaderDraft[], lines: MergedLine[], header: InvoiceHeader, opts: MergeOptions) {
  const totals: InvoiceTotals = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, otherChargesPaise: 0, discountPaise: 0, roundOffPaise: 0, grandTotalPaise: 0 };
  const meta: Partial<Record<TotalsField, FieldMeta>> = {};
  const agreeConf = opts.independent === false ? AGREE_SAME : AGREE;
  const single = drafts.length === 1;
  const exp = expectedTotals(lines, header);
  const tol = Math.max(lines.length, 1) + 1;
  const anyTax = drafts.some((d) => d.totals.cgstPaise !== undefined || d.totals.sgstPaise !== undefined || d.totals.igstPaise !== undefined);

  const order: TotalsField[] = ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "otherChargesPaise", "discountPaise", "roundOffPaise", "grandTotalPaise"];
  for (const f of order) {
    const cands = drafts.map((d) => ({ provider: d.provider, v: d.totals[f], c: d.totalsConf[f] ?? 0.8 }));
    const present = cands.filter((c) => c.v !== undefined) as { provider: string; v: number; c: number }[];
    const sources: Record<string, string> = {};
    for (const c of cands) sources[c.provider] = fmt(c.v);
    const q = f === "grandTotalPaise" && opts.qr ? opts.qr.totalPaise : undefined;
    if (q !== undefined) sources.qr = String(q);
    if (f === "grandTotalPaise") {
      exp.grandTotalPaise = computedGrandTotal(lines as InvoiceLine[], totals);
    }
    const e = exp[f];
    let value: number;
    let m: FieldMeta;

    if (!present.length) {
      if (f === "otherChargesPaise" || f === "discountPaise") {
        value = 0;
        m = { confidence: 0.8, reason: "none printed" };
      } else if (f === "roundOffPaise") {
        // Not printed: the gap between the printed grand total and the lines is the implied round-off.
        const g = drafts.map((d) => d.totals.grandTotalPaise).find((x) => x !== undefined) ?? opts.qr?.totalPaise;
        const gap = g !== undefined ? g - computedGrandTotal(lines as InvoiceLine[], { ...totals, roundOffPaise: 0 }) : 0;
        if (g !== undefined && gap !== 0 && Math.abs(gap) <= 99) {
          value = gap;
          m = { confidence: 0.5, flagged: true, reason: "round-off not printed; computed from grand total minus lines" };
        } else {
          value = 0;
          m = { confidence: 0.8, reason: "none printed" };
        }
      } else if ((f === "cgstPaise" || f === "sgstPaise" || f === "igstPaise") && anyTax) {
        value = 0;
        m = { confidence: 0.8, reason: "not charged on this invoice" };
      } else if (f === "grandTotalPaise" && q !== undefined) {
        value = q;
        m = { confidence: 0.85, reason: "taken from the e-invoice QR (readers did not find it)" };
      } else {
        value = e ?? 0;
        m = { confidence: f === "grandTotalPaise" ? 0.2 : 0.4, flagged: true, reason: "not read from the invoice; computed from the lines" };
      }
    } else if (single) {
      const c = present[0]!;
      value = c.v;
      m = { confidence: Math.min(c.c, SINGLE_READER_MAX), reason: "only one reader ran" };
      if (q !== undefined) {
        if (q === c.v) m = { confidence: 0.97, reason: "matches the e-invoice QR" };
        else {
          value = q;
          m = { confidence: 0.6, flagged: true, reason: "reader differs from the e-invoice QR; using the QR value", sources };
        }
      }
    } else {
      const distinct = [...new Set(present.map((c) => c.v))];
      if (distinct.length === 1 && present.length === cands.length) {
        value = distinct[0]!;
        m = { confidence: Math.max(...present.map((c) => c.c), agreeConf) };
        if (q !== undefined && q !== value) {
          value = q;
          m = { confidence: 0.6, flagged: true, reason: "readers agree with each other but not with the e-invoice QR; using the QR value", sources };
        } else if (q !== undefined) m.confidence = 0.99;
      } else {
        // Disagreement or one missing: QR > matches what the lines add up to > confidence.
        const ranked = present
          .map((c, i) => {
            let score = c.c;
            let why = "higher reader confidence";
            if (q !== undefined && c.v === q) {
              score += 100;
              why = "matches the e-invoice QR";
            } else if (e !== undefined && Math.abs(c.v - e) <= tol) {
              score += 10;
              why = "matches what the lines add up to";
            }
            return { ...c, score, why, i };
          })
          .sort((x, y) => y.score - x.score || x.i - y.i);
        const best = ranked[0]!;
        value = best.v;
        if (q !== undefined && !present.some((c) => c.v === q)) {
          value = q;
          m = { confidence: 0.6, flagged: true, reason: "readers disagree and neither matches the e-invoice QR; using the QR value", sources };
        } else if (present.length < cands.length) {
          const missingBy = cands.filter((x) => x.v === undefined).map((x) => x.provider).join(", ");
          const zeroish = (f === "otherChargesPaise" || f === "discountPaise" || f === "roundOffPaise") && Math.abs(value) <= 0;
          m = zeroish ? { confidence: 0.8 } : { confidence: best.score >= 10 ? 0.75 : 0.6, flagged: best.score < 10, reason: `not found by ${missingBy}${best.score >= 10 ? `; ${best.why}` : ""}`, sources };
        } else {
          m = { confidence: best.score >= 100 ? 0.85 : best.score >= 10 ? 0.7 : 0.45, flagged: true, reason: `readers disagree; chose ${best.provider} (${best.why})`, sources };
        }
      }
    }
    totals[f] = value;
    meta[f] = m;
  }
  return { totals, meta };
}

// ---------------------------------------------------------------- checks -> confidence

const LINE_MATH_FIELDS: LineField[] = ["qtyMilli", "ratePaise", "discountPaise", "gstRateBp", "totalPaise"];

function applyChecks(d: MergedDraft, opts: MergeOptions) {
  const lines: InvoiceLine[] = d.lines.map((l) => ({ ...l, id: `l${l.idx}` }));
  const cfg: Partial<CheckConfig> = { ...opts.checkConfig };
  if (opts.storeGstins?.length) cfg.storeGstins = opts.storeGstins;
  const checks = runChecks({ header: d.header, totals: d.totals, lines, qr: opts.qr }, cfg);
  const hm = (f: HeaderField, max: number, reason: string) => (d.headerMeta[f] = lower(d.headerMeta[f], max, reason));
  const tm = (f: TotalsField, max: number, reason: string) => (d.totalsMeta[f] = lower(d.totalsMeta[f], max, reason));
  for (const c of checks) {
    const bad = c.status === "fail";
    const warn = c.status === "warn";
    if (!bad && !warn) continue;
    const max = bad ? CHECK_FAIL_MAX : 0.6;
    const reason = `check: ${c.message}`;
    switch (c.id) {
      case "seller_gstin": hm("sellerGstin", bad ? CHECK_FAIL_MAX : 0.3, reason); break;
      case "buyer_gstin": hm("buyerGstin", bad ? CHECK_FAIL_MAX : 0.3, reason); break;
      case "buyer_is_store": hm("buyerGstin", 0.6, reason); break;
      case "invoice_no": if (bad) hm("invoiceNo", CHECK_FAIL_MAX, reason); break;
      case "invoice_date": hm("invoiceDate", max, reason); break;
      case "line_math": {
        const line = d.lines.find((l) => `l${l.idx}` === c.lineId);
        if (line && bad) {
          line.meta ??= {};
          for (const f of LINE_MATH_FIELDS) line.meta[f] = lower(line.meta[f], CHECK_FAIL_MAX, "check: qty × rate − discount + GST does not match the amount");
        }
        break;
      }
      case "gst_rate": {
        const line = d.lines.find((l) => `l${l.idx}` === c.lineId);
        if (line) {
          line.meta ??= {};
          line.meta.gstRateBp = lower(line.meta.gstRateBp, 0.6, reason);
        }
        break;
      }
      case "lines_sum_taxable": if (bad) tm("taxablePaise", CHECK_FAIL_MAX, reason); break;
      case "tax_split":
      case "tax_sum":
        if (bad) for (const f of ["cgstPaise", "sgstPaise", "igstPaise"] as TotalsField[]) if (d.totals[f] !== 0 || c.id === "tax_sum") tm(f, CHECK_FAIL_MAX, reason);
        break;
      case "grand_total": if (bad) tm("grandTotalPaise", CHECK_FAIL_MAX, reason); break;
      case "round_off": if (bad) tm("roundOffPaise", CHECK_FAIL_MAX, reason); break;
      case "qr_header":
        if (bad && opts.qr) {
          if (d.header.sellerGstin !== opts.qr.sellerGstin) hm("sellerGstin", CHECK_FAIL_MAX, reason);
          if (d.header.invoiceNo !== opts.qr.docNo) hm("invoiceNo", CHECK_FAIL_MAX, reason);
          if (d.header.invoiceDate !== opts.qr.docDate) hm("invoiceDate", CHECK_FAIL_MAX, reason);
          if (opts.qr.buyerGstin && d.header.buyerGstin !== opts.qr.buyerGstin) hm("buyerGstin", CHECK_FAIL_MAX, reason);
        }
        break;
      case "qr_total": if (bad) tm("grandTotalPaise", CHECK_FAIL_MAX, reason); break;
      default: break;
    }
  }
  // A line total that does not add up to the grand total points at the lines too: keep the lone-reader lines low.
  return checks;
}

// ---------------------------------------------------------------- entry

export function emptyDraft(): MergedDraft {
  return {
    header: {},
    headerMeta: {},
    totals: { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, otherChargesPaise: 0, discountPaise: 0, roundOffPaise: 0, grandTotalPaise: 0 },
    totalsMeta: {},
    lines: [],
  };
}

/** Merge one or two reader drafts (more are ignored: the first two are used). */
export function mergeDrafts(drafts: ReaderDraft[], opts: MergeOptions = {}): MergedDraft {
  const use = drafts.slice(0, 2);
  if (!use.length) {
    const d = emptyDraft();
    if (opts.qr) {
      // Even with no reader, the QR gives a trustworthy header and total.
      const { header, meta } = mergeHeader([], opts);
      d.header = header;
      d.headerMeta = meta;
      d.totals.grandTotalPaise = opts.qr.totalPaise;
      d.totalsMeta.grandTotalPaise = { confidence: 0.85, reason: "taken from the e-invoice QR" };
    }
    return d;
  }
  const { header, meta: headerMeta } = mergeHeader(use, opts);
  const lines = mergeLines(use, opts);
  const { totals, meta: totalsMeta } = mergeTotals(use, lines, header, opts);
  const draft: MergedDraft = { header, headerMeta, totals, totalsMeta, lines };
  applyChecks(draft, opts);
  return draft;
}
