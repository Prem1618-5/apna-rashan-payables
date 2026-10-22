/**
 * Draws a realistic printed GST tax invoice as SVG, so the mock has a page image
 * whose line boxes line up exactly with the table rows (line crops on the verify cards).
 */
import type { Box, InvoiceTotals } from "@arad/core";
import { formatBp, formatMilli } from "@arad/core";

export const PAGE_W = 1000;
export const PAGE_H = 1414;
const TABLE_TOP = 404;
const HEAD_H = 38;
const ROW_H = 46;

export interface PaperLine {
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
}

export interface PaperBill {
  vendorName: string;
  vendorAddress: string[];
  vendorPhone?: string;
  sellerGstin?: string;
  buyerName: string;
  buyerAddress: string;
  buyerGstin?: string;
  invoiceNo: string;
  invoiceDate: string;
  docType: "INV" | "CRN" | "DBN";
  lines: PaperLine[];
  totals: InvoiceTotals;
  irn?: string;
  seed: number;
}

/** Where line i sits on the page (normalised 0..1). */
export function rowBox(i: number): Box {
  const y = TABLE_TOP + HEAD_H + i * ROW_H;
  return { page: 0, x: 30 / PAGE_W, y: (y - 2) / PAGE_H, w: 940 / PAGE_W, h: (ROW_H + 4) / PAGE_H };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const amt = (p: number) => {
  const neg = p < 0;
  const a = Math.abs(p);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};
const dmy = (iso: string) => iso.split("-").reverse().join("/");

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function words99(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}
function words999(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? words99(r) : ""].filter(Boolean).join(" ");
}
/** 123456 -> "One Lakh Twenty Three Thousand Four Hundred Fifty Six" (Indian system). */
export function rupeesInWords(rupees: number): string {
  if (rupees === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(rupees / 1_00_00_000);
  const lakh = Math.floor((rupees % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((rupees % 1_00_000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${words999(crore)} Crore`);
  if (lakh) parts.push(`${words99(lakh)} Lakh`);
  if (thousand) parts.push(`${words99(thousand)} Thousand`);
  if (rest) parts.push(words999(rest));
  return parts.join(" ");
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/** A QR-looking block (not decodable) so the page reads like a real e-invoice. */
function fakeQr(x: number, y: number, size: number, seed: number): string {
  const n = 33;
  const c = size / n;
  const r = rng(seed);
  const cells: string[] = [];
  const finder = (fx: number, fy: number) =>
    `<rect x="${x + fx * c}" y="${y + fy * c}" width="${7 * c}" height="${7 * c}" fill="#1d1d1b"/><rect x="${x + (fx + 1) * c}" y="${y + (fy + 1) * c}" width="${5 * c}" height="${5 * c}" fill="#fdfcf8"/><rect x="${x + (fx + 2) * c}" y="${y + (fy + 2) * c}" width="${3 * c}" height="${3 * c}" fill="#1d1d1b"/>`;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const inFinder = (i < 8 && j < 8) || (i < 8 && j > n - 9) || (i > n - 9 && j < 8);
      if (!inFinder && r() > 0.52) cells.push(`M${(x + j * c).toFixed(1)} ${(y + i * c).toFixed(1)}h${c.toFixed(2)}v${c.toFixed(2)}h-${c.toFixed(2)}z`);
    }
  return `<path d="${cells.join("")}" fill="#1d1d1b"/>${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}`;
}

export function invoiceSvg(b: PaperBill): string {
  const t = b.totals;
  const sameState = t.igstPaise === 0;
  const title = b.docType === "CRN" ? "CREDIT NOTE" : b.docType === "DBN" ? "DEBIT NOTE" : "TAX INVOICE";
  const o: string[] = [];
  const text = (x: number, y: number, s: string, a = "") => o.push(`<text x="${x}" y="${y}" ${a}>${esc(s)}</text>`);

  o.push(`<rect width="${PAGE_W}" height="${PAGE_H}" fill="#fdfcf8"/>`);
  o.push(`<rect x="24" y="24" width="${PAGE_W - 48}" height="${PAGE_H - 48}" fill="none" stroke="#2b2b28" stroke-width="2"/>`);
  // Seller
  text(50, 82, b.vendorName.toUpperCase(), 'font-size="32" font-weight="700" font-family="Liberation Serif, Georgia, serif"');
  b.vendorAddress.forEach((l, i) => text(50, 114 + i * 24, l, 'font-size="17"'));
  let y = 114 + b.vendorAddress.length * 24;
  if (b.vendorPhone) text(50, y, `Ph: ${b.vendorPhone}`, 'font-size="17"'), (y += 24);
  if (b.sellerGstin) text(50, y, `GSTIN: ${b.sellerGstin}`, 'font-size="18" font-weight="700"');
  // Title block
  o.push(`<rect x="660" y="48" width="292" height="44" fill="#2b2b28"/>`);
  text(806, 78, title, 'font-size="22" font-weight="700" fill="#fdfcf8" text-anchor="middle" letter-spacing="2"');
  text(670, 124, "Invoice No", 'font-size="16" fill="#555"');
  text(950, 124, b.invoiceNo, 'font-size="18" font-weight="700" text-anchor="end"');
  text(670, 152, "Date", 'font-size="16" fill="#555"');
  text(950, 152, dmy(b.invoiceDate), 'font-size="18" font-weight="700" text-anchor="end"');
  text(670, 180, "Place of supply", 'font-size="16" fill="#555"');
  text(950, 180, "Jharkhand (20)", 'font-size="16" text-anchor="end"');
  // Buyer
  o.push(`<line x1="24" y1="236" x2="${PAGE_W - 24}" y2="236" stroke="#2b2b28" stroke-width="1.5"/>`);
  text(50, 266, "Bill to", 'font-size="15" fill="#555"');
  text(50, 294, b.buyerName, 'font-size="20" font-weight="700"');
  text(50, 320, b.buyerAddress, 'font-size="16"');
  if (b.buyerGstin) text(50, 346, `GSTIN: ${b.buyerGstin}`, 'font-size="17" font-weight="700"');
  text(950, 294, "Transport: Own vehicle", 'font-size="15" text-anchor="end" fill="#555"');
  text(950, 320, "Terms: as agreed", 'font-size="15" text-anchor="end" fill="#555"');

  // Table
  const cols = { sn: 44, desc: 80, hsn: 394, qty: 520, unit: 528, mrp: 646, rate: 744, disc: 820, gst: 878, amt: 958 };
  const top = TABLE_TOP;
  o.push(`<rect x="30" y="${top}" width="940" height="${HEAD_H}" fill="#ecebe6" stroke="#2b2b28" stroke-width="1.5"/>`);
  const th = 'font-size="15" font-weight="700"';
  text(cols.sn, top + 25, "#", th);
  text(cols.desc, top + 25, "Description of goods", th);
  text(cols.hsn, top + 25, "HSN", th);
  text(cols.qty, top + 25, "Qty", `${th} text-anchor="end"`);
  text(cols.unit, top + 25, "Unit", th);
  text(cols.mrp, top + 25, "MRP", `${th} text-anchor="end"`);
  text(cols.rate, top + 25, "Rate", `${th} text-anchor="end"`);
  text(cols.disc, top + 25, "Disc", `${th} text-anchor="end"`);
  text(cols.gst, top + 25, "GST", `${th} text-anchor="end"`);
  text(cols.amt, top + 25, "Amount", `${th} text-anchor="end"`);
  const monoFont = 'font-family="DejaVu Sans Mono, Courier New, monospace"';
  const mono = `${monoFont} font-size="17"`;
  b.lines.forEach((l, i) => {
    const ry = top + HEAD_H + i * ROW_H;
    const base = ry + 29;
    if (i % 2 === 1) o.push(`<rect x="30" y="${ry}" width="940" height="${ROW_H}" fill="#f5f4ef"/>`);
    text(cols.sn, base, String(i + 1), 'font-size="17"');
    text(cols.desc, base, l.description.length > 30 ? `${l.description.slice(0, 29)}.` : l.description, 'font-size="17"');
    text(cols.hsn, base, l.hsn ?? "", mono);
    text(cols.qty, base, formatMilli(l.qtyMilli), `${mono} text-anchor="end"`);
    text(cols.unit, base, l.unit ?? "", 'font-size="15"');
    text(cols.mrp, base, l.mrpPaise ? amt(l.mrpPaise) : "", `${mono} text-anchor="end"`);
    text(cols.rate, base, amt(l.ratePaise), `${mono} text-anchor="end"`);
    text(cols.disc, base, l.discountPaise ? amt(l.discountPaise) : "-", `${mono} text-anchor="end"`);
    text(cols.gst, base, formatBp(l.gstRateBp), `${mono} text-anchor="end"`);
    text(cols.amt, base, amt(l.totalPaise), `${mono} text-anchor="end" font-weight="700"`);
  });
  const tableBottom = top + HEAD_H + Math.max(b.lines.length, 6) * ROW_H;
  o.push(`<rect x="30" y="${top}" width="940" height="${tableBottom - top}" fill="none" stroke="#2b2b28" stroke-width="1.5"/>`);
  for (const x of [72, 386, 450, 584, 656, 752, 828, 886]) o.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${tableBottom}" stroke="#2b2b28" stroke-width=".8"/>`);

  // Totals
  let ty = tableBottom + 40;
  const row = (label: string, value: string, bold = false) => {
    text(640, ty, label, `font-size="17" ${bold ? 'font-weight="700"' : 'fill="#333"'}`);
    text(958, ty, value, `${monoFont} text-anchor="end" ${bold ? 'font-weight="700" font-size="21"' : 'font-size="17"'}`);
    ty += bold ? 38 : 30;
  };
  row("Taxable value", amt(t.taxablePaise));
  if (sameState) {
    row("CGST", amt(t.cgstPaise));
    row("SGST", amt(t.sgstPaise));
  } else row("IGST", amt(t.igstPaise));
  if (t.otherChargesPaise) row("Freight", amt(t.otherChargesPaise));
  if (t.discountPaise) row("Cash discount", `-${amt(t.discountPaise)}`);
  row("Round off", amt(t.roundOffPaise));
  o.push(`<line x1="630" y1="${ty - 22}" x2="966" y2="${ty - 22}" stroke="#2b2b28" stroke-width="1.5"/>`);
  ty += 6;
  row("GRAND TOTAL", `Rs ${amt(t.grandTotalPaise)}`, true);
  o.push(`<line x1="630" y1="${ty - 26}" x2="966" y2="${ty - 26}" stroke="#2b2b28" stroke-width="1.5"/>`);

  // Words + QR + signature
  const ly = tableBottom + 40;
  text(50, ly, "Amount in words:", 'font-size="15" fill="#555"');
  const words = `Rupees ${rupeesInWords(Math.round(Math.abs(t.grandTotalPaise) / 100))} Only`;
  const chunks = words.match(/.{1,46}(\s|$)/g) ?? [words];
  chunks.forEach((c, i) => text(50, ly + 26 + i * 22, c.trim(), 'font-size="16" font-style="italic"'));
  if (b.irn) {
    const qy = ly + 40 + chunks.length * 22;
    o.push(fakeQr(50, qy, 170, b.seed));
    text(236, qy + 20, "e-Invoice", 'font-size="15" font-weight="700"');
    text(236, qy + 44, "IRN:", 'font-size="13" fill="#555"');
    text(236, qy + 64, b.irn.slice(0, 32), 'font-size="12" font-family="DejaVu Sans Mono, monospace"');
    text(236, qy + 82, b.irn.slice(32), 'font-size="12" font-family="DejaVu Sans Mono, monospace"');
  }
  text(958, PAGE_H - 120, `For ${b.vendorName}`, 'font-size="16" text-anchor="end"');
  o.push(`<path d="M790 ${PAGE_H - 92} c20 -26 34 8 52 -10 s26 -18 40 4 s22 10 38 -6" fill="none" stroke="#2a4a9a" stroke-width="2.2"/>`);
  text(958, PAGE_H - 56, "Authorised Signatory", 'font-size="15" text-anchor="end" fill="#555"');
  text(50, PAGE_H - 56, "Goods once sold will not be taken back. Subject to Ranchi jurisdiction.", 'font-size="13" fill="#777"');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_W} ${PAGE_H}" width="${PAGE_W}" height="${PAGE_H}" font-family="Liberation Sans, Arial, Helvetica, sans-serif" fill="#1d1d1b">${o.join("")}</svg>`;
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
