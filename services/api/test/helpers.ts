import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { inject } from "vitest";
import type { FastifyInstance } from "fastify";
import { gstinCheckChar, type Extractor } from "@arad/core";
import { buildApp, loggerOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { hashPin } from "../src/crypto.js";
import { createPool } from "../src/db.js";
import { createMockExtractor } from "../src/extraction.js";
import { createAppWorker } from "../src/runtime.js";
import { MemoryStorage } from "../src/storage.js";
import type { Worker } from "../src/worker.js";

export const gstin = (first14: string) => first14 + gstinCheckChar(first14);
export const STORE_A_GSTIN = gstin("20AAACA1111A1Z");
export const STORE_B_GSTIN = gstin("20AAACA1111A2Z");

export interface TestEnv {
  ctx: AppContext;
  app: FastifyInstance;
  worker: Worker;
  pool: pg.Pool;
  storage: MemoryStorage;
  close(): Promise<void>;
}

export async function createTestEnv(env: Record<string, string> = {}, extractor?: Extractor): Promise<TestEnv> {
  const adminUrl = inject("pgAdminUrl");
  const template = inject("pgTemplate");
  const name = `arad_t_${template.replace("arad_tmpl_", "")}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (let i = 0; ; i++) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      break;
    } catch (e) {
      // Another file may be cloning the template at the same moment.
      if (i > 20) throw e;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    SESSION_SECRET: "test-session-secret-0123456789-abcdefghij",
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    HDFC_CLIENT_CODE: "ARAD01",
    EXTRACTOR: "mock",
    LOG_LEVEL: "silent",
    RUN_WORKER: "false",
    LOGIN_RATE_LIMIT_PER_MIN: "1000",
    ...env,
  });
  const pool = createPool(config.DATABASE_URL, 5);
  const storage = new MemoryStorage();
  const ctx: AppContext = { config, pool, storage, extractor: extractor ?? createMockExtractor() };
  // TEST_LOG=error (or debug) prints server logs while debugging a test.
  const app = await buildApp(ctx, { logger: process.env.TEST_LOG ? loggerOptions(process.env.TEST_LOG) : false });
  await app.ready();
  const worker = createAppWorker(ctx, pino({ level: "silent" }), { backoffBaseMs: 0 });
  return {
    ctx,
    app,
    worker,
    pool,
    storage,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export interface Fixture {
  storeA: string;
  storeB: string;
  owner: { id: string; phone: string; pin: string };
  staffA: { id: string; phone: string; pin: string };
  staffB: { id: string; phone: string; pin: string };
}

/** Two stores, an owner and one staff member per store. */
export async function seedBasic(pool: pg.Pool): Promise<Fixture> {
  const a = await pool.query<{ id: string }>("INSERT INTO stores (code, name, gstin) VALUES ('S1', 'Store One Lalpur', $1) RETURNING id", [STORE_A_GSTIN]);
  const b = await pool.query<{ id: string }>("INSERT INTO stores (code, name, gstin) VALUES ('S2', 'Store Two Doranda', $1) RETURNING id", [STORE_B_GSTIN]);
  const mk = async (name: string, phone: string, pin: string, role: string, stores: string[]) => {
    const r = await pool.query<{ id: string }>("INSERT INTO users (name, phone, pin_hash, role) VALUES ($1, $2, $3, $4) RETURNING id", [name, phone, await hashPin(pin), role]);
    for (const s of stores) await pool.query("INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)", [r.rows[0]!.id, s]);
    return { id: r.rows[0]!.id, phone, pin };
  };
  const storeA = a.rows[0]!.id;
  const storeB = b.rows[0]!.id;
  return {
    storeA,
    storeB,
    owner: await mk("Owner", "9000000001", "1234", "owner", []),
    staffA: await mk("Asha (S1)", "9000000011", "1111", "staff", [storeA]),
    staffB: await mk("Bablu (S2)", "9000000012", "2222", "staff", [storeB]),
  };
}

/** Logs in and returns the cookie header value. */
export async function login(app: FastifyInstance, u: { phone: string; pin: string }): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: u.phone, pin: u.pin } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const sid = res.cookies.find((c) => c.name === "sid");
  if (!sid) throw new Error("no sid cookie");
  return `sid=${sid.value}`;
}

/** A tiny "PNG": correct signature, unique body, so each one has its own sha256. */
export function fakePng(seed: string = randomUUID()): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`fake-page:${seed}`)]);
}

export function multipart(fields: Record<string, string>, files: { field: string; filename: string; type: string; data: Buffer }[]) {
  const boundary = `----arad${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    chunks.push(f.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(app: FastifyInstance, cookie: string, opts: { storeId: string; clientId?: string; pages?: Buffer[]; qr?: string[] }) {
  const pages = opts.pages ?? [fakePng()];
  const body = multipart(
    { storeId: opts.storeId, clientId: opts.clientId ?? randomUUID(), ...(opts.qr ? { qr: JSON.stringify(opts.qr) } : {}) },
    pages.map((data, i) => ({ field: "page", filename: `p${i + 1}.png`, type: "image/png", data })),
  );
  return app.inject({ method: "POST", url: "/api/documents", payload: body.payload, headers: { ...body.headers, cookie } });
}

/** A signed-looking GST e-invoice QR (header + payload + fake signature). */
export function einvoiceQr(data: { SellerGstin: string; BuyerGstin: string; DocNo: string; DocDt: string; TotInvVal: number; ItemCnt: number; Irn: string; DocTyp?: string }): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ data: JSON.stringify({ DocTyp: "INV", ...data }) })}.c2ln`;
}

/** Insert a VERIFIED bill directly (for payables / payment run tests). */
export async function insertVerifiedInvoice(
  pool: pg.Pool,
  o: { storeId: string; vendorId: string; userId: string; invoiceNo: string; invoiceDate: string; dueDate: string; totalPaise: number; docType?: "INV" | "CRN"; sellerGstin?: string },
): Promise<string> {
  const doc = await pool.query<{ id: string }>(
    `INSERT INTO documents (store_id, client_id, captured_by, page_count, pages, page_sha256) VALUES ($1, $2, $3, 1, '[]', ARRAY[$4]) RETURNING id`,
    [o.storeId, randomUUID(), o.userId, randomBytes(32).toString("hex")],
  );
  const inv = await pool.query<{ id: string }>(
    `INSERT INTO invoices (store_id, document_id, state, vendor_id, seller_gstin, invoice_no, invoice_date, financial_year, doc_type, taxable_paise, grand_total_paise,
                           locked_total_paise, due_date, captured_by, verified_by, verified_at)
     VALUES ($1, $2, 'VERIFIED', $3, $4, $5, $6, '2026-27', $7, $8, $8, $8, $9, $10, $10, now()) RETURNING id`,
    [o.storeId, doc.rows[0]!.id, o.vendorId, o.sellerGstin ?? null, o.invoiceNo, o.invoiceDate, o.docType ?? "INV", o.totalPaise, o.dueDate, o.userId],
  );
  await pool.query(
    `INSERT INTO invoice_lines (invoice_id, idx, description, qty_milli, rate_paise, gst_rate_bp, taxable_paise, tax_paise, total_paise, status) VALUES ($1, 0, 'Goods', 1000, $2, 0, $2, 0, $2, 'accepted')`,
    [inv.rows[0]!.id, o.totalPaise],
  );
  return inv.rows[0]!.id;
}

export const json = <T = any>(res: { body: string }): T => JSON.parse(res.body) as T; // eslint-disable-line @typescript-eslint/no-explicit-any
