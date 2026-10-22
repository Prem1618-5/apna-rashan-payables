/** Builds one synthetic invoice: the numbers (with the shared GST maths) and the ground truth. */

import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { computeLine, financialYear, gstinCheckChar, isValidGstin, type InvoiceHeader, type InvoiceLine, type InvoiceTotals, type RawExtraction } from "@arad/core";
import { BUYER, FREIGHT_LABELS, ITEMS, VENDORS, type Item, type Store, type Vendor } from "./data.js";
import { Rng } from "./rng.js";

export type Layout = "a4-table" | "thermal" | "hindi" | "igst" | "credit-note";
export const LAYOUTS: Layout[] = ["a4-table", "thermal", "hindi", "igst", "credit-note"];

export interface SynthLine {
  description: string;
  hsn: string;
  qtyMilli: number;
  unit: string;
  mrpPaise?: number;
  /** Before tax (the contract). */
  ratePaise: number;
  /** As printed in the rate column (thermal bills print GST-inclusive rates). */
  printedRatePaise: number;
  discountPaise: number;
  discountPct?: number;
  gstRateBp: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  /** What the amount column shows. */
  printedAmountPaise: number;
}

export interface SynthInvoice {
  id: string;
  layout: Layout;
  seed: number;
  vendor: Vendor & { gstin: string };
  buyer: { name: string; gstin: string; store: Store };
  header: Required<Pick<InvoiceHeader, "vendorName" | "sellerGstin" | "buyerGstin" | "invoiceNo" | "invoiceDate" | "docType">> & { irn?: string };
  printedDate: string;
  lines: SynthLine[];
  totals: InvoiceTotals;
  otherChargesLabel?: string;
  taxType: "CGST_SGST" | "IGST";
  amountIncludesTax: boolean;
  rateIncludesTax: boolean;
  /** Lines per page (multi-page invoices continue the table with B/F rows). */
  pageBreaks: number[];
  qr?: { jwt: string; ackNo: string; irnDate: string };
  againstInvoice?: string;
  legacy: boolean;
  generatedOn: string;
}

/** Ground truth written next to each image. */
export interface Truth {
  id: string;
  layout: Layout;
  dataClass: "synthetic";
  generatedOn: string;
  seed: number;
  pages: string[];
  distortions: string[];
  /** As printed, RawExtraction-compatible (rupees; rate is per unit before tax). */
  raw: RawExtraction;
  /** Paise form the merger should produce (MergedExtraction-like, no meta). */
  expected: { header: InvoiceHeader; totals: InvoiceTotals; lines: Omit<InvoiceLine, "id" | "meta" | "box">[] };
  qr?: { raw: string };
  /** Rate column exactly as printed, per line (rupees; GST-inclusive on thermal bills). */
  printedRates: number[];
  notes: string[];
}

// ------------------------------------------------------------ helpers

function hashSeed(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32LE(0);
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function vendorGstin(v: Vendor): string {
  const r = new Rng(hashSeed(v.name));
  const pan = `${r.pick(LETTERS)}${r.pick(LETTERS)}${r.pick(LETTERS)}${v.entity}${v.name[0]!.toUpperCase()}${r.int(1000, 9999)}${r.pick(LETTERS)}`;
  const first14 = `${v.state}${pan}1Z`;
  const g = first14 + gstinCheckChar(first14);
  if (!isValidGstin(g)) throw new Error(`bad synthetic GSTIN ${g}`);
  return g;
}

export const BUYER_GSTIN = BUYER.pan14 + gstinCheckChar(BUYER.pan14);

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function printDate(iso: string, r: Rng): string {
  const [y, m, d] = iso.split("-") as [string, string, string];
  return r.weighted<string>([
    [`${d}/${m}/${y}`, 4],
    [`${d}-${m}-${y}`, 2],
    [`${d}-${MON[Number(m) - 1]}-${y}`, 2],
    [`${d}.${m}.${y.slice(2)}`, 1],
  ]);
}

function initials(name: string) {
  return name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}

function invoiceNumber(v: Vendor, iso: string, r: Rng, credit: boolean): string {
  const fy = financialYear(iso);
  const n = r.int(12, 4999);
  const p = initials(v.name);
  if (credit) return r.pick([`CN/${fy}/${String(n).padStart(3, "0")}`, `${p}/CN/${n}`]);
  return r.pick([`${p}/${fy}/${String(n).padStart(4, "0")}`, `INV-${iso.slice(0, 4)}-${n}`, `${p}/${n}`, `GST/${fy}/${String(n).padStart(5, "0")}`, `${r.pick(["A", "B", "T"])}-${n}`]);
}

/** Rupees with 2 decimals, chosen inside a range. */
const rupees = (r: Rng, [lo, hi]: [number, number]) => Math.round((lo + r.next() * (hi - lo)) * 100);

// ------------------------------------------------------------ test signing key (e-invoice QR)

let KEY: KeyObject | undefined;
/** RSA key for signing synthetic e-invoice QR JWTs. Generated per process; test-only, never a real IRP key. */
function signingKey(): KeyObject {
  if (!KEY) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    KEY = createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }));
  }
  return KEY;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signEInvoiceJwt(data: Record<string, unknown>): string {
  const header = { alg: "RS256", kid: "SYNTHETIC-TEST-KEY", typ: "JWT", x5t: "c3ludGhldGlj" };
  const payload = { data: JSON.stringify(data), iss: "NIC Sandbox (synthetic)" };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = sign("RSA-SHA256", Buffer.from(input), signingKey());
  return `${input}.${b64url(sig)}`;
}

// ------------------------------------------------------------ lines

function makeLine(item: Item, r: Rng, opts: { gstPct: number; taxType: "CGST_SGST" | "IGST"; inclusive: boolean; hindi: boolean; discount: boolean }): SynthLine {
  const bp = Math.round(opts.gstPct * 100);
  const unit = item.unit;
  const description = opts.hindi ? (r.chance(0.7) ? item.hi : item.en) : item.en;
  const mrpPaise = item.mrp ? item.mrp * 100 : undefined;
  if (opts.inclusive) {
    // Retail/thermal: price printed incl. GST; small quantities so the before-tax rate stays exact enough.
    for (let attempt = 0; attempt < 50; attempt++) {
      const qty = item.loose ? r.int(1, 8) * 250 : r.int(1, 6) * 1000;
      const inclRate = Math.round(rupees(r, item.rate) * (1 + opts.gstPct / 100));
      const amount = Math.round((qty * inclRate) / 1000);
      const taxable = Math.round((amount * 10000) / (10000 + bp));
      const tax = amount - taxable;
      const ratePaise = Math.round((taxable * 1000) / qty);
      const c = computeLine({ qtyMilli: qty, ratePaise, discountPaise: 0, gstRateBp: bp });
      if (Math.abs(c.totalPaise - amount) > 5) continue;
      return { description, hsn: item.hsn, qtyMilli: qty, unit, mrpPaise, ratePaise, printedRatePaise: inclRate, discountPaise: 0, gstRateBp: bp, taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: tax, totalPaise: amount, printedAmountPaise: amount };
    }
    throw new Error("could not build an inclusive line");
  }
  const qty = item.loose ? Math.round((item.qty[0] + r.next() * (item.qty[1] - item.qty[0])) * 2) * 500 : r.int(item.qty[0], item.qty[1]) * 1000;
  const ratePaise = rupees(r, item.rate);
  const gross = Math.round((qty * ratePaise) / 1000);
  let discountPaise = 0;
  let discountPct: number | undefined;
  if (opts.discount) {
    if (r.chance(0.6)) {
      discountPct = r.pick([1, 2, 2.5, 3, 5]);
      discountPaise = Math.round((gross * discountPct) / 100);
    } else discountPaise = r.int(1, 20) * 500;
  }
  const taxable = gross - discountPaise;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (opts.taxType === "IGST") igst = Math.round((taxable * bp) / 10000);
  else {
    cgst = Math.round((taxable * bp) / 20000);
    sgst = cgst;
  }
  const tax = cgst + sgst + igst;
  return { description, hsn: item.hsn, qtyMilli: qty, unit, mrpPaise, ratePaise, printedRatePaise: ratePaise, discountPaise, discountPct, gstRateBp: bp, taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, taxPaise: tax, totalPaise: taxable + tax, printedAmountPaise: taxable + tax };
}

// ------------------------------------------------------------ invoice

export interface MakeOptions {
  seed: number;
  index: number;
  layout?: Layout;
  /** "Today" for dates; fixed by default so outputs are reproducible. */
  today?: string;
  multiPage?: boolean;
}

export function makeInvoice(o: MakeOptions): SynthInvoice {
  const r = new Rng(o.seed * 1000 + o.index + 1);
  const layout = o.layout ?? LAYOUTS[o.index % LAYOUTS.length]!;
  const today = o.today ?? "2026-10-22";
  const outOfState = VENDORS.filter((v) => v.state !== "20");
  const inState = VENDORS.filter((v) => v.state === "20");
  const vendor = layout === "igst" ? r.pick(outOfState) : layout === "thermal" || layout === "hindi" ? r.pick(inState) : r.pick(r.chance(0.8) ? inState : outOfState);
  const vg = vendorGstin(vendor);
  const taxType = vendor.state === "20" ? "CGST_SGST" : "IGST";
  const legacy = layout !== "thermal" && r.chance(0.15);
  const date = legacy ? addDays("2025-09-21", -r.int(0, 60)) : addDays(today, -r.int(1, 40));
  const credit = layout === "credit-note";
  const inclusive = layout === "thermal";
  const hindi = layout === "hindi";
  const multiPage = o.multiPage ?? (layout === "a4-table" && r.chance(0.25));
  const n = multiPage ? r.int(16, 22) : layout === "thermal" ? r.int(3, 9) : credit ? r.int(1, 4) : r.int(4, 12);
  const items = r.sample(ITEMS, n);
  const discountLines = layout === "a4-table" || layout === "igst";
  const lines = items.map((it) => makeLine(it, r, { gstPct: legacy && it.legacyGst !== undefined ? it.legacyGst : it.gst, taxType, inclusive, hindi, discount: discountLines && r.chance(0.35) }));

  const amountIncludesTax = layout === "a4-table" || layout === "igst" || inclusive;
  // Hindi and credit-note layouts print the amount before tax; GST is added in the totals area.
  if (!amountIncludesTax) for (const l of lines) l.printedAmountPaise = l.taxablePaise;

  const taxablePaise = lines.reduce((s, l) => s + l.taxablePaise, 0);
  let cgstPaise = lines.reduce((s, l) => s + l.cgstPaise, 0);
  let sgstPaise = lines.reduce((s, l) => s + l.sgstPaise, 0);
  const igstPaise = lines.reduce((s, l) => s + l.igstPaise, 0);
  if (inclusive) {
    // Thermal bills print the GST split per slab in a summary; split the total tax evenly.
    const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
    cgstPaise = Math.round(tax / 2);
    sgstPaise = tax - cgstPaise;
  }
  const freight = !inclusive && !credit && r.chance(0.3);
  const otherChargesPaise = freight ? r.int(4, 30) * 2500 : 0;
  const discountPaise = !inclusive && !credit && !freight && r.chance(0.15) ? r.int(2, 40) * 500 : 0;
  const exact = lines.reduce((s, l) => s + l.totalPaise, 0) + otherChargesPaise - discountPaise;
  const grandTotalPaise = Math.round(exact / 100) * 100;
  const totals: InvoiceTotals = { taxablePaise, cgstPaise, sgstPaise, igstPaise, otherChargesPaise, discountPaise, roundOffPaise: grandTotalPaise - exact, grandTotalPaise };

  const invoiceNo = invoiceNumber(vendor, date, r, credit);
  const store = r.pick(BUYER.stores);
  const header: SynthInvoice["header"] = { vendorName: vendor.name, sellerGstin: vg, buyerGstin: BUYER_GSTIN, invoiceNo, invoiceDate: date, docType: credit ? "CRN" : "INV" };

  let qr: SynthInvoice["qr"];
  if ((layout === "a4-table" || layout === "igst" || credit) && r.chance(0.45)) {
    const irn = createHash("sha256").update(`${vg}${financialYear(date)}${header.docType}${invoiceNo}`).digest("hex");
    header.irn = irn;
    const [y, m, d] = date.split("-");
    const irnDate = `${date} ${String(r.int(9, 19)).padStart(2, "0")}:${String(r.int(0, 59)).padStart(2, "0")}:00`;
    const mainHsn = [...lines].sort((a, b) => b.taxablePaise - a.taxablePaise)[0]!.hsn;
    const data = { SellerGstin: vg, BuyerGstin: BUYER_GSTIN, DocNo: invoiceNo, DocTyp: header.docType, DocDt: `${d}/${m}/${y}`, TotInvVal: grandTotalPaise / 100, ItemCnt: lines.length, MainHsnCode: mainHsn, Irn: irn, IrnDt: irnDate };
    qr = { jwt: signEInvoiceJwt(data), ackNo: String(1120 + r.int(10_000_000, 99_999_999)) + String(r.int(1000, 9999)), irnDate };
  }

  const perPage = multiPage ? Math.ceil(n / 2) : n;
  const pageBreaks = multiPage ? [perPage, n - perPage] : [n];
  return {
    id: `synth-${o.seed}-${String(o.index).padStart(3, "0")}-${layout}`,
    layout,
    seed: o.seed,
    vendor: { ...vendor, gstin: vg },
    buyer: { name: BUYER.name, gstin: BUYER_GSTIN, store },
    header,
    printedDate: printDate(date, r),
    lines,
    totals,
    otherChargesLabel: freight ? r.pick(FREIGHT_LABELS) : undefined,
    taxType,
    amountIncludesTax,
    rateIncludesTax: inclusive,
    pageBreaks,
    qr,
    againstInvoice: credit ? invoiceNumber(vendor, addDays(date, -r.int(5, 30)), r, false) : undefined,
    legacy,
    generatedOn: today,
  };
}

const rs = (p: number) => p / 100;
/** Truth holds only what is printed: thermal receipts show a 4-digit HSN and no unit. */
const printedHsn = (inv: SynthInvoice, l: SynthLine) => (inv.layout === "thermal" ? l.hsn.slice(0, 4) : l.hsn);
const printedUnit = (inv: SynthInvoice, l: SynthLine) => (inv.layout === "thermal" ? undefined : l.unit);

export function truthOf(inv: SynthInvoice, pages: string[], distortions: string[]): Truth {
  const raw: RawExtraction = {
    header: { ...inv.header },
    lines: inv.lines.map((l) => {
      const out: RawExtraction["lines"][number] = { description: l.description, hsn: printedHsn(inv, l), qty: l.qtyMilli / 1000, unit: printedUnit(inv, l), rate: rs(l.ratePaise), gstRate: l.gstRateBp / 100, taxable: rs(l.taxablePaise), tax: rs(l.taxPaise), amount: rs(l.printedAmountPaise) };
      if (l.mrpPaise !== undefined) out.mrp = rs(l.mrpPaise);
      if (l.discountPaise) out.discount = rs(l.discountPaise);
      return out;
    }),
    amountIncludesTax: inv.amountIncludesTax,
    totals: {
      taxable: rs(inv.totals.taxablePaise),
      cgst: rs(inv.totals.cgstPaise),
      sgst: rs(inv.totals.sgstPaise),
      igst: rs(inv.totals.igstPaise),
      otherCharges: rs(inv.totals.otherChargesPaise),
      discount: rs(inv.totals.discountPaise),
      roundOff: rs(inv.totals.roundOffPaise),
      grandTotal: rs(inv.totals.grandTotalPaise),
    },
  };
  const notes: string[] = [];
  if (inv.rateIncludesTax) notes.push("printed rates include GST; raw.rate is the before-tax rate");
  if (inv.pageBreaks.length > 1) notes.push(`table continues over ${inv.pageBreaks.length} pages with C/F and B/F rows`);
  if (inv.legacy) notes.push("legacy GST slabs (before 22 Sep 2025)");
  return {
    id: inv.id,
    layout: inv.layout,
    dataClass: "synthetic",
    generatedOn: inv.generatedOn,
    seed: inv.seed,
    pages,
    distortions,
    raw,
    expected: {
      header: { ...inv.header },
      totals: { ...inv.totals },
      lines: inv.lines.map((l, idx) => {
        const out: Omit<InvoiceLine, "id" | "meta" | "box"> = { idx, description: l.description, hsn: printedHsn(inv, l), qtyMilli: l.qtyMilli, unit: printedUnit(inv, l), ratePaise: l.ratePaise, discountPaise: l.discountPaise, gstRateBp: l.gstRateBp, taxablePaise: l.taxablePaise, taxPaise: l.taxPaise, totalPaise: l.totalPaise, status: "pending" };
        if (l.mrpPaise !== undefined) out.mrpPaise = l.mrpPaise;
        return out;
      }),
    },
    qr: inv.qr ? { raw: inv.qr.jwt } : undefined,
    printedRates: inv.lines.map((l) => rs(l.printedRatePaise)),
    notes,
  };
}
