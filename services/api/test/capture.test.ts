import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { Extractor } from "@arad/core";
import { createMockExtractor, MOCK_SELLER, mockFixture } from "../src/extraction.js";
import { createWorker } from "../src/worker.js";
import { createTestEnv, einvoiceQr, fakePng, gstin, json, login, multipart, seedBasic, STORE_A_GSTIN, upload, type Fixture, type TestEnv } from "./helpers.js";

let env: TestEnv;
let fx: Fixture;
let cookie: string;

beforeAll(async () => {
  env = await createTestEnv();
  fx = await seedBasic(env.pool);
  cookie = await login(env.app, fx.staffA);
});
afterAll(() => env.close());

const state = async (id: string) => (await env.pool.query("SELECT state FROM invoices WHERE id = $1", [id])).rows[0]?.state;

describe("capture", () => {
  it("is idempotent by clientId", async () => {
    const clientId = randomUUID();
    const page = fakePng();
    const first = await upload(env.app, cookie, { storeId: fx.storeA, clientId, pages: [page] });
    expect(first.statusCode).toBe(201);
    const again = await upload(env.app, cookie, { storeId: fx.storeA, clientId, pages: [page] });
    expect(again.statusCode).toBe(200);
    expect(json(again)).toEqual(json(first));
    expect(json(first).state).toBe("CAPTURED");
    const docs = await env.pool.query("SELECT count(*)::int AS n FROM documents WHERE client_id = $1", [clientId]);
    expect(docs.rows[0].n).toBe(1);
    // Exactly one extraction job, enqueued with the invoice.
    const jobs = await env.pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload->>'invoiceId' = $1", [json(first).invoiceId]);
    expect(jobs.rows[0].n).toBe(1);
    // Only one copy of each page in storage.
    expect([...env.storage.objects.keys()].filter((k) => k.includes(json(first).documentId))).toHaveLength(1);
  });

  it("stores page bytes and serves them back with auth", async () => {
    const page = fakePng("served");
    const r = json(await upload(env.app, cookie, { storeId: fx.storeA, pages: [page, fakePng()] }));
    const img = await env.app.inject({ url: `/api/documents/${r.documentId}/pages/1`, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(page)).toBe(true);
    expect((await env.app.inject({ url: `/api/documents/${r.documentId}/pages/3`, headers: { cookie } })).statusCode).toBe(404);
    expect((await env.app.inject({ url: `/api/documents/${r.documentId}/pages/1` })).statusCode).toBe(401);
    const doc = await env.pool.query("SELECT page_sha256 FROM documents WHERE id = $1", [r.documentId]);
    expect(doc.rows[0].page_sha256[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects files that are not images or PDFs, and empty uploads", async () => {
    const bad = await upload(env.app, cookie, { storeId: fx.storeA, pages: [Buffer.from("hello, not an image")] });
    expect(bad.statusCode).toBe(415);
    const body = multipart({ storeId: fx.storeA, clientId: randomUUID() }, []);
    const none = await env.app.inject({ method: "POST", url: "/api/documents", payload: body.payload, headers: { ...body.headers, cookie } });
    expect(none.statusCode).toBe(400);
    const noClient = multipart({ storeId: fx.storeA }, [{ field: "page", filename: "a.png", type: "image/png", data: fakePng() }]);
    expect((await env.app.inject({ method: "POST", url: "/api/documents", payload: noClient.payload, headers: { ...noClient.headers, cookie } })).statusCode).toBe(400);
  });

  it("marks the same image captured again as DUPLICATE but keeps it", async () => {
    const page = fakePng("dup-image");
    const a = json(await upload(env.app, cookie, { storeId: fx.storeA, pages: [page] }));
    const b = await upload(env.app, cookie, { storeId: fx.storeA, pages: [page] });
    expect(b.statusCode).toBe(201);
    expect(json(b)).toMatchObject({ state: "DUPLICATE", duplicateOf: { invoiceId: a.invoiceId, reason: "same_image" } });
    expect(await state(json(b).invoiceId)).toBe("DUPLICATE");
  });

  it("detects the same e-invoice IRN and pre-fills the header from the QR", async () => {
    const qr = einvoiceQr({ SellerGstin: MOCK_SELLER.gstin, BuyerGstin: STORE_A_GSTIN, DocNo: "QR/77", DocDt: "01/10/2026", TotInvVal: 1234.5, ItemCnt: 5, Irn: "a".repeat(64) });
    const upi = "upi://pay?pa=vendor@okhdfc&pn=Vendor&am=100";
    const a = json(await upload(env.app, cookie, { storeId: fx.storeA, qr: [qr, upi] }));
    expect(a.state).toBe("CAPTURED");
    const row = (await env.pool.query("SELECT irn, invoice_no, invoice_date, seller_gstin FROM invoices WHERE id = $1", [a.invoiceId])).rows[0];
    expect(row).toMatchObject({ irn: "a".repeat(64), invoice_no: "QR/77", invoice_date: "2026-10-01", seller_gstin: MOCK_SELLER.gstin });
    const b = json(await upload(env.app, cookie, { storeId: fx.storeA, qr: [qr] }));
    expect(b).toMatchObject({ state: "DUPLICATE", duplicateOf: { invoiceId: a.invoiceId, reason: "same_irn" } });
    // Blind entry: the QR total is not revealed before the total is typed.
    await env.pool.query("UPDATE invoices SET state = 'NEEDS_VERIFICATION' WHERE id = $1", [a.invoiceId]);
    const d = json(await env.app.inject({ url: `/api/invoices/${a.invoiceId}`, headers: { cookie } }));
    expect(d.totals.grandTotalPaise).toBe(0);
    expect(d.qr.totalPaise).toBe(0);
    expect(d.totalsMeta.grandTotalPaise.reason).toBe("hidden_until_locked");
    await env.pool.query("UPDATE invoices SET state = 'REJECTED' WHERE id = $1", [a.invoiceId]);
  });
});

describe("extraction job", () => {
  it("extracts with the mock extractor into NEEDS_VERIFICATION, links a PENDING vendor and sets the due date", async () => {
    await env.worker.drain();
    const cap = json(await upload(env.app, cookie, { storeId: fx.storeA }));
    expect(await env.worker.drain()).toBeGreaterThanOrEqual(1);
    expect(await state(cap.invoiceId)).toBe("NEEDS_VERIFICATION");
    const d = json(await env.app.inject({ url: `/api/invoices/${cap.invoiceId}`, headers: { cookie } }));
    expect(d.lines).toHaveLength(5);
    expect(d.lines.every((l: { status: string }) => l.status === "pending")).toBe(true);
    expect(d.header.sellerGstin).toBe(MOCK_SELLER.gstin);
    expect(d.header.buyerGstin).toBe(STORE_A_GSTIN);
    expect(d.checks.filter((c: { status: string }) => c.status === "fail")).toEqual([]);
    expect(d.extraction.providers[0]).toMatchObject({ provider: "mock", ok: true });
    expect(d.vendorId).toBeTruthy();
    const v = (await env.pool.query("SELECT status, gstin, payment_terms_days FROM vendors WHERE id = $1", [d.vendorId])).rows[0];
    expect(v).toMatchObject({ status: "PENDING", gstin: MOCK_SELLER.gstin, payment_terms_days: 30 });
    const inv = (await env.pool.query("SELECT invoice_date, due_date FROM invoices WHERE id = $1", [cap.invoiceId])).rows[0];
    expect(Date.parse(inv.due_date) - Date.parse(inv.invoice_date)).toBe(30 * 86_400_000);
    const job = (await env.pool.query("SELECT state, attempts FROM jobs WHERE payload->>'invoiceId' = $1", [cap.invoiceId])).rows[0];
    expect(job).toMatchObject({ state: "done", attempts: 1 });
    // Summary shows the total once it is not blind... but here it is still blind (not locked yet).
    const list = json(await env.app.inject({ url: `/api/invoices?state=NEEDS_VERIFICATION`, headers: { cookie } }));
    const item = list.items.find((i: { id: string }) => i.id === cap.invoiceId);
    expect(item).toMatchObject({ lineCount: 5, state: "NEEDS_VERIFICATION" });
    expect(item.grandTotalPaise).toBeUndefined();
  });

  it("marks a bill DUPLICATE when extraction finds the same seller + number in the same financial year", async () => {
    const base = createMockExtractor();
    const fixed: Extractor = {
      providers: base.providers,
      async extract(pages, c) {
        const m = await base.extract(pages, c);
        return { ...m, header: { ...m.header, invoiceNo: "SAME/001" } };
      },
    };
    env.ctx.extractor = fixed;
    try {
      const a = json(await upload(env.app, cookie, { storeId: fx.storeA }));
      await env.worker.drain();
      const b = json(await upload(env.app, cookie, { storeId: fx.storeA }));
      await env.worker.drain();
      expect(await state(a.invoiceId)).toBe("NEEDS_VERIFICATION");
      expect(await state(b.invoiceId)).toBe("DUPLICATE");
      const d = json(await env.app.inject({ url: `/api/invoices/${b.invoiceId}`, headers: { cookie } }));
      expect(d.duplicateOfId).toBe(a.invoiceId);
    } finally {
      env.ctx.extractor = createMockExtractor();
    }
  });

  it("retries a failing extractor and ends in EXTRACTION_FAILED, which can still be verified manually", async () => {
    let calls = 0;
    env.ctx.extractor = {
      providers: () => [],
      async extract() {
        calls++;
        throw new Error("provider quota exceeded");
      },
    };
    try {
      const cap = json(await upload(env.app, cookie, { storeId: fx.storeA }));
      await env.worker.drain();
      expect(calls).toBe(3);
      expect(await state(cap.invoiceId)).toBe("EXTRACTION_FAILED");
      const job = (await env.pool.query("SELECT state, attempts, last_error FROM jobs WHERE payload->>'invoiceId' = $1", [cap.invoiceId])).rows[0];
      expect(job).toMatchObject({ state: "dead", attempts: 3 });
      expect(job.last_error).toContain("quota");

      // Manual path: header, lines, total typed from paper, seal.
      const { lines, totals } = mockFixture();
      const today = new Date().toISOString().slice(0, 10);
      let r = await env.app.inject({
        method: "PUT",
        url: `/api/invoices/${cap.invoiceId}/header`,
        headers: { cookie },
        payload: { sellerGstin: gstin("20AABCK7777K1Z"), buyerGstin: STORE_A_GSTIN, invoiceNo: "MAN-1", invoiceDate: today, vendorName: "Kumar Agencies", totals: { ...totals } },
      });
      expect(r.statusCode).toBe(200);
      expect(json(r).vendorId).toBeTruthy();
      for (const l of lines) {
        r = await env.app.inject({
          method: "POST",
          url: `/api/invoices/${cap.invoiceId}/lines`,
          headers: { cookie },
          payload: { description: l.description, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise, gstRateBp: l.gstRateBp },
        });
        expect(r.statusCode).toBe(201);
      }
      const lock = json(await env.app.inject({ method: "POST", url: `/api/invoices/${cap.invoiceId}/lock-total`, headers: { cookie }, payload: { typedTotalPaise: totals.grandTotalPaise } }));
      expect(lock.invoice.lockedTotalPaise).toBe(totals.grandTotalPaise);
      const seal = await env.app.inject({ method: "POST", url: `/api/invoices/${cap.invoiceId}/seal`, headers: { cookie }, payload: { durationMs: 90_000 } });
      expect(seal.statusCode, seal.body).toBe(200);
      expect(json(seal).state).toBe("VERIFIED");
    } finally {
      env.ctx.extractor = createMockExtractor();
    }
  });

  it("re-extract queues a fresh job", async () => {
    const cap = json(await upload(env.app, cookie, { storeId: fx.storeA }));
    await env.worker.drain();
    const r = await env.app.inject({ method: "POST", url: `/api/invoices/${cap.invoiceId}/re-extract`, headers: { cookie } });
    expect(json(r).state).toBe("CAPTURED");
    await env.worker.drain();
    expect(await state(cap.invoiceId)).toBe("NEEDS_VERIFICATION");
  });

  it("releases job leases on shutdown and recovers jobs whose lease expired", async () => {
    await env.worker.drain();
    const cap = json(await upload(env.app, cookie, { storeId: fx.storeA }));
    await env.pool.query("UPDATE jobs SET state = 'running', attempts = 1, locked_by = 'dying-worker', locked_until = now() + interval '5 minutes' WHERE payload->>'invoiceId' = $1", [cap.invoiceId]);
    const w = createWorker(env.pool, {}, pino({ level: "silent" }), { id: "dying-worker" });
    await w.stop(10);
    const j = (await env.pool.query("SELECT state, attempts, locked_by FROM jobs WHERE payload->>'invoiceId' = $1", [cap.invoiceId])).rows[0];
    expect(j).toMatchObject({ state: "queued", attempts: 0, locked_by: null });
    // Expired lease from a crashed worker is picked up again.
    await env.pool.query("UPDATE jobs SET state = 'running', attempts = 1, locked_by = 'crashed', locked_until = now() - interval '1 second' WHERE payload->>'invoiceId' = $1", [cap.invoiceId]);
    await env.worker.drain();
    expect(await state(cap.invoiceId)).toBe("NEEDS_VERIFICATION");
  });
});
