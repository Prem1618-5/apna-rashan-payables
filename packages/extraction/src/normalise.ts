/**
 * Cleans what a reader returned before merging: formats only, never new values.
 * GSTIN uppercase without spaces, invoice number trimmed, HSN digits only,
 * units in short uppercase form, dates as YYYY-MM-DD, numbers parsed from text.
 */

import { GSTIN_PATTERN, isValidGstin, type InvoiceHeader, type RawExtractedLine, type RawExtraction } from "@arad/core";
import type { RawLineHints } from "./types.js";

export type RawLine = RawExtractedLine & RawLineHints;
export type NormRaw = Omit<RawExtraction, "lines"> & { lines: RawLine[] };

/** Number from a number or printed text: "1,23,456.70", "₹ 99", "Rs.12", "(5.00)" (negative), "-" → undefined. */
export function parseNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  let s = v.trim();
  if (!s || /^[-–—.]+$/.test(s)) return undefined;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^(rs\.?|inr|₹)/i, "").replace(/[,\s₹]/g, "").replace(/(cr|dr)$/i, "");
  if (s.endsWith("-")) {
    neg = true;
    s = s.slice(0, -1);
  }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return neg ? -Math.abs(n) : n;
}

/** Positions of a GSTIN that must be digits (D) or letters (L); others are alphanumeric. */
const GSTIN_SHAPE = "DDLLLLLDDDDLAZA";
const TO_DIGIT: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6", T: "7" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "7": "T" };

export interface GstinResult {
  value?: string;
  /** A character was fixed because its position forces a digit/letter and the fix passes the checksum. */
  corrected?: boolean;
}

/**
 * Uppercase, strip spaces/dashes/dots. If the shape is wrong only because of a
 * classic OCR confusion (O↔0, I↔1, S↔5, B↔8 …) at a position that must be a
 * digit or a letter, fix it, but only when the fixed GSTIN passes the checksum.
 */
export function normaliseGstin(input: unknown): GstinResult {
  if (typeof input !== "string") return {};
  const g = input.replace(/[\s\-.:]/g, "").toUpperCase();
  if (!g) return {};
  if (g.length !== 15 || GSTIN_PATTERN.test(g)) return { value: g };
  const chars = g.split("");
  for (let i = 0; i < 15; i++) {
    const want = GSTIN_SHAPE[i];
    const c = chars[i]!;
    if (want === "D" && !/\d/.test(c) && TO_DIGIT[c]) chars[i] = TO_DIGIT[c]!;
    else if (want === "L" && !/[A-Z]/.test(c) && TO_LETTER[c]) chars[i] = TO_LETTER[c]!;
    else if (want === "Z" && c === "2") chars[i] = "Z";
  }
  const fixed = chars.join("");
  if (fixed !== g && isValidGstin(fixed)) return { value: fixed, corrected: true };
  return { value: g };
}

export function normaliseInvoiceNo(input: unknown): string | undefined {
  if (typeof input !== "string" && typeof input !== "number") return undefined;
  const s = String(input)
    .replace(/^\s*(invoice|inv|bill)?\s*(no\.?|number|#)\s*[:.\-]?\s*/i, "")
    .replace(/^[\s:#]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || undefined;
}

/** Key for comparing invoice numbers from two readers (case and spacing do not matter). */
export const invoiceNoKey = (s: string) => s.replace(/\s+/g, "").toUpperCase();

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function isoIfValid(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Indian invoices print day first. Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YY, DD.MM.YYYY, 22-Oct-2026, 22 Oct 26. */
export function normaliseDate(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) return isoIfValid(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s\-/.]*([A-Za-z]{3,9})[\s\-/.,]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith("sept") ? 4 : 3)];
    return mon ? isoIfValid(Number(m[3]), mon, Number(m[1])) : undefined;
  }
  return undefined;
}

export function normaliseHsn(input: unknown): string | undefined {
  if (typeof input !== "string" && typeof input !== "number") return undefined;
  const d = String(input).replace(/\D/g, "");
  return d || undefined;
}

const UNIT_MAP: [RegExp, string][] = [
  [/^(KG|KGS|KILO|KILOS|KILOGRAMS?|किलो|कि\.?ग्रा\.?)$/, "KG"],
  [/^(G|GM|GMS|GRAMS?|GRM|ग्राम)$/, "G"],
  [/^(L|LT|LTR|LTRS|LITRES?|LITERS?|लीटर)$/, "L"],
  [/^(ML|MLS|MILLILITRES?|MILLILITERS?)$/, "ML"],
  [/^(PC|PCS|PIECES?|पीस)$/, "PCS"],
  [/^(NO|NOS|NUMBERS?|UNITS?|U|EA|EACH|नग)$/, "NOS"],
  [/^(BOX|BOXES|BX)$/, "BOX"],
  [/^(PKT|PKTS|PACKETS?|PACK|PACKS|PAC|पैकेट)$/, "PKT"],
  [/^(BAG|BAGS|बोरी)$/, "BAG"],
  [/^(BTL|BTLS|BOTTLES?)$/, "BTL"],
  [/^(CTN|CTNS|CARTONS?|CASES?|CS)$/, "CTN"],
  [/^(DZ|DZN|DOZ|DOZENS?|दर्जन)$/, "DZN"],
  [/^(JAR|JARS)$/, "JAR"],
  [/^(TIN|TINS)$/, "TIN"],
  [/^(SET|SETS)$/, "SET"],
  [/^(ROLL|ROLLS)$/, "ROLL"],
  [/^(MTR|MTRS|METRES?|METERS?|M)$/, "MTR"],
];

export function normaliseUnit(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const u = input.trim().replace(/\./g, "").toUpperCase();
  if (!u) return undefined;
  for (const [re, short] of UNIT_MAP) if (re.test(u)) return short;
  return u.replace(/\s+/g, "");
}

export function normaliseDocType(input: unknown): InvoiceHeader["docType"] | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim().toUpperCase();
  if (!s) return undefined;
  if (s === "CRN" || /CREDIT/.test(s) || s.includes("जमा")) return "CRN";
  if (s === "DBN" || /DEBIT/.test(s)) return "DBN";
  if (s === "INV" || /INVOICE|BILL|बीजक|बिल/.test(s)) return "INV";
  return undefined;
}

export function normaliseText(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.replace(/\s+/g, " ").trim();
  return s || undefined;
}

/** Rows that are not items: brought-forward / carried-forward subtotals and total rows of continued tables. */
const NON_ITEM = /^(b\s*\/\s*f|c\s*\/\s*f|brought\s+forward|carried\s+forward|carry\s+forward|balance\s+b\/?f|sub\s*-?\s*total|total|grand\s+total|page\s+total|आगे\s*का|पिछला\s*जोड़|कुल(\s*योग)?|योग)(?=$|[\s:.\-])[\s:.\-]*(.*)$/i;

export function isNonItemRow(l: { description?: unknown; qty?: unknown; rate?: unknown }): boolean {
  const d = typeof l.description === "string" ? l.description.trim() : "";
  const m = NON_ITEM.exec(d);
  if (!m) return false;
  // A real item named "Total Wash 1L" has a qty and rate; a subtotal row usually has neither.
  const qty = parseNum(l.qty);
  const rate = parseNum(l.rate);
  return !qty || !rate || !(m[3] ?? "").trim();
}

const clamp01 = (n: number | undefined) => (n === undefined ? undefined : Math.min(1, Math.max(0, n)));

function normaliseBox(b: unknown): RawExtractedLine["box"] | undefined {
  if (!b || typeof b !== "object") return undefined;
  const o = b as Record<string, unknown>;
  const x = parseNum(o.x), y = parseNum(o.y), w = parseNum(o.w), h = parseNum(o.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  // Accept 0..1000 boxes (some models answer in per-mille) by scaling down.
  const scale = Math.max(x, y, w, h) > 1.5 ? 1000 : 1;
  const page = Math.max(0, Math.round(parseNum(o.page) ?? 0));
  return { page, x: clamp01(x / scale)!, y: clamp01(y / scale)!, w: clamp01(w / scale)!, h: clamp01(h / scale)! };
}

export interface NormaliseResult {
  raw: NormRaw;
  notes: string[];
}

/** Clean one reader's output. Unknown or unreadable values become undefined (never guessed). */
export function normaliseRaw(input: RawExtraction | Record<string, unknown>): NormaliseResult {
  const notes: string[] = [];
  const src = (input ?? {}) as Record<string, unknown>;
  const h = (src.header ?? {}) as Record<string, unknown>;
  const seller = normaliseGstin(h.sellerGstin);
  const buyer = normaliseGstin(h.buyerGstin);
  if (seller.corrected) notes.push("sellerGstin: fixed an O/0-style misread that the checksum confirms");
  if (buyer.corrected) notes.push("buyerGstin: fixed an O/0-style misread that the checksum confirms");
  const header: InvoiceHeader = {
    vendorName: normaliseText(h.vendorName),
    sellerGstin: seller.value,
    buyerGstin: buyer.value,
    invoiceNo: normaliseInvoiceNo(h.invoiceNo),
    invoiceDate: normaliseDate(h.invoiceDate),
    irn: typeof h.irn === "string" && h.irn.replace(/\s/g, "") ? h.irn.replace(/\s/g, "").toLowerCase() : undefined,
    docType: normaliseDocType(h.docType),
  };
  if (typeof h.invoiceDate === "string" && h.invoiceDate.trim() && !header.invoiceDate) notes.push(`invoiceDate: could not read "${h.invoiceDate}" as a date`);
  for (const k of Object.keys(header) as (keyof InvoiceHeader)[]) if (header[k] === undefined) delete header[k];

  const t = (src.totals ?? {}) as Record<string, unknown>;
  const totals: RawExtraction["totals"] = {};
  for (const k of ["taxable", "cgst", "sgst", "igst", "otherCharges", "discount", "roundOff", "grandTotal"] as const) {
    const n = parseNum(t[k]);
    if (n !== undefined) totals[k] = n;
  }

  const lines: RawLine[] = [];
  const rawLines = Array.isArray(src.lines) ? (src.lines as Record<string, unknown>[]) : [];
  for (const l of rawLines) {
    if (!l || typeof l !== "object") continue;
    if (isNonItemRow(l)) {
      notes.push(`dropped non-item row "${String(l.description)}"`);
      continue;
    }
    const qty = parseNum(l.qty);
    const rate = parseNum(l.rate);
    const amount = parseNum(l.amount);
    const description = normaliseText(l.description) ?? "";
    if (!description && amount === undefined && rate === undefined) continue;
    const line: RawLine = {
      description,
      qty: qty ?? NaN,
      rate: rate ?? NaN,
      amount: amount ?? NaN,
    };
    const hsn = normaliseHsn(l.hsn);
    if (hsn) line.hsn = hsn;
    const unit = normaliseUnit(l.unit);
    if (unit) line.unit = unit;
    for (const k of ["mrp", "discount", "gstRate", "taxable", "tax"] as const) {
      const n = parseNum(l[k]);
      if (n !== undefined) line[k] = n;
    }
    const box = normaliseBox(l.box);
    if (box) line.box = box;
    const c = clamp01(parseNum(l.confidence));
    if (c !== undefined) line.confidence = c;
    if (typeof l.rateIncludesTax === "boolean") line.rateIncludesTax = l.rateIncludesTax;
    const dp = parseNum(l.discountPercent);
    if (dp !== undefined && dp > 0 && dp < 100 && line.discount === undefined) line.discountPercent = dp;
    lines.push(line);
  }

  const confidence: RawExtraction["confidence"] = {};
  if (src.confidence && typeof src.confidence === "object") {
    for (const [k, v] of Object.entries(src.confidence as Record<string, unknown>)) {
      const c = clamp01(parseNum(v));
      if (c !== undefined) (confidence as Record<string, number>)[k] = c;
    }
  }
  const raw: NormaliseResult["raw"] = { header, totals, lines, confidence };
  if (typeof src.amountIncludesTax === "boolean") raw.amountIncludesTax = src.amountIncludesTax;
  return { raw, notes };
}
