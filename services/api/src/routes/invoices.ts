/** Capture (documents) and invoice verification routes. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userOf } from "../auth.js";
import { assertStoreAccess, type AppContext } from "../context.js";
import { one } from "../db.js";
import { ApiError, notFound, parse } from "../errors.js";
import { capture, MAX_PAGE_BYTES, MAX_PAGES, type StoredPage, type UploadedPage } from "../services/capture.js";
import * as inv from "../services/invoices.js";

const uuid = z.string().uuid();
const paise = z.number().int().min(-1e13).max(1e13);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, "must be a real date");

export const lineInput = z.object({
  description: z.string().trim().min(1).max(300),
  hsn: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{2,10}$/, "must be 2-10 letters or digits").optional(),
  qtyMilli: z.number().int().min(-1e9).max(1e9).refine((n) => n !== 0, "must not be zero"),
  unit: z.string().trim().max(20).optional(),
  mrpPaise: paise.min(0).optional(),
  ratePaise: paise.min(0),
  discountPaise: paise.min(0),
  gstRateBp: z.number().int().min(0).max(10000),
  totalPaise: paise.optional(),
});

const headerUpdate = z
  .object({
    vendorName: z.string().max(120).nullable().optional(),
    sellerGstin: z.string().max(20).nullable().optional(),
    buyerGstin: z.string().max(20).nullable().optional(),
    invoiceNo: z.string().max(60).nullable().optional(),
    invoiceDate: isoDate.nullable().optional(),
    irn: z.string().max(100).nullable().optional(),
    docType: z.enum(["INV", "CRN", "DBN"]).optional(),
    vendorId: uuid.nullable().optional(),
    totals: z
      .object({
        taxablePaise: paise,
        cgstPaise: paise,
        sgstPaise: paise,
        igstPaise: paise,
        otherChargesPaise: paise,
        discountPaise: paise,
        roundOffPaise: paise,
        grandTotalPaise: paise,
      })
      .partial()
      .optional(),
  })
  .strict();

const reason = z.object({ reason: z.string().trim().min(2).max(500) });

export function invoiceRoutes(app: FastifyInstance, ctx: AppContext) {
  // ------------------------------------------------------------ capture

  app.post("/api/documents", async (req, reply) => {
    const user = userOf(req);
    if (!req.isMultipart()) throw new ApiError(415, "MULTIPART_REQUIRED", "Send the pages as multipart/form-data");
    const fields: Record<string, string[]> = {};
    const pages: UploadedPage[] = [];
    for await (const part of req.parts({ limits: { fileSize: MAX_PAGE_BYTES, files: MAX_PAGES } })) {
      if (part.type === "file") {
        if (part.fieldname !== "page") {
          await part.toBuffer();
          continue;
        }
        const data = await part.toBuffer();
        if (part.file.truncated) throw new ApiError(413, "PAGE_TOO_LARGE", `Each page must be at most ${MAX_PAGE_BYTES / 1024 / 1024} MB`);
        pages.push({ data, declaredMime: part.mimetype });
      } else {
        (fields[part.fieldname] ??= []).push(String(part.value));
      }
    }
    const storeId = parse(uuid, fields.storeId?.[0]);
    const clientId = parse(z.string().uuid("clientId must be a UUID"), fields.clientId?.[0]);
    let qr: string[] = [];
    for (const raw of fields.qr ?? []) {
      try {
        const v = JSON.parse(raw) as unknown;
        if (Array.isArray(v)) qr.push(...v.filter((x): x is string => typeof x === "string"));
        else if (typeof v === "string") qr.push(v);
      } catch {
        qr.push(raw); // a bare QR string
      }
    }
    qr = qr.filter((s) => s.length > 0 && s.length < 8000);
    const { response, replayed } = await capture(ctx, user, { storeId, clientId, qr, pages });
    return reply.code(replayed ? 200 : 201).send(response);
  });

  app.get("/api/documents/:id/pages/:n", async (req, reply) => {
    const user = userOf(req);
    const p = parse(z.object({ id: uuid, n: z.coerce.number().int().min(1).max(MAX_PAGES) }), req.params);
    const doc = await one<{ store_id: string; pages: StoredPage[] }>(ctx.pool, "SELECT store_id, pages FROM documents WHERE id = $1", [p.id]);
    if (!doc) throw notFound("Page not found");
    try {
      assertStoreAccess(user, doc.store_id);
    } catch {
      throw notFound("Page not found");
    }
    const page = doc.pages[p.n - 1];
    if (!page) throw notFound("Page not found");
    const data = await ctx.storage.get(page.key);
    return reply
      .header("Content-Type", page.mime)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("Content-Disposition", "inline")
      .header("ETag", `"${page.sha256}"`)
      .send(data);
  });

  // ------------------------------------------------------------ invoices

  app.get("/api/invoices", async (req) => {
    const q = parse(
      z.object({
        state: z.string().max(200).optional(),
        storeId: uuid.optional(),
        q: z.string().trim().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        cursor: z.string().max(200).optional(),
      }),
      req.query,
    );
    return inv.listInvoices(ctx.pool, userOf(req), q);
  });

  app.get("/api/invoices/:id", async (req) => inv.getDetail(ctx.pool, userOf(req), (req.params as { id: string }).id));

  app.post("/api/invoices/:id/lock-total", async (req) => {
    const { typedTotalPaise } = parse(z.object({ typedTotalPaise: paise.min(1) }), req.body);
    return inv.lockTotal(ctx, userOf(req), (req.params as { id: string }).id, typedTotalPaise);
  });

  app.put("/api/invoices/:id/header", async (req) => {
    const body = parse(headerUpdate, req.body);
    return inv.updateHeader(ctx, userOf(req), (req.params as { id: string }).id, body);
  });

  app.put("/api/invoices/:id/lines/:lineId", async (req) => {
    const params = parse(z.object({ id: uuid, lineId: uuid }), req.params);
    const body = parse(
      z.discriminatedUnion("action", [z.object({ action: z.literal("accept") }), z.object({ action: z.literal("remove") }), z.object({ action: z.literal("edit"), line: lineInput })]),
      req.body,
    );
    return inv.updateLine(ctx, userOf(req), params.id, params.lineId, body);
  });

  app.post("/api/invoices/:id/lines", async (req, reply) => {
    const body = parse(lineInput, req.body);
    return reply.code(201).send(await inv.addLine(ctx, userOf(req), (req.params as { id: string }).id, body));
  });

  app.post("/api/invoices/:id/seal", async (req) => {
    const { durationMs } = parse(z.object({ durationMs: z.number().int().min(0).max(24 * 3600_000) }), req.body ?? {});
    return inv.seal(ctx, userOf(req), (req.params as { id: string }).id, durationMs);
  });

  app.post("/api/invoices/:id/reject", async (req) => inv.reject(ctx, userOf(req), (req.params as { id: string }).id, parse(reason, req.body).reason));
  app.post("/api/invoices/:id/hold", async (req) => inv.hold(ctx, userOf(req), (req.params as { id: string }).id, parse(reason, req.body).reason));
  app.post("/api/invoices/:id/unhold", async (req) => inv.unhold(ctx, userOf(req), (req.params as { id: string }).id));
  app.post("/api/invoices/:id/re-extract", async (req) => inv.reExtract(ctx, userOf(req), (req.params as { id: string }).id));
}
