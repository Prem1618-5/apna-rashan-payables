/** POST /api/documents: store pages, parse QR, detect duplicates, create the invoice and enqueue extraction atomically. */
import { randomUUID } from "node:crypto";
import { classifyQr, financialYear, normalizeGstin, type CaptureResponse, type EInvoiceQr, type PageImage } from "@arad/core";
import { audit } from "../audit.js";
import { actorOf, assertStoreAccess, type AppContext, type SessionUser } from "../context.js";
import { sha256Hex } from "../crypto.js";
import { one, tx } from "../db.js";
import { ApiError, conflict } from "../errors.js";
import { enqueue } from "../jobs.js";
import { findLiveDuplicate } from "./invoices.js";

export const MAX_PAGES = 10;
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export interface UploadedPage {
  data: Buffer;
  declaredMime?: string;
}

export interface StoredPage {
  key: string;
  sha256: string;
  mime: PageImage["mime"];
  bytes: number;
}

/** Trust the bytes, not the declared type. */
export function sniffMime(b: Buffer): PageImage["mime"] | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return undefined;
}

const EXT: Record<PageImage["mime"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

const DOC_TYPES: Record<string, "INV" | "CRN" | "DBN"> = { INV: "INV", CRN: "CRN", DBN: "DBN" };

export interface CaptureInput {
  storeId: string;
  clientId: string;
  qr: string[];
  pages: UploadedPage[];
}

async function replay(ctx: AppContext, user: SessionUser, clientId: string): Promise<CaptureResponse | undefined> {
  const prev = await one<{ store_id: string; response: CaptureResponse | null }>(ctx.pool, "SELECT store_id, response FROM documents WHERE client_id = $1", [clientId]);
  if (!prev) return undefined;
  assertStoreAccess(user, prev.store_id);
  if (!prev.response) throw conflict("CAPTURE_IN_PROGRESS", "This upload is still being saved; try again shortly");
  return prev.response;
}

export async function capture(ctx: AppContext, user: SessionUser, input: CaptureInput): Promise<{ response: CaptureResponse; replayed: boolean }> {
  assertStoreAccess(user, input.storeId);
  const earlier = await replay(ctx, user, input.clientId);
  if (earlier) return { response: earlier, replayed: true };

  if (!input.pages.length) throw new ApiError(400, "NO_PAGES", "Attach at least one page");
  if (input.pages.length > MAX_PAGES) throw new ApiError(400, "TOO_MANY_PAGES", `At most ${MAX_PAGES} pages`);
  const mimes = input.pages.map((p) => sniffMime(p.data));
  if (mimes.some((m) => !m)) throw new ApiError(415, "UNSUPPORTED_FILE", "Pages must be JPEG, PNG or WebP images, or one PDF");
  if (mimes.includes("application/pdf") && input.pages.length > 1) throw new ApiError(400, "PDF_ALONE", "A PDF must be uploaded on its own");

  const store = await one<{ id: string }>(ctx.pool, "SELECT id FROM stores WHERE id = $1", [input.storeId]);
  if (!store) throw new ApiError(404, "NOT_FOUND", "Store not found");

  const documentId = randomUUID();
  const invoiceId = randomUUID();
  const pages: StoredPage[] = input.pages.map((p, i) => ({
    key: `documents/${input.storeId}/${documentId}/${i + 1}.${EXT[mimes[i]!]}`,
    sha256: sha256Hex(p.data),
    mime: mimes[i]!,
    bytes: p.data.length,
  }));

  // Parse QR codes from the phone. Only an e-invoice QR is used as data; a UPI QR is never used as bank details.
  const classified = input.qr.slice(0, 20).map((raw) => classifyQr(raw));
  const einv: EInvoiceQr | undefined = classified.find((q) => q.kind === "einvoice")?.data as EInvoiceQr | undefined;
  const qrPayloads = classified.map((q) => ({ kind: q.kind, raw: q.raw.slice(0, 4000) }));

  // Write the images first (immutable, content-hashed); a failed transaction only leaves orphans.
  await Promise.all(pages.map((p, i) => ctx.storage.put(p.key, input.pages[i]!.data, p.mime)));

  try {
    const result = await tx(ctx.pool, async (c) => {
      // Serialise captures so two uploads of the same bill can't both be "first".
      await c.query("SELECT pg_advisory_xact_lock(7243100002)");
      const again = await one<{ response: CaptureResponse | null }>(c, "SELECT response FROM documents WHERE client_id = $1", [input.clientId]);
      if (again?.response) return { response: again.response, replayed: true };

      let duplicateOf: CaptureResponse["duplicateOf"];
      const sameImage = await one<{ invoice_id: string; duplicate_of: string | null }>(
        c,
        `SELECT i.id AS invoice_id, i.duplicate_of FROM documents d JOIN invoices i ON i.document_id = d.id
          WHERE d.page_sha256 && $1::text[] AND i.state <> 'REJECTED'
          ORDER BY (i.state = 'DUPLICATE'), d.created_at LIMIT 1`,
        [pages.map((p) => p.sha256)],
      );
      if (sameImage) duplicateOf = { invoiceId: sameImage.duplicate_of ?? sameImage.invoice_id, reason: "same_image" };

      const sellerGstin = normalizeGstin(einv?.sellerGstin);
      const fy = einv?.docDate ? financialYear(einv.docDate) : null;
      const docType = DOC_TYPES[einv?.docType ?? "INV"] ?? "INV";
      if (!duplicateOf && einv) {
        const d = await findLiveDuplicate(c, undefined, { irn: einv.irn, sellerGstin, invoiceNo: einv.docNo || null, financialYear: fy, docType });
        if (d) duplicateOf = d;
      }

      await c.query(
        `INSERT INTO documents (id, store_id, client_id, captured_by, page_count, pages, page_sha256, qr_payloads)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [documentId, input.storeId, input.clientId, user.id, pages.length, JSON.stringify(pages), pages.map((p) => p.sha256), JSON.stringify(qrPayloads)],
      );
      const state = duplicateOf ? "DUPLICATE" : "CAPTURED";
      const qrMeta = einv ? { confidence: 1, reason: "from e-invoice QR" } : undefined;
      await c.query(
        `INSERT INTO invoices (id, store_id, document_id, state, captured_by, qr, seller_gstin, buyer_gstin, invoice_no, invoice_date, irn, doc_type,
                               financial_year, grand_total_paise, header_meta, duplicate_of, duplicate_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          invoiceId,
          input.storeId,
          documentId,
          state,
          user.id,
          einv ? JSON.stringify(einv) : null,
          sellerGstin ?? null,
          normalizeGstin(einv?.buyerGstin) ?? null,
          einv?.docNo || null,
          einv?.docDate || null,
          einv?.irn ?? null,
          docType,
          fy,
          einv?.totalPaise ?? 0,
          JSON.stringify(qrMeta ? { sellerGstin: qrMeta, buyerGstin: qrMeta, invoiceNo: qrMeta, invoiceDate: qrMeta, irn: qrMeta } : {}),
          duplicateOf?.invoiceId ?? null,
          duplicateOf?.reason ?? null,
        ],
      );
      if (!duplicateOf) await enqueue(c, "extract", { invoiceId }, { dedupeKey: `extract:${invoiceId}` });
      const response: CaptureResponse = { documentId, invoiceId, state, ...(duplicateOf ? { duplicateOf } : {}) };
      await c.query("UPDATE documents SET response = $2 WHERE id = $1", [documentId, JSON.stringify(response)]);
      await audit(c, actorOf(user), {
        action: "invoice.capture",
        entity: "invoice",
        entityId: invoiceId,
        detail: { documentId, storeId: input.storeId, pages: pages.length, qr: classified.map((q) => q.kind), duplicateOf },
      });
      return { response, replayed: false };
    });
    if (result.replayed) await Promise.all(pages.map((p) => ctx.storage.delete(p.key).catch(() => undefined)));
    return result;
  } catch (e) {
    await Promise.all(pages.map((p) => ctx.storage.delete(p.key).catch(() => undefined)));
    // Lost a race on client_id with a concurrent retry of the same upload: replay its answer.
    if ((e as { code?: string }).code === "23505" && (e as { constraint?: string }).constraint === "documents_client_id_key") {
      const r = await replay(ctx, user, input.clientId);
      if (r) return { response: r, replayed: true };
    }
    throw e;
  }
}
