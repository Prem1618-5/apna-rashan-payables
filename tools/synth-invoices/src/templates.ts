/** HTML/CSS templates for the synthetic invoice layouts. Each returns one HTML document per page. */

import { STATE_CODES, formatInr, formatMilli } from "@arad/core";
import type { SynthInvoice, SynthLine } from "./model.js";
import type { Rng } from "./rng.js";

export interface RenderedPages {
  /** CSS pixel width of the page. */
  width: number;
  pages: string[];
}

const inr = (p: number) => formatInr(p, { symbol: false });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const qtyText = (m: number) => (m % 1000 === 0 ? String(m / 1000) : formatMilli(m));
const pct = (bp: number) => `${bp / 100}%`;

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function two(n: number): string {
  return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}
function three(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? two(r) : ""].filter(Boolean).join(" ");
}
/** Indian numbering: 3,08,000 -> "Three Lakh Eight Thousand". */
export function amountInWords(paise: number): string {
  let n = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  if (crore) parts.push(`${two(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  const rupees = parts.join(" ") || "Zero";
  return `Rupees ${rupees}${p ? ` and ${two(p)} Paise` : ""} Only`;
}

const DOC = (css: string, body: string, width: number) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff}
body{width:${width}px;color:#111;-webkit-font-smoothing:antialiased}
table{border-collapse:collapse;width:100%}
.r{text-align:right}.c{text-align:center}.b{font-weight:700}
.scribble{position:absolute;color:#1d3fa8;font-family:"FreeSerif",serif;font-style:italic;opacity:.85;pointer-events:none}
${css}
</style></head><body>${body}</body></html>`;

function scribbles(r: Rng, width: number, height: number): string {
  const out: string[] = [];
  if (r.chance(0.5)) {
    const x = r.int(Math.round(width * 0.55), Math.round(width * 0.8));
    const y = r.int(Math.round(height * 0.05), Math.round(height * 0.2));
    out.push(`<div class="scribble" style="left:${x}px;top:${y}px;font-size:${r.int(18, 26)}px;transform:rotate(${r.int(-14, 8)}deg)">${r.pick(["Recd. OK", "chk", "Pd?", "ok - RK", "Entry done"])}</div>`);
  }
  if (r.chance(0.5)) {
    const x = r.int(Math.round(width * 0.1), Math.round(width * 0.4));
    const y = r.int(Math.round(height * 0.75), Math.round(height * 0.92));
    out.push(`<svg class="scribble" style="left:${x}px;top:${y}px" width="160" height="50" viewBox="0 0 160 50"><path d="M5 35 C 25 5, 35 45, 55 20 S 85 40, 100 15 S 135 35, 155 22" stroke="#1d3fa8" stroke-width="2.2" fill="none"/></svg>`);
  }
  return out.join("");
}

function qrImg(dataUrl: string | undefined, size: number): string {
  return dataUrl ? `<img src="${dataUrl}" width="${size}" height="${size}" style="display:block"/>` : "";
}

/** Split lines into pages; returns the running totals carried forward at each break. */
function paginate(inv: SynthInvoice) {
  const pages: { lines: SynthLine[]; start: number; bfTaxable: number; bfAmount: number }[] = [];
  let i = 0;
  let taxable = 0;
  let amount = 0;
  for (const n of inv.pageBreaks) {
    const lines = inv.lines.slice(i, i + n);
    pages.push({ lines, start: i, bfTaxable: taxable, bfAmount: amount });
    for (const l of lines) {
      taxable += l.taxablePaise;
      amount += l.printedAmountPaise;
    }
    i += n;
  }
  return pages;
}

/** Per-slab tax summary rows. */
function slabs(inv: SynthInvoice) {
  const m = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of inv.lines) {
    const s = m.get(l.gstRateBp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    s.taxable += l.taxablePaise;
    s.cgst += l.cgstPaise;
    s.sgst += l.sgstPaise;
    s.igst += l.igstPaise;
    m.set(l.gstRateBp, s);
  }
  if (inv.rateIncludesTax) {
    // Thermal: split each slab's tax evenly, last slab takes the remainder so totals match.
    const entries = [...m.entries()];
    let cg = 0;
    entries.forEach(([bp, s], k) => {
      const tax = inv.lines.filter((l) => l.gstRateBp === bp).reduce((a, l) => a + l.taxPaise, 0);
      s.cgst = k === entries.length - 1 ? inv.totals.cgstPaise - cg : Math.round(tax / 2);
      cg += s.cgst;
      s.sgst = tax - s.cgst;
    });
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

function totalsRows(inv: SynthInvoice, labels: { taxable: string; cgst: string; sgst: string; igst: string; other: string; disc: string; ro: string; grand: string }): string {
  const t = inv.totals;
  const rows: [string, number, boolean?][] = [[labels.taxable, t.taxablePaise]];
  if (inv.taxType === "IGST") rows.push([labels.igst, t.igstPaise]);
  else rows.push([labels.cgst, t.cgstPaise], [labels.sgst, t.sgstPaise]);
  if (t.otherChargesPaise) rows.push([inv.otherChargesLabel ?? labels.other, t.otherChargesPaise]);
  if (t.discountPaise) rows.push([labels.disc, -t.discountPaise]);
  rows.push([labels.ro, t.roundOffPaise], [labels.grand, t.grandTotalPaise, true]);
  return rows.map(([k, v, big]) => `<tr${big ? ' class="grand"' : ""}><td>${esc(k)}</td><td class="r">${v < 0 ? "-" : ""}${inr(Math.abs(v))}</td></tr>`).join("");
}

// ------------------------------------------------------------------ A4 distributor (CGST+SGST or IGST)

export function a4Table(inv: SynthInvoice, r: Rng, qr?: string): RenderedPages {
  const W = 794;
  const igst = inv.taxType === "IGST";
  const css = `
body{font-family:"Liberation Sans",Arial,sans-serif;font-size:11px}
.page{position:relative;padding:28px 30px;min-height:1123px}
.top{display:flex;justify-content:space-between;border-bottom:2px solid #222;padding-bottom:8px}
.vname{font-size:22px;font-weight:700;letter-spacing:.3px}
.title{margin:8px 0;text-align:center;font-size:15px;font-weight:700;border:1px solid #333;padding:3px}
.meta td{padding:2px 4px;vertical-align:top}
.party{display:flex;gap:12px;margin:6px 0 10px}
.party>div{flex:1;border:1px solid #999;padding:6px}
.items th{background:#eee;border:1px solid #777;padding:4px 3px;font-size:10px}
.items td{border-left:1px solid #777;border-right:1px solid #777;padding:4px 3px}
.items tr.last td{border-bottom:1px solid #777}
.items tr.cf td{border-top:1px solid #777;font-style:italic;font-weight:700}
.sum{display:flex;gap:12px;margin-top:10px}
.slab th,.slab td{border:1px solid #999;padding:3px}
.tot td{padding:3px 6px;border-bottom:1px dotted #aaa}
.tot tr.grand td{font-size:15px;font-weight:700;border-top:2px solid #222;border-bottom:2px solid #222}
.foot{margin-top:24px;display:flex;justify-content:space-between}
`;
  const pages = paginate(inv);
  const out: string[] = [];
  const head = (pageNo: number) => `
  <div class="top"><div><div class="vname">${esc(inv.vendor.name)}</div><div>${esc(inv.vendor.address)}</div><div>Ph: ${esc(inv.vendor.phone)} &nbsp; State: ${esc(STATE_CODES[inv.vendor.state] ?? "")} (${inv.vendor.state})</div><div class="b">GSTIN: ${inv.vendor.gstin}</div></div>
  <div style="text-align:right">${pageNo === 0 ? qrImg(qr, 120) : ""}${pages.length > 1 ? `<div>Page ${pageNo + 1} of ${pages.length}</div>` : ""}</div></div>`;
  pages.forEach((pg, pi) => {
    const first = pi === 0;
    const last = pi === pages.length - 1;
    let body = `<div class="page">${head(pi)}`;
    if (first) {
      body += `<div class="title">TAX INVOICE</div>
      <table class="meta"><tr><td><b>Invoice No:</b> ${esc(inv.header.invoiceNo)}</td><td><b>Invoice Date:</b> ${esc(inv.printedDate)}</td><td><b>Place of Supply:</b> Jharkhand (20)</td></tr>
      ${inv.header.irn ? `<tr><td colspan="3" style="font-size:9px"><b>IRN:</b> ${inv.header.irn} &nbsp; <b>Ack No:</b> ${inv.qr?.ackNo ?? ""}</td></tr>` : ""}</table>
      <div class="party"><div><b>Bill To:</b><br>${esc(inv.buyer.store.name)}<br>${esc(inv.buyer.store.address)}<br><b>GSTIN:</b> ${inv.buyer.gstin}</div>
      <div><b>Ship To:</b><br>${esc(inv.buyer.store.name)}<br>${esc(inv.buyer.store.address)}<br>Vehicle: JH01${r.pick(["AB", "CD", "EF", "BK"])}${r.int(1000, 9999)}</div></div>`;
    } else {
      body += `<div style="margin:8px 0"><b>Invoice No:</b> ${esc(inv.header.invoiceNo)} &nbsp; <b>Date:</b> ${esc(inv.printedDate)} &nbsp; (continued)</div>`;
    }
    const cols = igst
      ? ["S.No", "Description of Goods", "HSN", "Qty", "Unit", "MRP", "Rate", "Disc", "Taxable", "IGST %", "IGST Amt", "Amount"]
      : ["S.No", "Description of Goods", "HSN", "Qty", "Unit", "MRP", "Rate", "Disc", "Taxable", "GST %", "CGST", "SGST", "Amount"];
    body += `<table class="items"><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`;
    if (!first) body += `<tr class="cf"><td></td><td>B/F (Brought Forward)</td><td colspan="${igst ? 6 : 6}"></td><td class="r">${inr(pg.bfTaxable)}</td><td colspan="${igst ? 2 : 3}"></td><td class="r">${inr(pg.bfAmount)}</td></tr>`;
    pg.lines.forEach((l, k) => {
      const disc = l.discountPct !== undefined ? `${l.discountPct}%` : l.discountPaise ? inr(l.discountPaise) : "";
      const isLast = k === pg.lines.length - 1 && last;
      body += `<tr${isLast ? ' class="last"' : ""}><td class="c">${pg.start + k + 1}</td><td>${esc(l.description)}</td><td>${l.hsn}</td><td class="r">${qtyText(l.qtyMilli)}</td><td>${l.unit}</td><td class="r">${l.mrpPaise ? inr(l.mrpPaise) : ""}</td><td class="r">${inr(l.printedRatePaise)}</td><td class="r">${disc}</td><td class="r">${inr(l.taxablePaise)}</td><td class="c">${pct(l.gstRateBp)}</td>${igst ? `<td class="r">${inr(l.igstPaise)}</td>` : `<td class="r">${inr(l.cgstPaise)}</td><td class="r">${inr(l.sgstPaise)}</td>`}<td class="r">${inr(l.printedAmountPaise)}</td></tr>`;
    });
    if (!last) {
      const cfT = pg.bfTaxable + pg.lines.reduce((s, l) => s + l.taxablePaise, 0);
      const cfA = pg.bfAmount + pg.lines.reduce((s, l) => s + l.printedAmountPaise, 0);
      body += `<tr class="cf"><td></td><td>C/F (Carried Forward)</td><td colspan="6"></td><td class="r">${inr(cfT)}</td><td colspan="${igst ? 2 : 3}"></td><td class="r">${inr(cfA)}</td></tr></table><div style="margin-top:8px;text-align:right;font-style:italic">Continued on next page ...</div>`;
    } else {
      body += `</table><div class="sum"><div style="flex:1.3"><table class="slab"><tr><th>GST %</th><th>Taxable</th>${igst ? "<th>IGST</th>" : "<th>CGST</th><th>SGST</th>"}</tr>${slabs(inv)
        .map(([bp, s]) => `<tr><td class="c">${pct(bp)}</td><td class="r">${inr(s.taxable)}</td>${igst ? `<td class="r">${inr(s.igst)}</td>` : `<td class="r">${inr(s.cgst)}</td><td class="r">${inr(s.sgst)}</td>`}</tr>`)
        .join("")}</table><p style="margin-top:8px"><b>Amount in words:</b> ${amountInWords(inv.totals.grandTotalPaise)}</p></div>
      <div style="flex:1"><table class="tot">${totalsRows(inv, { taxable: "Taxable Value", cgst: "CGST", sgst: "SGST", igst: "IGST", other: "Freight", disc: "Less: Scheme Discount", ro: "Round Off", grand: "Grand Total" })}</table></div></div>
      <div class="foot"><div style="font-size:9px">E.&amp;O.E. Goods once sold will not be taken back.<br>Subject to ${esc(inv.vendor.city)} jurisdiction.</div><div style="text-align:center">For ${esc(inv.vendor.name)}<br><br><br>Authorised Signatory</div></div>`;
    }
    body += `${scribbles(r, W, 1123)}</div>`;
    out.push(DOC(css, body, W));
  });
  return { width: W, pages: out };
}

// ------------------------------------------------------------------ IGST, boxed serif style (out-of-state vendor)

export function igstBoxed(inv: SynthInvoice, r: Rng, qr?: string): RenderedPages {
  const W = 794;
  const css = `
body{font-family:"Liberation Serif","Times New Roman",serif;font-size:12px}
.page{position:relative;padding:24px;min-height:1123px}
.frame{border:1.5px solid #000}
.hdr{display:grid;grid-template-columns:1fr 150px;border-bottom:1.5px solid #000}
.hdr>div{padding:8px}
.v{font-size:20px;font-weight:700;text-transform:uppercase}
.doc{display:grid;grid-template-columns:1fr 1fr;border-bottom:1.5px solid #000}
.doc>div{padding:6px 8px}.doc>div+div{border-left:1px solid #000}
.items th{border:1px solid #000;padding:4px;font-size:11px;background:#f3f3f3}
.items td{border-left:1px solid #000;border-right:1px solid #000;padding:5px 4px}
.items tr:last-child td{border-bottom:1px solid #000}
.tot td{padding:4px 8px;border-top:1px solid #000}
.tot tr.grand td{font-weight:700;font-size:15px}
`;
  const rows = inv.lines
    .map((l, i) => `<tr><td class="c">${i + 1}</td><td>${esc(l.description)}</td><td class="c">${l.hsn}</td><td class="r">${qtyText(l.qtyMilli)} ${l.unit}</td><td class="r">${inr(l.printedRatePaise)}</td><td class="r">${l.discountPct !== undefined ? `${l.discountPct}%` : l.discountPaise ? inr(l.discountPaise) : "-"}</td><td class="r">${inr(l.taxablePaise)}</td><td class="c">${pct(l.gstRateBp)}</td><td class="r">${inr(l.igstPaise)}</td><td class="r">${inr(l.printedAmountPaise)}</td></tr>`)
    .join("");
  const body = `<div class="page"><div class="frame">
  <div class="hdr"><div><div class="v">${esc(inv.vendor.name)}</div><div>${esc(inv.vendor.address)}</div><div>GSTIN/UIN: <b>${inv.vendor.gstin}</b> &nbsp; State Code: ${inv.vendor.state} (${esc(STATE_CODES[inv.vendor.state] ?? "")})</div></div><div>${qrImg(qr, 132)}</div></div>
  <div style="text-align:center;font-weight:700;padding:4px;border-bottom:1.5px solid #000">TAX INVOICE &nbsp;<span style="font-weight:400">(ORIGINAL FOR RECIPIENT)</span></div>
  ${inv.header.irn ? `<div style="font-size:10px;padding:4px 8px;border-bottom:1px solid #000">IRN: ${inv.header.irn}<br>Ack No.: ${inv.qr?.ackNo} &nbsp; Ack Date: ${inv.qr?.irnDate}</div>` : ""}
  <div class="doc"><div>Invoice No.: <b>${esc(inv.header.invoiceNo)}</b><br>Dated: <b>${esc(inv.printedDate)}</b><br>Mode of Transport: Road</div><div>Buyer (Bill to):<br><b>${esc(inv.buyer.name)}</b> (${esc(inv.buyer.store.name.split(" - ")[1] ?? "")})<br>${esc(inv.buyer.store.address)}<br>GSTIN/UIN: <b>${inv.buyer.gstin}</b> &nbsp; Place of Supply: Jharkhand (20)</div></div>
  <table class="items"><tr><th>#</th><th>Particulars</th><th>HSN/SAC</th><th>Quantity</th><th>Rate</th><th>Disc</th><th>Taxable Value</th><th>IGST Rate</th><th>IGST Amt</th><th>Total</th></tr>${rows}</table>
  <div style="display:grid;grid-template-columns:1fr 280px"><div style="padding:8px">Amount Chargeable (in words):<br><b>INR ${amountInWords(inv.totals.grandTotalPaise).replace(/^Rupees /, "")}</b><br><br>Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</div>
  <table class="tot">${totalsRows(inv, { taxable: "Total Taxable Value", cgst: "CGST", sgst: "SGST", igst: "Add: IGST", other: "Freight", disc: "Less: Discount", ro: "Rounded Off", grand: "TOTAL" })}</table></div>
  <div style="text-align:right;padding:16px 8px 8px">for ${esc(inv.vendor.name)}<br><br><br>Authorised Signatory</div>
  </div>${scribbles(r, W, 1123)}</div>`;
  return { width: W, pages: [DOC(css, body, W)] };
}

// ------------------------------------------------------------------ thermal receipt (GST-inclusive rates)

export function thermal(inv: SynthInvoice, r: Rng): RenderedPages {
  const W = 302;
  const css = `
body{font-family:"DejaVu Sans Mono","Liberation Mono",monospace;font-size:11px;line-height:1.35}
.page{position:relative;padding:12px 10px 30px}
.c{text-align:center}.hr{border-top:1px dashed #000;margin:5px 0}
td{padding:1px 0;vertical-align:top}
.big{font-size:14px;font-weight:700}
`;
  const time = `${String(r.int(9, 21)).padStart(2, "0")}:${String(r.int(0, 59)).padStart(2, "0")}`;
  const items = inv.lines
    .map((l) => `<tr><td colspan="4">${esc(l.description)}</td></tr><tr><td>${l.hsn.slice(0, 4)}</td><td class="r">${qtyText(l.qtyMilli)}</td><td class="r">${inr(l.printedRatePaise)}</td><td class="r">${inr(l.printedAmountPaise)}</td></tr><tr><td colspan="4" style="font-size:9px">GST ${pct(l.gstRateBp)}${l.mrpPaise ? ` MRP ${inr(l.mrpPaise)}` : ""}</td></tr>`)
    .join("");
  const slab = slabs(inv)
    .map(([bp, s]) => `<tr><td>${pct(bp)}</td><td class="r">${inr(s.taxable)}</td><td class="r">${inr(s.cgst)}</td><td class="r">${inr(s.sgst)}</td></tr>`)
    .join("");
  const t = inv.totals;
  const itemsSum = inv.lines.reduce((s, l) => s + l.printedAmountPaise, 0);
  const body = `<div class="page">
  <div class="c big">${esc(inv.vendor.name.toUpperCase())}</div>
  <div class="c">${esc(inv.vendor.address)}</div><div class="c">Ph ${esc(inv.vendor.phone)}</div><div class="c">GSTIN: ${inv.vendor.gstin}</div>
  <div class="hr"></div><div class="c b">TAX INVOICE</div>
  <div>Bill No: ${esc(inv.header.invoiceNo)}</div><div>Date: ${esc(inv.printedDate)} ${time}</div>
  <div>To: ${esc(inv.buyer.store.name)}</div><div>GSTIN: ${inv.buyer.gstin}</div>
  <div class="hr"></div>
  <table><tr><td>HSN</td><td class="r">Qty</td><td class="r">Rate</td><td class="r">Amt</td></tr></table><div class="hr"></div>
  <table>${items}</table>
  <div class="hr"></div>
  <table><tr><td>Items: ${inv.lines.length}</td><td class="r">Total</td><td class="r">${inr(itemsSum)}</td></tr>
  <tr><td></td><td class="r">Round Off</td><td class="r">${t.roundOffPaise < 0 ? "-" : ""}${inr(Math.abs(t.roundOffPaise))}</td></tr>
  <tr><td></td><td class="r big">NET AMT</td><td class="r big">${inr(t.grandTotalPaise)}</td></tr></table>
  <div class="hr"></div>
  <div class="c">GST SUMMARY (Rates incl. of GST)</div>
  <table><tr><td>GST%</td><td class="r">Taxable</td><td class="r">CGST</td><td class="r">SGST</td></tr>${slab}
  <tr><td class="b">Total</td><td class="r b">${inr(t.taxablePaise)}</td><td class="r b">${inr(t.cgstPaise)}</td><td class="r b">${inr(t.sgstPaise)}</td></tr></table>
  <div class="hr"></div><div class="c">Thank you! Visit again</div>
  ${r.chance(0.5) ? `<div class="scribble" style="left:${r.int(140, 200)}px;top:${r.int(90, 160)}px;font-size:20px;transform:rotate(${r.int(-20, 5)}deg)">ok</div>` : ""}
  </div>`;
  return { width: W, pages: [DOC(css, body, W)] };
}

// ------------------------------------------------------------------ Hindi + English labels (amounts before tax)

export function hindi(inv: SynthInvoice, r: Rng): RenderedPages {
  const W = 794;
  const css = `
body{font-family:"FreeSans","Liberation Sans",sans-serif;font-size:12px}
.page{position:relative;padding:30px 34px;min-height:1000px}
.v{font-size:24px;font-weight:700;color:#7a1010;text-align:center}
.sub{text-align:center}
.t{margin:10px auto;text-align:center;font-size:16px;font-weight:700;border-top:1px solid #7a1010;border-bottom:1px solid #7a1010;padding:3px}
.items th{border:1px solid #444;background:#fbefe0;padding:5px 4px;font-size:11px}
.items td{border:1px solid #bbb;padding:5px 4px}
.tot{width:340px;margin-left:auto;margin-top:10px}
.tot td{padding:4px 6px;border-bottom:1px solid #ddd}
.tot tr.grand td{font-weight:700;font-size:15px;background:#fbefe0}
`;
  const rows = inv.lines.map((l, i) => `<tr><td class="c">${i + 1}</td><td>${esc(l.description)}</td><td class="c">${l.hsn}</td><td class="r">${qtyText(l.qtyMilli)}</td><td class="c">${l.unit}</td><td class="r">${inr(l.printedRatePaise)}</td><td class="c">${pct(l.gstRateBp)}</td><td class="r">${inr(l.printedAmountPaise)}</td></tr>`).join("");
  const body = `<div class="page">
  <div class="sub">|| श्री गणेशाय नमः ||</div>
  <div class="v">${esc(inv.vendor.name)}</div>
  <div class="sub">${esc(inv.vendor.address)} &nbsp; मो. ${esc(inv.vendor.phone)}</div>
  <div class="sub"><b>जीएसटीआईएन / GSTIN: ${inv.vendor.gstin}</b></div>
  <div class="t">कर बीजक / TAX INVOICE</div>
  <table><tr><td>बिल संख्या / Bill No.: <b>${esc(inv.header.invoiceNo)}</b></td><td class="r">दिनांक / Date: <b>${esc(inv.printedDate)}</b></td></tr>
  <tr><td colspan="2" style="padding-top:6px">क्रेता / Buyer: <b>${esc(inv.buyer.store.name)}</b>, ${esc(inv.buyer.store.address)}<br>क्रेता GSTIN: <b>${inv.buyer.gstin}</b> &nbsp; राज्य / State: झारखंड (20)</td></tr></table>
  <table class="items" style="margin-top:10px"><tr><th>क्र.</th><th>सामान का विवरण / Item</th><th>HSN</th><th>मात्रा / Qty</th><th>इकाई</th><th>दर / Rate</th><th>GST%</th><th>राशि / Amount</th></tr>${rows}</table>
  <table class="tot">${totalsRows(inv, { taxable: "कर योग्य राशि / Taxable", cgst: "सी.जी.एस.टी / CGST", sgst: "एस.जी.एस.टी / SGST", igst: "आई.जी.एस.टी / IGST", other: "भाड़ा / Freight", disc: "छूट / Discount", ro: "राउंड ऑफ / Round Off", grand: "कुल राशि / Grand Total" })}</table>
  <p style="margin-top:10px">शब्दों में / In words: ${amountInWords(inv.totals.grandTotalPaise)}</p>
  <div style="display:flex;justify-content:space-between;margin-top:40px"><div>ग्राहक के हस्ताक्षर</div><div>कृते ${esc(inv.vendor.name)}<br><br>हस्ताक्षर</div></div>
  ${scribbles(r, W, 1000)}</div>`;
  return { width: W, pages: [DOC(css, body, W)] };
}

// ------------------------------------------------------------------ credit note

export function creditNote(inv: SynthInvoice, r: Rng, qr?: string): RenderedPages {
  const W = 794;
  const igst = inv.taxType === "IGST";
  const css = `
body{font-family:"Carlito","Liberation Sans",sans-serif;font-size:12px}
.page{position:relative;padding:32px;min-height:900px}
.band{background:#1f3b57;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center}
.band .v{font-size:20px;font-weight:700}
.t{font-size:22px;font-weight:700;letter-spacing:2px;color:#1f3b57;margin:12px 0}
.items th{background:#dfe8f1;padding:5px;border-bottom:2px solid #1f3b57;font-size:11px}
.items td{padding:5px;border-bottom:1px solid #ccd}
.tot{width:320px;margin-left:auto;margin-top:10px}
.tot td{padding:4px 6px}
.tot tr.grand td{font-weight:700;font-size:15px;border-top:2px solid #1f3b57}
`;
  const rows = inv.lines.map((l, i) => `<tr><td class="c">${i + 1}</td><td>${esc(l.description)}</td><td>${l.hsn}</td><td class="r">${qtyText(l.qtyMilli)} ${l.unit}</td><td class="r">${inr(l.printedRatePaise)}</td><td class="c">${pct(l.gstRateBp)}</td><td class="r">${inr(l.printedAmountPaise)}</td></tr>`).join("");
  const reason = r.pick(["Goods returned - damaged in transit", "Expired stock returned", "Rate difference (scheme)", "Short supply"]);
  const body = `<div class="page">
  <div class="band"><div><div class="v">${esc(inv.vendor.name)}</div><div>${esc(inv.vendor.address)}</div><div>GSTIN: ${inv.vendor.gstin}</div></div><div style="background:#fff;padding:4px">${qrImg(qr, 110)}</div></div>
  <div class="t">CREDIT NOTE</div>
  <table><tr><td>Credit Note No: <b>${esc(inv.header.invoiceNo)}</b></td><td class="r">Date: <b>${esc(inv.printedDate)}</b></td></tr>
  <tr><td>Against Invoice No: ${esc(inv.againstInvoice ?? "")}</td><td class="r">Reason: ${esc(reason)}</td></tr>
  <tr><td colspan="2" style="padding-top:6px">Issued to: <b>${esc(inv.buyer.name)}</b>, ${esc(inv.buyer.store.address)} &nbsp; GSTIN: <b>${inv.buyer.gstin}</b></td></tr>
  ${inv.header.irn ? `<tr><td colspan="2" style="font-size:9px">IRN: ${inv.header.irn}</td></tr>` : ""}</table>
  <table class="items" style="margin-top:12px"><tr><th>S.No</th><th>Description</th><th>HSN</th><th>Qty</th><th>Rate</th><th>GST %</th><th>Taxable Amount</th></tr>${rows}</table>
  <table class="tot">${totalsRows(inv, { taxable: "Taxable Amount", cgst: "CGST", sgst: "SGST", igst: "IGST", other: "Other", disc: "Discount", ro: "Round Off", grand: "Total Credit" })}</table>
  <p style="margin-top:12px">${amountInWords(inv.totals.grandTotalPaise)}</p>
  <div style="text-align:right;margin-top:40px">For ${esc(inv.vendor.name)}<br><br>Authorised Signatory</div>
  ${igst ? "" : ""}${scribbles(r, W, 900)}</div>`;
  return { width: W, pages: [DOC(css, body, W)] };
}

export function renderHtml(inv: SynthInvoice, r: Rng, qrDataUrl?: string): RenderedPages {
  switch (inv.layout) {
    case "a4-table": return a4Table(inv, r, qrDataUrl);
    case "igst": return igstBoxed(inv, r, qrDataUrl);
    case "thermal": return thermal(inv, r);
    case "hindi": return hindi(inv, r);
    case "credit-note": return creditNote(inv, r, qrDataUrl);
  }
}
