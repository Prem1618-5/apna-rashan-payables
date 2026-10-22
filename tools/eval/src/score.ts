/** Field-level scoring of an extraction draft against ground truth. */

import type { FieldMeta, HeaderField, InvoiceHeader, InvoiceTotals, LineField, MergedExtraction, TotalsField } from "@arad/core";
import { align, descSimilarity, invoiceNoKey, normaliseUnit, vendorSimilarity } from "@arad/extraction";
import type { Expected } from "./cases.js";

export type Group = "header" | "totals" | "lines";

export interface FieldResult {
  invoice: string;
  group: Group;
  field: string;
  ok: boolean;
  /** Wrong but flagged / low confidence: a person will look at it. */
  caught: boolean;
  /** Correct but flagged: extra review work. */
  falseAlarm: boolean;
  expected?: string;
  got?: string;
}

type Draft = Pick<MergedExtraction, "header" | "headerMeta" | "totals" | "totalsMeta" | "lines">;

/** The verify screen highlights fields below this confidence. */
export const HIGHLIGHT_BELOW = 0.8;
const isFlagged = (m?: FieldMeta) => !!m && (m.flagged === true || m.confidence < HIGHLIGHT_BELOW);

const HEADER: HeaderField[] = ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "docType", "irn"];
const TOTALS: TotalsField[] = ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "otherChargesPaise", "discountPaise", "roundOffPaise", "grandTotalPaise"];
const LINE: LineField[] = ["description", "hsn", "qtyMilli", "unit", "ratePaise", "discountPaise", "gstRateBp", "taxablePaise", "taxPaise", "totalPaise"];

function headerEqual(f: HeaderField, e: string | undefined, g: string | undefined): boolean {
  if (f === "docType") return (e ?? "INV") === (g ?? "INV");
  if (e === undefined || g === undefined) return e === g;
  if (f === "vendorName") return vendorSimilarity(e, g) >= 0.9;
  if (f === "invoiceNo") return invoiceNoKey(e) === invoiceNoKey(g);
  if (f === "irn") return e.toLowerCase() === g.toLowerCase();
  return e === g;
}

type L = Expected["lines"][number];

function lineFieldEqual(f: LineField, e: L, g: L): boolean | undefined {
  switch (f) {
    case "description": return descSimilarity(e.description, g.description) >= 0.8;
    case "hsn": return e.hsn ? e.hsn === g.hsn : undefined;
    case "unit": return e.unit ? normaliseUnit(e.unit) === g.unit : undefined;
    // Before-tax rate on GST-inclusive bills is derived to whole paise: allow 1 paisa.
    case "ratePaise": return Math.abs(e.ratePaise - g.ratePaise) <= 1;
    // Line tax is often not printed and is computed; CGST+SGST rounding can differ by 1 paisa.
    case "taxPaise": return Math.abs(e.taxPaise - g.taxPaise) <= 1;
    default: return (e[f] as number) === (g[f] as number);
  }
}

function lineSim(e: L, g: L): number {
  const d = descSimilarity(e.description, g.description);
  const amt = e.totalPaise === g.totalPaise || e.taxablePaise === g.taxablePaise ? 1 : 0;
  const qty = e.qtyMilli === g.qtyMilli ? 1 : 0;
  return 0.55 * d + 0.3 * amt + 0.15 * qty;
}

/**
 * Score a draft. With `useMeta` false, nothing counts as caught (used for raw readers).
 * Fields missing from the truth (e.g. HSN not labelled on a real invoice) are skipped.
 */
export function scoreDraft(invoice: string, d: Draft, exp: Expected, useMeta = true): FieldResult[] {
  const out: FieldResult[] = [];
  const push = (group: Group, field: string, ok: boolean, meta: FieldMeta | undefined, e: unknown, g: unknown) =>
    out.push({ invoice, group, field, ok, caught: useMeta && !ok && isFlagged(meta), falseAlarm: useMeta && ok && isFlagged(meta), expected: e === undefined ? undefined : String(e), got: g === undefined ? undefined : String(g) });

  for (const f of HEADER) {
    const e = (exp.header as InvoiceHeader)[f];
    const g = d.header[f];
    if (e === undefined && (f === "irn" || f === "buyerGstin") && g === undefined) continue;
    if (e === undefined && f !== "docType" && g === undefined) continue;
    push("header", f, headerEqual(f, e, g), d.headerMeta[f], e, g);
  }
  for (const f of TOTALS) {
    const e = (exp.totals as InvoiceTotals)[f];
    if (e === undefined) continue;
    push("totals", f, d.totals[f] === e, d.totalsMeta[f], e, d.totals[f]);
  }

  const pairs = align(exp.lines, d.lines as L[], lineSim, 0.35);
  const balanceCaught = isFlagged(d.totalsMeta.grandTotalPaise) || isFlagged(d.totalsMeta.taxablePaise);
  for (const p of pairs) {
    if (p.a !== undefined && p.b !== undefined) {
      const e = exp.lines[p.a]!;
      const g = d.lines[p.b]!;
      for (const f of LINE) {
        const ok = lineFieldEqual(f, e, g as L);
        if (ok === undefined) continue;
        push("lines", f, ok, g.meta?.[f], e[f], g[f]);
      }
    } else if (p.a !== undefined) {
      const e = exp.lines[p.a]!;
      out.push({ invoice, group: "lines", field: "missingLine", ok: false, caught: useMeta && balanceCaught, falseAlarm: false, expected: e.description });
    } else {
      const g = d.lines[p.b!]!;
      out.push({ invoice, group: "lines", field: "extraLine", ok: false, caught: useMeta && (isFlagged(g.meta?.description) || isFlagged(g.meta?.totalPaise) || balanceCaught), falseAlarm: false, got: g.description });
    }
  }
  return out;
}

export interface Tally {
  n: number;
  ok: number;
  wrong: number;
  caught: number;
  silent: number;
  falseAlarms: number;
}

export function tally(rs: FieldResult[]): Tally {
  const t: Tally = { n: rs.length, ok: 0, wrong: 0, caught: 0, silent: 0, falseAlarms: 0 };
  for (const r of rs) {
    if (r.ok) t.ok++;
    else {
      t.wrong++;
      if (r.caught) t.caught++;
      else t.silent++;
    }
    if (r.falseAlarm) t.falseAlarms++;
  }
  return t;
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}
