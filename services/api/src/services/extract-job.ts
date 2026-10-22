/** Worker handler for 'extract' jobs: pages → Extractor → merged draft + checks + vendor link → NEEDS_VERIFICATION. */
import { financialYear, isValidGstin, normalizeGstin, type EInvoiceQr, type FieldMeta, type HeaderField, type InvoiceHeader, type MergedExtraction, type PageImage } from "@arad/core";
import { audit, SYSTEM } from "../audit.js";
import type { AppContext } from "../context.js";
import { one, tx } from "../db.js";
import type { JobRow } from "../jobs.js";
import type { JobHandler } from "../worker.js";
import { dueDateFor, findLiveDuplicate, linkVendorByGstin, refresh } from "./invoices.js";
import type { StoredPage } from "./capture.js";

const int = (n: unknown, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback);
const text = (s: unknown, max: number) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);
const DOC_TYPES = new Set(["INV", "CRN", "DBN"]);

/** The e-invoice QR is signed by the GST portal, so its header values win over what was read from the photo. */
function applyQr(header: InvoiceHeader, meta: Partial<Record<HeaderField, FieldMeta>>, qr: EInvoiceQr | null) {
  if (!qr) return;
  const fromQr: Partial<InvoiceHeader> = {
    sellerGstin: qr.sellerGstin || undefined,
    buyerGstin: qr.buyerGstin || undefined,
    invoiceNo: qr.docNo || undefined,
    invoiceDate: qr.docDate || undefined,
    irn: qr.irn || undefined,
    docType: DOC_TYPES.has(qr.docType) ? (qr.docType as InvoiceHeader["docType"]) : undefined,
  };
  for (const [k, v] of Object.entries(fromQr) as [HeaderField, string | undefined][]) {
    if (!v) continue;
    const extracted = header[k];
    (header as Record<string, unknown>)[k] = v;
    meta[k] = {
      confidence: 1,
      reason: "from e-invoice QR",
      ...(extracted && extracted !== v ? { sources: { qr: v, extracted: String(extracted) } } : {}),
    };
  }
}

export function createExtractHandler(ctx: AppContext): JobHandler {
  return {
    async run(job: JobRow) {
      const invoiceId = String(job.payload.invoiceId ?? "");
      const started = await one<{ id: string; store_id: string; pages: StoredPage[] }>(
        ctx.pool,
        `UPDATE invoices i SET state = 'EXTRACTING', updated_at = now()
           FROM documents d
          WHERE i.id = $1 AND d.id = i.document_id AND i.state IN ('CAPTURED', 'EXTRACTING')
          RETURNING i.id, i.store_id, d.pages`,
        [invoiceId],
      );
      if (!started) return; // rejected, held or already done meanwhile: nothing to do (idempotent)

      const pages: PageImage[] = await Promise.all(started.pages.map(async (p) => ({ mime: p.mime, data: new Uint8Array(await ctx.storage.get(p.key)) })));
      const gstins = (await ctx.pool.query<{ gstin: string }>("SELECT gstin FROM stores WHERE gstin IS NOT NULL ORDER BY code")).rows.map((r) => r.gstin);
      // Put the capturing store's GSTIN first: it is the expected buyer.
      const own = await one<{ gstin: string | null }>(ctx.pool, "SELECT gstin FROM stores WHERE id = $1", [started.store_id]);
      const storeGstins = own?.gstin ? [own.gstin, ...gstins.filter((g) => g !== own.gstin)] : gstins;

      const t0 = Date.now();
      let merged: MergedExtraction;
      try {
        merged = await ctx.extractor.extract(pages, { dataClass: ctx.config.DATA_CLASS, storeGstins, invoiceId });
      } catch (e) {
        const err = (e as Error).message.slice(0, 500);
        await ctx.pool.query(
          `UPDATE invoices SET extraction_runs = extraction_runs || $2::jsonb, updated_at = now() WHERE id = $1`,
          [invoiceId, JSON.stringify([{ provider: "extractor", ok: false, ms: Date.now() - t0, error: err, at: new Date().toISOString(), attempt: job.attempts }])],
        );
        throw e;
      }

      await tx(ctx.pool, async (c) => {
        const inv = await one<{ state: string; qr: EInvoiceQr | null; vendor_id: string | null; captured_by: string }>(
          c,
          "SELECT state, qr, vendor_id, captured_by FROM invoices WHERE id = $1 FOR UPDATE",
          [invoiceId],
        );
        if (!inv || inv.state !== "EXTRACTING") return;

        const header: InvoiceHeader = { ...merged.header };
        header.sellerGstin = normalizeGstin(header.sellerGstin);
        header.buyerGstin = normalizeGstin(header.buyerGstin);
        const headerMeta = { ...merged.headerMeta };
        applyQr(header, headerMeta, inv.qr);
        const invoiceDate = header.invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(header.invoiceDate) && !Number.isNaN(Date.parse(header.invoiceDate)) ? header.invoiceDate : null;
        const docType = header.docType && DOC_TYPES.has(header.docType) ? header.docType : "INV";
        const fy = invoiceDate ? financialYear(invoiceDate) : null;
        const sellerGstin = header.sellerGstin && /^[0-9]{2}[A-Z0-9]{13}$/.test(header.sellerGstin) ? header.sellerGstin : null;
        const buyerGstin = header.buyerGstin && /^[0-9]{2}[A-Z0-9]{13}$/.test(header.buyerGstin) ? header.buyerGstin : null;
        const invoiceNo = text(header.invoiceNo, 60);

        const vendorId = (sellerGstin && isValidGstin(sellerGstin) ? await linkVendorByGstin(c, sellerGstin, header.vendorName, SYSTEM) : undefined) ?? inv.vendor_id;
        const due = await dueDateFor(c, vendorId ?? null, invoiceDate);
        const dup = await findLiveDuplicate(c, invoiceId, { irn: text(header.irn, 100), sellerGstin, invoiceNo, financialYear: fy, docType });
        const t = merged.totals;

        await c.query("DELETE FROM invoice_lines WHERE invoice_id = $1", [invoiceId]);
        const lines = merged.lines.map((l, idx) => ({
          idx,
          description: text(l.description, 300) ?? `Item ${idx + 1}`,
          hsn: typeof l.hsn === "string" && /^[0-9A-Z]{2,10}$/.test(l.hsn.toUpperCase().replace(/\s/g, "")) ? l.hsn.toUpperCase().replace(/\s/g, "") : null,
          qty_milli: int(l.qtyMilli),
          unit: text(l.unit, 20),
          mrp_paise: l.mrpPaise === undefined ? null : int(l.mrpPaise),
          rate_paise: int(l.ratePaise),
          discount_paise: int(l.discountPaise),
          gst_rate_bp: Math.min(10000, Math.max(0, int(l.gstRateBp))),
          taxable_paise: int(l.taxablePaise),
          tax_paise: int(l.taxPaise),
          total_paise: int(l.totalPaise),
          meta: l.meta ?? null,
          box: l.box ?? null,
        }));
        if (lines.length) {
          await c.query(
            `INSERT INTO invoice_lines (invoice_id, idx, description, hsn, qty_milli, unit, mrp_paise, rate_paise, discount_paise, gst_rate_bp, taxable_paise, tax_paise, total_paise, meta, box)
             SELECT $1, x.idx, x.description, x.hsn, x.qty_milli, x.unit, x.mrp_paise, x.rate_paise, x.discount_paise, x.gst_rate_bp, x.taxable_paise, x.tax_paise, x.total_paise, x.meta, x.box
               FROM jsonb_to_recordset($2::jsonb) AS x(idx int, description text, hsn text, qty_milli bigint, unit text, mrp_paise bigint, rate_paise bigint, discount_paise bigint,
                                                       gst_rate_bp int, taxable_paise bigint, tax_paise bigint, total_paise bigint, meta jsonb, box jsonb)`,
            [invoiceId, JSON.stringify(lines)],
          );
        }
        const runs = merged.runs.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, ms: r.ms, error: r.error, keySlot: r.keySlot, raw: r.raw, at: new Date().toISOString() }));
        await c.query(
          `UPDATE invoices SET
              state = $2, vendor_id = $3, vendor_name = $4, seller_gstin = $5, buyer_gstin = $6, invoice_no = $7, invoice_date = $8, irn = $9, doc_type = $10,
              financial_year = $11, taxable_paise = $12, cgst_paise = $13, sgst_paise = $14, igst_paise = $15, other_charges_paise = $16, discount_paise = $17,
              round_off_paise = $18, grand_total_paise = $19, header_meta = $20, totals_meta = $21, extraction_runs = $22, due_date = $23,
              duplicate_of = $24, duplicate_reason = $25, updated_at = now()
            WHERE id = $1`,
          [
            invoiceId,
            dup ? "DUPLICATE" : "NEEDS_VERIFICATION",
            vendorId ?? null,
            text(header.vendorName, 120),
            sellerGstin,
            buyerGstin,
            invoiceNo,
            invoiceDate,
            text(header.irn, 100),
            docType,
            fy,
            int(t.taxablePaise),
            int(t.cgstPaise),
            int(t.sgstPaise),
            int(t.igstPaise),
            int(t.otherChargesPaise),
            int(t.discountPaise),
            int(t.roundOffPaise),
            int(t.grandTotalPaise),
            JSON.stringify(headerMeta),
            JSON.stringify(merged.totalsMeta ?? {}),
            JSON.stringify(runs),
            due,
            dup?.invoiceId ?? null,
            dup?.reason ?? null,
          ],
        );
        const { row } = await refresh(c, undefined, invoiceId);
        await audit(c, SYSTEM, {
          action: "invoice.extracted",
          entity: "invoice",
          entityId: invoiceId,
          detail: {
            state: row.state,
            lines: lines.length,
            providers: runs.map((r) => ({ provider: r.provider, ok: r.ok, ms: r.ms })),
            failedChecks: row.checks.filter((x) => x.status === "fail").map((x) => x.id),
            duplicateOf: dup,
          },
        });
      });
    },

    async onDead(job: JobRow, error: Error) {
      const invoiceId = String(job.payload.invoiceId ?? "");
      await tx(ctx.pool, async (c) => {
        const r = await c.query(`UPDATE invoices SET state = 'EXTRACTION_FAILED', updated_at = now() WHERE id = $1 AND state IN ('CAPTURED', 'EXTRACTING')`, [invoiceId]);
        if (r.rowCount) {
          await refresh(c, undefined, invoiceId);
          await audit(c, SYSTEM, { action: "invoice.extraction_failed", entity: "invoice", entityId: invoiceId, detail: { attempts: job.attempts, error: error.message.slice(0, 300) } });
        }
      });
    },
  };
}
