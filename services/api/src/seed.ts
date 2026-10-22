/**
 * Development seed: 6 Ranchi stores, owner + one staff member per store, ~100 synthetic vendors with
 * approved bank accounts, and ~30 bills in every state (including a paid run and a draft run to review).
 * All data is synthetic. Refuses to run in production.
 */
import { deflateSync, crc32 } from "node:zlib";
import { randomUUID } from "node:crypto";
import { computeLine, financialYear, gstinCheckChar, type InvoiceLine } from "@arad/core";
import { audit, SYSTEM } from "./audit.js";
import type { AppContext, SessionUser } from "./context.js";
import { blindIndex, encrypt, hashPin, sha256Hex } from "./crypto.js";
import { one, tx, type Db } from "./db.js";
import { enqueue } from "./jobs.js";
import { addDays, istToday, refresh } from "./services/invoices.js";
import { approveRun, createRun, markPaid, markUploaded } from "./services/payment-runs.js";

export interface SeedLog {
  info(obj: object, msg?: string): void;
}

// ---------------------------------------------------------------- deterministic randomness

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    letters: (n: number) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(next() * 26)]).join(""),
    digits: (n: number) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join(""),
  };
}

export const makeGstin = (state: string, pan: string, entity = "1") => {
  const first14 = `${state}${pan}${entity}Z`;
  return first14 + gstinCheckChar(first14);
};

// ---------------------------------------------------------------- fake page images

/** A plain "paper" PNG with grey text-like bars, unique per seed (so each page has its own hash). */
export function placeholderPng(seed: number, width = 360, height = 504): Buffer {
  const r = prng(seed);
  const rows: Buffer[] = [];
  const bars: { y: number; x: number; w: number }[] = [];
  for (let y = 40; y < height - 40; y += r.int(14, 22)) bars.push({ y, x: r.int(20, 40), w: r.int(80, width - 60) });
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 0xfa);
    row[0] = 0; // filter: none
    const bar = bars.find((b) => y >= b.y && y < b.y + 6);
    if (y < 28) for (let x = 0; x < width; x++) row.set([0x0e, 0x7c, 0x66], 1 + x * 3);
    else if (bar) for (let x = bar.x; x < Math.min(width, bar.x + bar.w); x++) row.set([0x9a, 0xa6, 0xa0], 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- reference data

const STORES = [
  { code: "S01", name: "Apna Rashan Lalpur", address: "Lalpur Chowk, Circular Road, Ranchi 834001" },
  { code: "S02", name: "Apna Rashan Doranda", address: "Doranda Main Road, near Hinoo, Ranchi 834002" },
  { code: "S03", name: "Apna Rashan Kanke Road", address: "Kanke Road, Gandhi Nagar, Ranchi 834008" },
  { code: "S04", name: "Apna Rashan Bariatu", address: "Bariatu Road, near RIMS, Ranchi 834009" },
  { code: "S05", name: "Apna Rashan Harmu", address: "Harmu Housing Colony, Ranchi 834002" },
  { code: "S06", name: "Apna Rashan Morabadi", address: "Morabadi Ground Road, Ranchi 834008" },
];
const STORE_PAN = "AAKFA4821R"; // one firm, a separate registration per outlet

const STAFF = ["Sunita Kumari", "Amit Oraon", "Pooja Mahto", "Ravi Munda", "Neha Singh", "Deepak Sahu"];

type Category = "fmcg" | "staples" | "dairy" | "beverages";
const NOUNS: Record<Category, string[]> = {
  fmcg: ["FMCG Distributors", "Agencies", "Marketing", "Enterprises", "Consumer Products", "Trading Co"],
  staples: ["Rice Mill", "Grain Traders", "Dal Mill", "Oil Depot", "Atta Chakki", "Kirana Wholesale"],
  dairy: ["Dairy", "Milk Products", "Dairy Farm", "Milk Suppliers"],
  beverages: ["Beverages", "Cold Drinks Agency", "Aqua Suppliers", "Drinks Distributors"],
};
const PREFIXES = [
  "Shree Ganesh", "Maa Durga", "Jai Mata Di", "Balaji", "Hanuman", "Laxmi", "Shiv Shakti", "Radhe Krishna", "Bajrang", "Sai Kripa",
  "Tirupati", "Om Sai", "Gupta", "Agarwal", "Jain", "Kumar", "Sahu", "Mahto", "Jharkhand", "Chotanagpur", "Birsa", "Subarnarekha",
  "Kanke", "Hatia", "Namkum", "Ratu", "Ormanjhi", "Khunti", "Ramgarh", "Hazaribagh", "Lohardaga", "Gumla",
];
const PRODUCTS: Record<Category, { d: string; hsn: string; rate: number; gst: number; unit: string }[]> = {
  fmcg: [
    { d: "Detergent Powder 1kg", hsn: "3402", rate: 11500, gst: 1800, unit: "PKT" },
    { d: "Bath Soap 125g x4", hsn: "3401", rate: 13200, gst: 1800, unit: "PKT" },
    { d: "Toothpaste 200g", hsn: "3306", rate: 9800, gst: 1800, unit: "PCS" },
    { d: "Glucose Biscuit 800g", hsn: "1905", rate: 8000, gst: 500, unit: "PKT" },
    { d: "Instant Noodles 12-pack", hsn: "1902", rate: 14400, gst: 500, unit: "PKT" },
    { d: "Tea Leaf 500g", hsn: "0902", rate: 27000, gst: 500, unit: "PKT" },
    { d: "Dishwash Bar 300g", hsn: "3402", rate: 2800, gst: 1800, unit: "PCS" },
  ],
  staples: [
    { d: "Wheat Atta 10kg", hsn: "1101", rate: 42000, gst: 500, unit: "BAG" },
    { d: "Basmati Rice 5kg", hsn: "1006", rate: 52000, gst: 500, unit: "BAG" },
    { d: "Toor Dal 1kg", hsn: "0713", rate: 13500, gst: 0, unit: "PKT" },
    { d: "Soyabean Oil 1L", hsn: "1507", rate: 13800, gst: 500, unit: "PCS" },
    { d: "Iodised Salt 1kg", hsn: "2501", rate: 2400, gst: 0, unit: "PKT" },
    { d: "Sugar 1kg", hsn: "1701", rate: 4100, gst: 500, unit: "PKT" },
    { d: "Moong Dal 1kg", hsn: "0713", rate: 11800, gst: 0, unit: "PKT" },
  ],
  dairy: [
    { d: "Toned Milk 500ml crate of 24", hsn: "0401", rate: 60000, gst: 0, unit: "CRT" },
    { d: "Paneer 200g", hsn: "0406", rate: 8000, gst: 500, unit: "PCS" },
    { d: "Curd 400g", hsn: "0403", rate: 3500, gst: 0, unit: "PCS" },
    { d: "Ghee 1L", hsn: "0405", rate: 58000, gst: 500, unit: "PCS" },
    { d: "Butter 100g", hsn: "0405", rate: 5200, gst: 500, unit: "PCS" },
  ],
  beverages: [
    { d: "Cola 2L pack of 6", hsn: "2202", rate: 48000, gst: 4000, unit: "PCK" },
    { d: "Packaged Water 1L pack of 12", hsn: "2201", rate: 14400, gst: 500, unit: "PCK" },
    { d: "Mango Drink 600ml case of 24", hsn: "2202", rate: 52000, gst: 1200, unit: "CSE" },
    { d: "Energy Drink 250ml case of 24", hsn: "2202", rate: 96000, gst: 4000, unit: "CSE" },
  ],
};
const BANKS = [
  { code: "HDFC", name: "HDFC Bank", len: 14, weight: 3 },
  { code: "SBIN", name: "State Bank of India", len: 11, weight: 3 },
  { code: "ICIC", name: "ICICI Bank", len: 12, weight: 1 },
  { code: "UTIB", name: "Axis Bank", len: 15, weight: 1 },
  { code: "PUNB", name: "Punjab National Bank", len: 16, weight: 1 },
  { code: "BKID", name: "Bank of India", len: 15, weight: 1 },
  { code: "CNRB", name: "Canara Bank", len: 13, weight: 1 },
  { code: "UBIN", name: "Union Bank of India", len: 15, weight: 1 },
];
const BRANCHES = ["Main Road Ranchi", "Lalpur Ranchi", "Harmu Ranchi", "Doranda Ranchi", "Kanke Road Ranchi", "Upper Bazar Ranchi", "Kolkata Burrabazar", "Patna Exhibition Road"];

// ---------------------------------------------------------------- seed

interface SeedVendor {
  id: string;
  name: string;
  gstin: string;
  category: Category;
  terms: number;
}

function linesFor(r: ReturnType<typeof prng>, category: Category, count: number): Omit<InvoiceLine, "id">[] {
  const products = [...PRODUCTS[category]];
  const out: Omit<InvoiceLine, "id">[] = [];
  for (let idx = 0; idx < count; idx++) {
    const p = products.splice(Math.floor(r.next() * products.length), 1)[0] ?? r.pick(PRODUCTS[category]);
    const qty = r.int(1, 24);
    const discount = r.next() < 0.2 ? Math.round((qty * p.rate * r.int(2, 5)) / 100) : 0;
    const base = { qtyMilli: qty * 1000, ratePaise: p.rate, discountPaise: discount, gstRateBp: p.gst };
    out.push({ idx, description: p.d, hsn: p.hsn, unit: p.unit, mrpPaise: Math.round(p.rate * 1.15), ...base, ...computeLine(base), status: "pending" });
  }
  return out;
}

function totalsFor(lines: Omit<InvoiceLine, "id">[], interState: boolean) {
  const taxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
  const sum = lines.reduce((s, l) => s + l.totalPaise, 0);
  const roundOff = Math.round(sum / 100) * 100 - sum;
  const cgst = interState ? 0 : Math.floor(tax / 2);
  return {
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: interState ? 0 : tax - cgst,
    igst_paise: interState ? tax : 0,
    round_off_paise: roundOff,
    grand_total_paise: sum + roundOff,
  };
}

export async function seed(ctx: AppContext, log: SeedLog, opts: { reset?: boolean } = {}): Promise<{ stores: number; vendors: number; invoices: number }> {
  if (ctx.config.isProd) throw new Error("refusing to seed a production database");
  const existing = await one<{ n: number }>(ctx.pool, "SELECT count(*)::int AS n FROM stores");
  if ((existing?.n ?? 0) > 0) {
    log.info({}, "database already has stores; skipping seed (use --reset to start over)");
    return { stores: 0, vendors: 0, invoices: 0 };
  }

  const r = prng(20261022);
  const today = istToday();
  const ownerPin = await hashPin("1234");
  const staffPin = await hashPin("1111");

  const result = await tx(ctx.pool, async (c) => {
    // Stores
    const stores: { id: string; code: string; gstin: string }[] = [];
    for (const [i, s] of STORES.entries()) {
      const gstin = makeGstin("20", STORE_PAN, String(i + 1));
      const row = await one<{ id: string }>(c, "INSERT INTO stores (code, name, gstin, address) VALUES ($1, $2, $3, $4) RETURNING id", [s.code, s.name, gstin, s.address]);
      stores.push({ id: row!.id, code: s.code, gstin });
    }

    // People
    const ownerRow =
      (await one<{ id: string; name: string }>(c, "SELECT id, name FROM users WHERE phone = '9000000001'")) ??
      (await one<{ id: string; name: string }>(c, "INSERT INTO users (name, phone, pin_hash, role) VALUES ('Rajesh Agarwal', '9000000001', $1, 'owner') RETURNING id, name", [ownerPin]));
    const staff: { id: string; name: string; storeId: string }[] = [];
    for (const [i, name] of STAFF.entries()) {
      const u = await one<{ id: string }>(c, "INSERT INTO users (name, phone, pin_hash, role) VALUES ($1, $2, $3, 'staff') RETURNING id", [name, `90000000${11 + i}`, staffPin]);
      await c.query("INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)", [u!.id, stores[i]!.id]);
      staff.push({ id: u!.id, name, storeId: stores[i]!.id });
    }

    // Vendors + bank accounts
    const vendors: SeedVendor[] = [];
    const names = new Set<string>();
    const pans = new Set<string>();
    const accounts = new Set<string>();
    const categories: Category[] = ["fmcg", "staples", "dairy", "beverages"];
    for (let i = 0; vendors.length < 100; i++) {
      const category = categories[i % 4]!;
      const company = r.next() < 0.45;
      const name = `${r.pick(PREFIXES)} ${r.pick(NOUNS[category])}${company ? " Pvt Ltd" : ""}`;
      if (names.has(name)) continue;
      names.add(name);
      let pan: string;
      do pan = `${r.letters(3)}${company ? "C" : r.pick(["F", "P"])}${name[0]}${r.digits(4)}${r.letters(1)}`;
      while (pans.has(pan));
      pans.add(pan);
      const roll = r.next();
      const state = roll < 0.85 ? "20" : roll < 0.93 ? "19" : "10";
      const gstin = makeGstin(state, pan);
      const n = vendors.length;
      // A few vendors are pending (no bank yet) or brand new.
      const pendingVendor = n >= 97;
      const ageDays = n < 90 ? r.int(60, 400) : r.int(3, 20);
      const terms = r.pick([7, 15, 21, 30, 30, 30, 45]);
      const v = await one<{ id: string }>(
        c,
        `INSERT INTO vendors (name, trade_name, gstin, pan, phone, email, payment_terms_days, status, created_by, approved_by, approved_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - ($12::int * interval '1 day')) RETURNING id`,
        [
          name,
          name.replace(/ Pvt Ltd$/, ""),
          gstin,
          pan,
          `9${r.digits(9)}`,
          r.next() < 0.5 ? `accounts${n + 1}@vendor${n + 1}.example` : null,
          terms,
          pendingVendor ? "PENDING" : "ACTIVE",
          staff[n % 6]!.id,
          pendingVendor ? null : ownerRow!.id,
          pendingVendor ? null : new Date(),
          ageDays,
        ],
      );
      vendors.push({ id: v!.id, name, gstin, category, terms });
      if (pendingVendor) continue;

      const bankFor = (version: number, status: "APPROVED" | "PENDING" | "SUPERSEDED", usableFromHours: number | null) => {
        const weighted = BANKS.flatMap((b) => Array<typeof b>(b.weight).fill(b));
        const bank = r.pick(weighted);
        let account: string;
        do account = `${r.int(1, 9)}${r.digits(bank.len - 1)}`;
        while (accounts.has(account));
        accounts.add(account);
        const ifsc = `${bank.code}0${bank.code === "HDFC" ? r.digits(6) : r.digits(6)}`;
        const beneCode = bank.code === "HDFC" ? `V${String(n + 1).padStart(3, "0")}${pan.slice(0, 4)}` : null;
        return c.query(
          `INSERT INTO vendor_bank_accounts (vendor_id, version, account_number_enc, account_hash, account_last4, account_length, ifsc, bank_name, branch_name, bene_code,
                                             status, usable_from, created_by, created_at, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::int IS NULL THEN NULL ELSE now() + ($12::int * interval '1 hour') END, $13,
                   now() - ($14::int * interval '1 day'), $15, CASE WHEN $15::uuid IS NULL THEN NULL ELSE now() - ($14::int * interval '1 day') + interval '2 hours' END)`,
          [
            v!.id,
            version,
            encrypt(account, ctx.config.dataKey, "bank_account"),
            blindIndex(account, ctx.config.dataKey, "bank_account"),
            account.slice(-4),
            account.length,
            ifsc,
            bank.name,
            r.pick(BRANCHES),
            beneCode,
            status,
            usableFromHours,
            staff[n % 6]!.id,
            status === "PENDING" ? 1 : Math.max(1, ageDays - 2),
            status === "PENDING" ? null : ownerRow!.id,
          ],
        );
      };
      if (n >= 90 && n < 93) {
        // Recently approved: still in cooling-off.
        await bankFor(1, "APPROVED", ctx.config.COOLING_OFF_HOURS - 2);
      } else if (n >= 93 && n < 95) {
        // Approved account plus a proposed change waiting for the owner.
        await bankFor(1, "APPROVED", -24 * 30);
        await bankFor(2, "PENDING", null);
      } else {
        await bankFor(1, "APPROVED", -24 * Math.max(1, ageDays - 3));
      }
    }

    // Bills
    let docSeed = 1;
    const ids: Record<string, string[]> = {};
    const add = (k: string, id: string) => (ids[k] ??= []).push(id);
    const bill = async (o: {
      storeIdx: number;
      vendor: SeedVendor;
      state: "CAPTURED" | "NEEDS_VERIFICATION" | "VERIFIED" | "EXTRACTION_FAILED" | "REJECTED" | "DUPLICATE" | "ON_HOLD";
      daysAgo: number;
      docType?: "INV" | "CRN";
      duplicateOf?: string;
    }) => {
      const store = stores[o.storeIdx]!;
      const user = staff[o.storeIdx]!;
      const png = placeholderPng(docSeed++);
      const documentId = randomUUID();
      const key = `documents/${store.id}/${documentId}/1.png`;
      await ctx.storage.put(key, png, "image/png");
      const sha = sha256Hex(png);
      await c.query(
        `INSERT INTO documents (id, store_id, client_id, captured_by, page_count, pages, page_sha256, created_at) VALUES ($1, $2, $3, $4, 1, $5, $6, now() - ($7::int * interval '1 day'))`,
        [documentId, store.id, randomUUID(), user.id, JSON.stringify([{ key, sha256: sha, mime: "image/png", bytes: png.length }]), [sha], o.daysAgo],
      );
      const invoiceDate = addDays(today, -o.daysAgo - 1);
      const withData = !["CAPTURED", "EXTRACTION_FAILED"].includes(o.state);
      const lines = withData ? linesFor(r, o.vendor.category, o.docType === "CRN" ? 1 : r.int(3, 7)) : [];
      const t = totalsFor(lines, o.vendor.gstin.slice(0, 2) !== "20");
      const verified = o.state === "VERIFIED";
      const prefix = o.vendor.name.replace(/[^A-Z]/g, "").slice(0, 3) || "INV";
      const invoiceNo = withData ? `${o.docType === "CRN" ? "CN" : prefix}/${financialYear(invoiceDate).slice(2)}/${r.int(100, 9999)}` : null;
      const invoiceId = randomUUID();
      const state = o.state;
      await c.query(
        `INSERT INTO invoices (id, store_id, document_id, state, held_from_state, hold_reason, reject_reason, vendor_id, vendor_name, seller_gstin, buyer_gstin, invoice_no, invoice_date,
                               doc_type, financial_year, taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, grand_total_paise,
                               header_meta, totals_meta, locked_total_paise, lock_attempts, extraction_runs, due_date, duplicate_of, duplicate_reason,
                               captured_by, verified_by, verified_at, verify_duration_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, '{}', $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
                 now() - ($33::int * interval '1 day'))`,
        [
          invoiceId,
          store.id,
          documentId,
          state,
          state === "ON_HOLD" ? "NEEDS_VERIFICATION" : null,
          state === "ON_HOLD" ? "Rate differs from the agreed price list; checking with the vendor" : null,
          state === "REJECTED" ? "Bill belongs to another shop" : null,
          withData ? o.vendor.id : null,
          withData ? o.vendor.name : null,
          withData ? o.vendor.gstin : null,
          withData ? store.gstin : null,
          invoiceNo,
          withData ? invoiceDate : null,
          o.docType ?? "INV",
          withData ? financialYear(invoiceDate) : null,
          t.taxable_paise,
          t.cgst_paise,
          t.sgst_paise,
          t.igst_paise,
          t.round_off_paise,
          t.grand_total_paise,
          JSON.stringify(withData ? { vendorName: { confidence: 0.97 }, invoiceNo: { confidence: 0.93 }, invoiceDate: { confidence: 0.95 } } : {}),
          verified ? t.grand_total_paise : null,
          verified ? 1 : 0,
          JSON.stringify(
            state === "EXTRACTION_FAILED"
              ? [{ provider: "extractor", ok: false, ms: 30000, error: "page too blurred to read" }]
              : withData
                ? [{ provider: "mock", model: "seed", ok: true, ms: 1800 }]
                : [],
          ),
          withData ? addDays(invoiceDate, o.vendor.terms) : null,
          o.duplicateOf ?? null,
          o.duplicateOf ? "same_image" : null,
          user.id,
          verified ? user.id : null,
          verified ? new Date(Date.now() - (o.daysAgo - 0.5) * 86_400_000) : null,
          verified ? r.int(25_000, 140_000) : null,
          o.daysAgo,
        ],
      );
      for (const l of lines) {
        await c.query(
          `INSERT INTO invoice_lines (invoice_id, idx, description, hsn, qty_milli, unit, mrp_paise, rate_paise, discount_paise, gst_rate_bp, taxable_paise, tax_paise, total_paise, status, meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            invoiceId,
            l.idx,
            l.description,
            l.hsn,
            l.qtyMilli,
            l.unit,
            l.mrpPaise,
            l.ratePaise,
            l.discountPaise,
            l.gstRateBp,
            l.taxablePaise,
            l.taxPaise,
            l.totalPaise,
            verified ? "accepted" : "pending",
            JSON.stringify({ description: { confidence: 0.95 }, qtyMilli: { confidence: r.next() < 0.15 ? 0.72 : 0.94 }, totalPaise: { confidence: 0.96 } }),
          ],
        );
      }
      if (state === "CAPTURED") await enqueue(c, "extract", { invoiceId }, { dedupeKey: `extract:${invoiceId}` });
      await refresh(c, undefined, invoiceId);
      add(state, invoiceId);
      return invoiceId;
    };

    // Six vendors that bill several stores (the point of one payment per vendor).
    const regulars = vendors.slice(0, 6);
    for (const [i, v] of regulars.entries()) {
      for (let k = 0; k < (i < 2 ? 3 : 2); k++) await bill({ storeIdx: (i + k * 2) % 6, vendor: v, state: "VERIFIED", daysAgo: r.int(3, 40) });
    }
    await bill({ storeIdx: 0, vendor: regulars[0]!, state: "VERIFIED", daysAgo: 6, docType: "CRN" });
    await bill({ storeIdx: 3, vendor: regulars[2]!, state: "VERIFIED", daysAgo: 9, docType: "CRN" });
    const verified = ids.VERIFIED!.length;
    // For the paid history run (store S01, prepared by its staff) and the draft run (store S02).
    const paidBills = [await bill({ storeIdx: 0, vendor: vendors[6]!, state: "VERIFIED", daysAgo: 25 }), await bill({ storeIdx: 0, vendor: vendors[7]!, state: "VERIFIED", daysAgo: 22 })];
    const draftBills = [await bill({ storeIdx: 1, vendor: vendors[8]!, state: "VERIFIED", daysAgo: 12 }), await bill({ storeIdx: 1, vendor: vendors[9]!, state: "VERIFIED", daysAgo: 10 })];
    for (let i = 0; i < 6; i++) await bill({ storeIdx: i, vendor: vendors[10 + i]!, state: "NEEDS_VERIFICATION", daysAgo: r.int(0, 2) });
    for (let i = 0; i < 2; i++) await bill({ storeIdx: 2 + i, vendor: vendors[16 + i]!, state: "CAPTURED", daysAgo: 0 });
    for (let i = 0; i < 2; i++) await bill({ storeIdx: 4 + i, vendor: vendors[18 + i]!, state: "EXTRACTION_FAILED", daysAgo: 1 });
    await bill({ storeIdx: 1, vendor: vendors[3]!, state: "DUPLICATE", daysAgo: 1, duplicateOf: ids.VERIFIED![6] });
    await bill({ storeIdx: 2, vendor: vendors[20]!, state: "REJECTED", daysAgo: 4 });
    await bill({ storeIdx: 5, vendor: vendors[21]!, state: "ON_HOLD", daysAgo: 3 });

    await audit(c, SYSTEM, { action: "seed.run", entity: "system", entityId: "seed", detail: { stores: stores.length, vendors: vendors.length, verified } });
    const total = Object.values(ids).reduce((s, x) => s + x.length, 0);
    return { stores, staff, owner: ownerRow!, paidBills, draftBills, vendors: vendors.length, invoices: total };
  });

  // A paid run (history for the "unusual amount" check) and a draft waiting for the owner, through the real flow.
  const asUser = (u: { id: string; name: string }, role: "owner" | "staff", storeIds: string[]): SessionUser => ({ id: u.id, name: u.name, phone: "", role, lang: "en", storeIds, sessionId: "seed" });
  const owner = asUser(result.owner, "owner", result.stores.map((s) => s.id));
  const seedCtx: AppContext = { ...ctx, config: { ...ctx.config, HDFC_CLIENT_CODE: ctx.config.HDFC_CLIENT_CODE ?? "ARAD01" } };
  const paid = await createRun(seedCtx, asUser(result.staff[0]!, "staff", [result.stores[0]!.id]), result.paidBills, today);
  await approveRun(seedCtx, owner, paid.id);
  await markUploaded(seedCtx, owner, paid.id);
  await markPaid(seedCtx, owner, paid.id, Object.fromEntries(paid.items.map((it, i) => [it.id, `HDFCN5${today.replace(/-/g, "")}${String(i + 1).padStart(4, "0")}`])));
  await createRun(seedCtx, asUser(result.staff[1]!, "staff", [result.stores[1]!.id]), result.draftBills, today);

  log.info({ stores: result.stores.length, vendors: result.vendors, invoices: result.invoices }, "seed complete");
  return { stores: result.stores.length, vendors: result.vendors, invoices: result.invoices };
}

/** Development only: wipe everything (including the append-only audit log) by recreating the schema. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}
