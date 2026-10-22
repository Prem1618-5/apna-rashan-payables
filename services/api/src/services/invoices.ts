/** Invoice reads, mapping to the API contract, checks and the human verification flow. */
import {
  balanceHints,
  blockingFailures,
  computeLine,
  financialYear,
  isValidGstin,
  normalizeGstin,
  runChecks,
  verificationBalance,
  type CheckResult,
  type EInvoiceQr,
  type FieldMeta,
  type HeaderField,
  type InvoiceDetail,
  type InvoiceHeader,
  type InvoiceLine,
  type InvoiceState,
  type InvoiceSummary,
  type InvoiceTotals,
  type LineInput,
  type LineStatus,
  type TotalsField,
} from "@arad/core";
import { audit } from "../audit.js";
import { actorOf, isOwner, storeScope, type AppContext, type SessionUser } from "../context.js";
import { many, one, tx, isUniqueViolation, type Db } from "../db.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";
import { enqueue } from "../jobs.js";

// ---------------------------------------------------------------- rows

export interface InvoiceRow {
  id: string;
  store_id: string;
  store_name: string;
  store_code: string;
  document_id: string;
  page_count: number;
  state: InvoiceState;
  held_from_state: InvoiceState | null;
  vendor_id: string | null;
  vendor_master_name: string | null;
  vendor_name: string | null;
  seller_gstin: string | null;
  buyer_gstin: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  irn: string | null;
  doc_type: "INV" | "CRN" | "DBN";
  financial_year: string | null;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  other_charges_paise: number;
  discount_paise: number;
  round_off_paise: number;
  grand_total_paise: number;
  header_meta: Partial<Record<HeaderField, FieldMeta>>;
  totals_meta: Partial<Record<TotalsField, FieldMeta>>;
  qr: EInvoiceQr | null;
  locked_total_paise: number | null;
  lock_attempts: number;
  lock_flagged: boolean;
  checks: CheckResult[];
  extraction_runs: { provider: string; model?: string; ok: boolean; ms: number; error?: string }[];
  flagged_count: number;
  due_date: string | null;
  hold_reason: string | null;
  reject_reason: string | null;
  duplicate_of: string | null;
  duplicate_reason: string | null;
  captured_by: string;
  captured_by_name: string;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_at: Date | null;
  verify_duration_ms: number | null;
  edit_count: number;
  created_at: Date;
  line_count?: number;
}

export const INVOICE_SELECT = `
  SELECT i.*, s.name AS store_name, s.code AS store_code, d.page_count,
         v.name AS vendor_master_name, cu.name AS captured_by_name, vu.name AS verified_by_name
    FROM invoices i
    JOIN stores s ON s.id = i.store_id
    JOIN documents d ON d.id = i.document_id
    JOIN users cu ON cu.id = i.captured_by
    LEFT JOIN vendors v ON v.id = i.vendor_id
    LEFT JOIN users vu ON vu.id = i.verified_by`;

interface LineRow {
  id: string;
  idx: number;
  description: string;
  hsn: string | null;
  qty_milli: number;
  unit: string | null;
  mrp_paise: number | null;
  rate_paise: number;
  discount_paise: number;
  gst_rate_bp: number;
  taxable_paise: number;
  tax_paise: number;
  total_paise: number;
  status: LineStatus;
  meta: InvoiceLine["meta"] | null;
  box: InvoiceLine["box"] | null;
}

const u = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export function lineFromRow(r: LineRow): InvoiceLine {
  return {
    id: r.id,
    idx: r.idx,
    description: r.description,
    hsn: u(r.hsn),
    qtyMilli: r.qty_milli,
    unit: u(r.unit),
    mrpPaise: u(r.mrp_paise),
    ratePaise: r.rate_paise,
    discountPaise: r.discount_paise,
    gstRateBp: r.gst_rate_bp,
    taxablePaise: r.taxable_paise,
    taxPaise: r.tax_paise,
    totalPaise: r.total_paise,
    status: r.status,
    meta: u(r.meta),
    box: u(r.box),
  };
}

export async function loadLines(db: Db, invoiceId: string): Promise<InvoiceLine[]> {
  return (await many<LineRow>(db, "SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY idx", [invoiceId])).map(lineFromRow);
}

export function rowHeader(r: Pick<InvoiceRow, "vendor_name" | "seller_gstin" | "buyer_gstin" | "invoice_no" | "invoice_date" | "irn" | "doc_type">): InvoiceHeader {
  return {
    vendorName: u(r.vendor_name),
    sellerGstin: u(r.seller_gstin),
    buyerGstin: u(r.buyer_gstin),
    invoiceNo: u(r.invoice_no),
    invoiceDate: u(r.invoice_date),
    irn: u(r.irn),
    docType: r.doc_type,
  };
}

export function rowTotals(r: InvoiceRow): InvoiceTotals {
  return {
    taxablePaise: r.taxable_paise,
    cgstPaise: r.cgst_paise,
    sgstPaise: r.sgst_paise,
    igstPaise: r.igst_paise,
    otherChargesPaise: r.other_charges_paise,
    discountPaise: r.discount_paise,
    roundOffPaise: r.round_off_paise,
    grandTotalPaise: r.grand_total_paise,
  };
}

export const pageUrl = (documentId: string, n: number) => `/api/documents/${documentId}/pages/${n}`;

/** States in which a person can still change the bill's data. */
export const EDITABLE: InvoiceState[] = ["NEEDS_VERIFICATION", "EXTRACTION_FAILED"];

/**
 * Blind entry: until the staff member has typed the printed total, the machine's grand total is not
 * revealed (it would anchor them). The value is replaced by 0 and totalsMeta says why.
 */
function isBlind(r: InvoiceRow) {
  return EDITABLE.includes(r.state) && r.locked_total_paise === null;
}

export function toDetail(r: InvoiceRow, lines: InvoiceLine[]): InvoiceDetail {
  const blind = isBlind(r);
  const totals = rowTotals(r);
  const totalsMeta = { ...r.totals_meta };
  let qr = u(r.qr);
  if (blind) {
    totals.grandTotalPaise = 0;
    totalsMeta.grandTotalPaise = { confidence: totalsMeta.grandTotalPaise?.confidence ?? 0, reason: "hidden_until_locked" };
    if (qr) qr = { ...qr, totalPaise: 0 };
  }
  return {
    id: r.id,
    storeId: r.store_id,
    state: r.state,
    vendorId: u(r.vendor_id),
    vendorName: r.vendor_master_name ?? u(r.vendor_name),
    header: rowHeader(r),
    headerMeta: r.header_meta,
    totals,
    totalsMeta,
    lines,
    checks: blind ? r.checks.filter((c) => c.id !== "qr_total") : r.checks,
    qr,
    lockedTotalPaise: u(r.locked_total_paise),
    pages: Array.from({ length: r.page_count }, (_, i) => ({ url: pageUrl(r.document_id, i + 1) })),
    dueDate: u(r.due_date),
    duplicateOfId: u(r.duplicate_of),
    holdReason: u(r.hold_reason),
    createdAt: r.created_at.toISOString(),
    capturedBy: r.captured_by_name,
    verifiedBy: u(r.verified_by_name),
    verifiedAt: r.verified_at?.toISOString(),
    extraction: r.extraction_runs.length ? { providers: r.extraction_runs.map((x) => ({ provider: x.provider, ok: x.ok, ms: x.ms, error: x.error })) } : undefined,
  };
}

export function toSummary(r: InvoiceRow): InvoiceSummary {
  return {
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    state: r.state,
    vendorId: u(r.vendor_id),
    vendorName: r.vendor_master_name ?? u(r.vendor_name),
    invoiceNo: u(r.invoice_no),
    invoiceDate: u(r.invoice_date),
    grandTotalPaise: isBlind(r) || r.state === "CAPTURED" || r.state === "EXTRACTING" ? undefined : r.grand_total_paise,
    lineCount: r.line_count ?? 0,
    flaggedCount: r.flagged_count,
    createdAt: r.created_at.toISOString(),
    thumbUrl: pageUrl(r.document_id, 1),
  };
}

/** Load an invoice the user may see (404 otherwise, so other stores' bills are not even confirmed to exist). */
export async function loadInvoice(db: Db, user: SessionUser, id: string, opts: { forUpdate?: boolean } = {}): Promise<InvoiceRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Invoice not found");
  const params: unknown[] = [id];
  const scope = storeScope(user, "i.store_id", params);
  const row = await one<InvoiceRow>(db, `${INVOICE_SELECT} WHERE i.id = $1 AND ${scope}${opts.forUpdate ? " FOR UPDATE OF i" : ""}`, params);
  if (!row) throw notFound("Invoice not found");
  return row;
}

export async function getDetail(db: Db, user: SessionUser, id: string): Promise<InvoiceDetail> {
  const row = await loadInvoice(db, user, id);
  return toDetail(row, await loadLines(db, id));
}

// ---------------------------------------------------------------- list

export interface ListQuery {
  state?: string;
  storeId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export async function listInvoices(db: Db, user: SessionUser, query: ListQuery): Promise<{ items: InvoiceSummary[]; nextCursor?: string }> {
  const params: unknown[] = [];
  const where: string[] = [storeScope(user, "i.store_id", params)];
  if (query.state) {
    const states = query.state.split(",").map((s) => s.trim()).filter(Boolean);
    params.push(states);
    where.push(`i.state = ANY($${params.length}::text[])`);
  }
  if (query.storeId) {
    params.push(query.storeId);
    where.push(`i.store_id = $${params.length}::uuid`);
  }
  if (query.q) {
    params.push(`%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const p = `$${params.length}`;
    where.push(`(i.invoice_no ILIKE ${p} OR i.vendor_name ILIKE ${p} OR v.name ILIKE ${p} OR i.seller_gstin ILIKE ${p})`);
  }
  if (query.cursor) {
    const [ts, cid] = Buffer.from(query.cursor, "base64url").toString("utf8").split("|");
    if (!ts || !cid || Number.isNaN(Date.parse(ts))) throw new ApiError(400, "BAD_CURSOR", "Invalid cursor");
    params.push(ts, cid);
    where.push(`(i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  params.push(limit + 1);
  const rows = await many<InvoiceRow>(
    db,
    `${INVOICE_SELECT.replace("SELECT i.*,", "SELECT i.*, (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id = i.id AND l.status <> 'removed') AS line_count,")}
      WHERE ${where.join(" AND ")}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toSummary),
    nextCursor: rows.length > limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString("base64url") : undefined,
  };
}

// ---------------------------------------------------------------- checks

export async function storeGstins(db: Db): Promise<string[]> {
  return (await many<{ gstin: string }>(db, "SELECT gstin FROM stores WHERE gstin IS NOT NULL")).map((r) => r.gstin);
}

export function countFlags(headerMeta: object, totalsMeta: object, lines: InvoiceLine[], lockFlagged: boolean): number {
  const flagged = (m: object | undefined) => Object.values(m ?? {}).filter((f) => (f as FieldMeta | undefined)?.flagged).length;
  return flagged(headerMeta) + flagged(totalsMeta) + lines.filter((l) => l.status !== "removed").reduce((s, l) => s + flagged(l.meta), 0) + (lockFlagged ? 1 : 0);
}

export function checksFor(r: InvoiceRow, lines: InvoiceLine[], gstins: string[]): CheckResult[] {
  return runChecks(
    { header: rowHeader(r), totals: rowTotals(r), lines, qr: u(r.qr), lockedTotalPaise: u(r.locked_total_paise) },
    { storeGstins: gstins, today: istToday() },
  );
}

/** Re-run checks and the flag count after any change; returns the fresh row and lines. */
export async function refresh(db: Db, user: SessionUser | undefined, invoiceId: string): Promise<{ row: InvoiceRow; lines: InvoiceLine[] }> {
  const row = await one<InvoiceRow>(db, `${INVOICE_SELECT} WHERE i.id = $1`, [invoiceId]);
  if (!row) throw notFound("Invoice not found");
  const lines = await loadLines(db, invoiceId);
  const checks = checksFor(row, lines, await storeGstins(db));
  const flaggedCount = countFlags(row.header_meta, row.totals_meta, lines, row.lock_flagged);
  await db.query("UPDATE invoices SET checks = $2, flagged_count = $3, updated_at = now() WHERE id = $1", [invoiceId, JSON.stringify(checks), flaggedCount]);
  void user;
  return { row: { ...row, checks, flagged_count: flaggedCount }, lines };
}

/** Today's date in India (all business dates are IST). */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- events

export async function recordEvent(db: Db, invoiceId: string, userId: string, action: string, detail?: unknown, lineId?: string) {
  await db.query(
    `INSERT INTO verification_events (invoice_id, line_id, user_id, action, detail, ms_since_prev)
     SELECT $1, $2, $3, $4, $5,
            (SELECT least(2147483647, (extract(epoch FROM (clock_timestamp() - max(at))) * 1000))::int
               FROM verification_events WHERE invoice_id = $1 AND user_id = $3)`,
    [invoiceId, lineId ?? null, userId, action, detail === undefined ? null : JSON.stringify(detail)],
  );
}

// ---------------------------------------------------------------- verification

function assertEditable(r: InvoiceRow) {
  if (!EDITABLE.includes(r.state)) throw conflict("INVALID_STATE", `This bill is ${r.state} and can no longer be changed here`, { state: r.state });
}

export async function lockTotal(ctx: AppContext, user: SessionUser, id: string, typedTotalPaise: number) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    assertEditable(r);
    if (r.locked_total_paise !== null) throw conflict("ALREADY_LOCKED", "The total for this bill is already locked", { lockedTotalPaise: r.locked_total_paise });
    const extracted = r.grand_total_paise;
    const attempts = r.lock_attempts + 1;
    const match = typedTotalPaise === extracted && extracted !== 0;
    // Nothing to compare against when extraction failed: the paper total is taken as typed, flagged.
    const noExtraction = r.state === "EXTRACTION_FAILED" || extracted === 0;
    let locked: number | null = null;
    let flagged = false;
    if (match) locked = typedTotalPaise;
    else if (attempts >= 2 || noExtraction) {
      locked = typedTotalPaise;
      flagged = true;
    }
    const totalsMeta = { ...r.totals_meta };
    if (flagged) {
      totalsMeta.grandTotalPaise = {
        ...(totalsMeta.grandTotalPaise ?? { confidence: 0 }),
        flagged: true,
        reason: noExtraction ? "No machine total; typed from paper" : "Typed total differs from the machine reading twice; typed value kept",
        sources: { typed: String(typedTotalPaise), extracted: String(extracted) },
      };
    }
    await c.query(
      `UPDATE invoices SET lock_attempts = $2, locked_total_paise = $3, lock_flagged = lock_flagged OR $4, totals_meta = $5, updated_at = now() WHERE id = $1`,
      [id, attempts, locked, flagged, JSON.stringify(totalsMeta)],
    );
    await recordEvent(c, id, user.id, "lock_total", { typedTotalPaise, extractedTotalPaise: extracted, match, attempt: attempts, locked: locked !== null });
    if (locked !== null) {
      await audit(c, actorOf(user), { action: "invoice.lock_total", entity: "invoice", entityId: id, detail: { lockedTotalPaise: locked, extractedTotalPaise: extracted, attempts, flagged } });
    }
    const { row, lines } = await refresh(c, user, id);
    return { match, extractedTotalPaise: extracted, attempts, invoice: toDetail(row, lines) };
  });
}

function lineValues(input: LineInput) {
  const computed = computeLine(input);
  const totalPaise = input.totalPaise ?? computed.totalPaise;
  return { ...computed, totalPaise };
}

export async function updateLine(ctx: AppContext, user: SessionUser, id: string, lineId: string, update: { action: "accept" } | { action: "remove" } | { action: "edit"; line: LineInput }) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    assertEditable(r);
    const line = await one<LineRow & { original: unknown }>(c, "SELECT * FROM invoice_lines WHERE id = $1 AND invoice_id = $2", [lineId, id]);
    if (!line) throw notFound("Line not found");
    if (update.action === "accept") {
      await c.query("UPDATE invoice_lines SET status = 'accepted', updated_at = now() WHERE id = $1", [lineId]);
      await recordEvent(c, id, user.id, "accept", { totalPaise: line.total_paise }, lineId);
    } else if (update.action === "remove") {
      await c.query("UPDATE invoice_lines SET status = 'removed', updated_at = now() WHERE id = $1", [lineId]);
      await c.query("UPDATE invoices SET edit_count = edit_count + 1 WHERE id = $1", [id]);
      await recordEvent(c, id, user.id, "remove", { totalPaise: line.total_paise }, lineId);
      await audit(c, actorOf(user), { action: "invoice.line_remove", entity: "invoice", entityId: id, detail: { lineId, idx: line.idx, totalPaise: line.total_paise } });
    } else {
      const l = update.line;
      const v = lineValues(l);
      const before = lineFromRow(line);
      const original = line.original ?? { description: before.description, hsn: before.hsn, qtyMilli: before.qtyMilli, unit: before.unit, mrpPaise: before.mrpPaise, ratePaise: before.ratePaise, discountPaise: before.discountPaise, gstRateBp: before.gstRateBp, totalPaise: before.totalPaise };
      // Fields the person typed are now certain; clear machine flags on them.
      const meta = Object.fromEntries(Object.entries(before.meta ?? {}).map(([k, m]) => [k, { ...m, confidence: 1, flagged: false }]));
      await c.query(
        `UPDATE invoice_lines SET description = $2, hsn = $3, qty_milli = $4, unit = $5, mrp_paise = $6, rate_paise = $7, discount_paise = $8,
                gst_rate_bp = $9, taxable_paise = $10, tax_paise = $11, total_paise = $12, status = 'edited', original = $13, meta = $14, updated_at = now()
          WHERE id = $1`,
        [lineId, l.description, l.hsn ?? null, l.qtyMilli, l.unit ?? null, l.mrpPaise ?? null, l.ratePaise, l.discountPaise, l.gstRateBp, v.taxablePaise, v.taxPaise, v.totalPaise, JSON.stringify(original), JSON.stringify(meta)],
      );
      await c.query("UPDATE invoices SET edit_count = edit_count + 1 WHERE id = $1", [id]);
      await recordEvent(c, id, user.id, "edit", { before: { qtyMilli: before.qtyMilli, ratePaise: before.ratePaise, discountPaise: before.discountPaise, gstRateBp: before.gstRateBp, totalPaise: before.totalPaise }, after: { ...l, ...v } }, lineId);
      await audit(c, actorOf(user), { action: "invoice.line_edit", entity: "invoice", entityId: id, detail: { lineId, idx: line.idx, beforeTotalPaise: before.totalPaise, afterTotalPaise: v.totalPaise } });
    }
    const { row, lines } = await refresh(c, user, id);
    return toDetail(row, lines);
  });
}

export async function addLine(ctx: AppContext, user: SessionUser, id: string, l: LineInput) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    assertEditable(r);
    const v = lineValues(l);
    const next = await one<{ idx: number }>(c, "SELECT coalesce(max(idx) + 1, 0)::int AS idx FROM invoice_lines WHERE invoice_id = $1", [id]);
    const ins = await one<{ id: string }>(
      c,
      `INSERT INTO invoice_lines (invoice_id, idx, description, hsn, qty_milli, unit, mrp_paise, rate_paise, discount_paise, gst_rate_bp, taxable_paise, tax_paise, total_paise, status, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'edited', 'manual') RETURNING id`,
      [id, next!.idx, l.description, l.hsn ?? null, l.qtyMilli, l.unit ?? null, l.mrpPaise ?? null, l.ratePaise, l.discountPaise, l.gstRateBp, v.taxablePaise, v.taxPaise, v.totalPaise],
    );
    await c.query("UPDATE invoices SET edit_count = edit_count + 1 WHERE id = $1", [id]);
    await recordEvent(c, id, user.id, "add_line", { ...l, ...v }, ins!.id);
    await audit(c, actorOf(user), { action: "invoice.line_add", entity: "invoice", entityId: id, detail: { lineId: ins!.id, totalPaise: v.totalPaise } });
    const { row, lines } = await refresh(c, user, id);
    return toDetail(row, lines);
  });
}

export interface HeaderUpdateInput {
  vendorName?: string | null;
  sellerGstin?: string | null;
  buyerGstin?: string | null;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  irn?: string | null;
  docType?: "INV" | "CRN" | "DBN";
  vendorId?: string | null;
  totals?: Partial<InvoiceTotals>;
}

const HEADER_COLUMNS: Record<Exclude<keyof InvoiceHeader, never>, string> = {
  vendorName: "vendor_name",
  sellerGstin: "seller_gstin",
  buyerGstin: "buyer_gstin",
  invoiceNo: "invoice_no",
  invoiceDate: "invoice_date",
  irn: "irn",
  docType: "doc_type",
};
const TOTAL_COLUMNS: Record<TotalsField, string> = {
  taxablePaise: "taxable_paise",
  cgstPaise: "cgst_paise",
  sgstPaise: "sgst_paise",
  igstPaise: "igst_paise",
  otherChargesPaise: "other_charges_paise",
  discountPaise: "discount_paise",
  roundOffPaise: "round_off_paise",
  grandTotalPaise: "grand_total_paise",
};

/** The vendor's payment terms decide the due date. */
export async function dueDateFor(db: Db, vendorId: string | null, invoiceDate: string | null): Promise<string | null> {
  if (!vendorId || !invoiceDate) return null;
  const v = await one<{ payment_terms_days: number }>(db, "SELECT payment_terms_days FROM vendors WHERE id = $1", [vendorId]);
  return v ? addDays(invoiceDate, v.payment_terms_days) : null;
}

/** Find a live invoice with the same IRN or the same seller + number + financial year. */
export async function findLiveDuplicate(
  db: Db,
  selfId: string | undefined,
  h: { irn?: string | null; sellerGstin?: string | null; invoiceNo?: string | null; financialYear?: string | null; docType?: string },
): Promise<{ invoiceId: string; reason: "same_irn" | "same_number" } | undefined> {
  if (h.irn) {
    const r = await one<{ id: string }>(db, `SELECT id FROM invoices WHERE irn = $1 AND state NOT IN ('DUPLICATE', 'REJECTED') AND id IS DISTINCT FROM $2::uuid ORDER BY created_at LIMIT 1`, [h.irn, selfId ?? null]);
    if (r) return { invoiceId: r.id, reason: "same_irn" };
  }
  if (h.sellerGstin && h.invoiceNo && h.financialYear) {
    const r = await one<{ id: string }>(
      db,
      `SELECT id FROM invoices WHERE seller_gstin = $1 AND upper(invoice_no) = upper($2) AND financial_year = $3 AND doc_type = $4
          AND state NOT IN ('DUPLICATE', 'REJECTED') AND id IS DISTINCT FROM $5::uuid ORDER BY created_at LIMIT 1`,
      [h.sellerGstin, h.invoiceNo, h.financialYear, h.docType ?? "INV", selfId ?? null],
    );
    if (r) return { invoiceId: r.id, reason: "same_number" };
  }
  return undefined;
}

/** Find a vendor by GSTIN or create a PENDING one (never with bank details). */
export async function linkVendorByGstin(db: Db, gstin: string | null | undefined, vendorName: string | null | undefined, actor: { id?: string; name: string }): Promise<string | undefined> {
  if (!gstin || !isValidGstin(gstin)) return undefined;
  const found = await one<{ id: string }>(db, "SELECT id FROM vendors WHERE gstin = $1", [gstin]);
  if (found) return found.id;
  const name = (vendorName ?? "").trim().slice(0, 120) || `Vendor ${gstin}`;
  const created = await one<{ id: string }>(
    db,
    `INSERT INTO vendors (name, gstin, pan, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (gstin) DO NOTHING RETURNING id`,
    [name, gstin, gstin.slice(2, 12), actor.id ?? null],
  );
  if (created) {
    await audit(db, actor, { action: "vendor.auto_create", entity: "vendor", entityId: created.id, detail: { name, gstin, status: "PENDING" } });
    return created.id;
  }
  return (await one<{ id: string }>(db, "SELECT id FROM vendors WHERE gstin = $1", [gstin]))?.id;
}

export async function updateHeader(ctx: AppContext, user: SessionUser, id: string, input: HeaderUpdateInput) {
  try {
    return await tx(ctx.pool, async (c) => {
      const r = await loadInvoice(c, user, id, { forUpdate: true });
      const onlyVendor = Object.keys(input).every((k) => k === "vendorId");
      if (r.state === "VERIFIED") {
        // After sealing, only the owner may re-link the vendor (e.g. two vendor records merged).
        if (!onlyVendor) throw conflict("INVOICE_SEALED", "This bill is verified; its data can no longer be edited");
        if (!isOwner(user)) throw forbidden("Only the owner can change the vendor of a verified bill");
        const inRun = await one(c, "SELECT 1 FROM payment_run_bills WHERE invoice_id = $1 AND active", [id]);
        if (inRun) throw conflict("IN_PAYMENT_RUN", "This bill is in a payment run; cancel the run first");
      } else assertEditable(r);

      const sets: string[] = [];
      const vals: unknown[] = [id];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      const headerMeta = { ...r.header_meta };
      const totalsMeta = { ...r.totals_meta };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const next = { ...rowHeader(r) } as Record<string, string | undefined>;

      for (const key of Object.keys(HEADER_COLUMNS) as (keyof InvoiceHeader)[]) {
        if (!(key in input)) continue;
        let v = (input as Record<string, unknown>)[key] as string | null | undefined;
        if (typeof v === "string") v = v.trim();
        if (key === "sellerGstin" || key === "buyerGstin") v = normalizeGstin(v ?? undefined) ?? null;
        if (key === "docType" && !v) continue;
        if (v === "") v = null;
        const before = (rowHeader(r) as Record<string, unknown>)[key] ?? null;
        if (before === (v ?? null)) continue;
        changes[key] = { from: before, to: v ?? null };
        next[key] = v ?? undefined;
        set(HEADER_COLUMNS[key], v ?? null);
        headerMeta[key] = { confidence: 1, reason: "edited", sources: before === null ? undefined : { extracted: String(before) } };
      }
      if (input.totals) {
        for (const [key, col] of Object.entries(TOTAL_COLUMNS) as [TotalsField, string][]) {
          const v = input.totals[key];
          if (v === undefined) continue;
          const before = rowTotals(r)[key];
          if (before === v) continue;
          changes[`totals.${key}`] = { from: before, to: v };
          set(col, v);
          totalsMeta[key] = { ...(totalsMeta[key] ?? {}), confidence: 1, flagged: false, reason: "edited", sources: { extracted: String(before) } };
        }
      }

      let vendorId = r.vendor_id;
      if ("vendorId" in input && (input.vendorId ?? null) !== r.vendor_id) {
        if (input.vendorId) {
          const v = await one(c, "SELECT 1 FROM vendors WHERE id = $1", [input.vendorId]);
          if (!v) throw notFound("Vendor not found");
        }
        changes.vendorId = { from: r.vendor_id, to: input.vendorId ?? null };
        vendorId = input.vendorId ?? null;
        set("vendor_id", vendorId);
      } else if (changes.sellerGstin && !("vendorId" in input)) {
        const linked = await linkVendorByGstin(c, next.sellerGstin, next.vendorName, actorOf(user));
        if (linked && linked !== vendorId) {
          vendorId = linked;
          set("vendor_id", linked);
          changes.vendorId = { from: r.vendor_id, to: linked };
        }
      }
      if (!Object.keys(changes).length) {
        const lines = await loadLines(c, id);
        return toDetail(r, lines);
      }
      const invoiceDate = next.invoiceDate ?? null;
      const fy = invoiceDate ? financialYear(invoiceDate) : null;
      if (fy !== r.financial_year) set("financial_year", fy);
      const due = await dueDateFor(c, vendorId, invoiceDate);
      if (due !== r.due_date && (r.state !== "VERIFIED" || due)) set("due_date", due);
      set("header_meta", JSON.stringify(headerMeta));
      set("totals_meta", JSON.stringify(totalsMeta));
      sets.push("edit_count = edit_count + 1", "updated_at = now()");

      if (changes.irn || changes.sellerGstin || changes.invoiceNo || changes.invoiceDate || changes.docType) {
        const dup = await findLiveDuplicate(c, id, { irn: next.irn, sellerGstin: next.sellerGstin, invoiceNo: next.invoiceNo, financialYear: fy, docType: next.docType });
        if (dup) throw conflict("DUPLICATE_INVOICE", "Another bill with the same number (or e-invoice IRN) already exists", { duplicateOf: dup });
      }
      await c.query(`UPDATE invoices SET ${sets.join(", ")} WHERE id = $1`, vals);
      await recordEvent(c, id, user.id, "header_edit", changes);
      await audit(c, actorOf(user), { action: "invoice.header_edit", entity: "invoice", entityId: id, detail: changes });
      const fresh = await refresh(c, user, id);
      return toDetail(fresh.row, fresh.lines);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("DUPLICATE_INVOICE", "Another bill with the same number (or e-invoice IRN) already exists");
    throw e;
  }
}

export async function seal(ctx: AppContext, user: SessionUser, id: string, durationMs: number) {
  let refusal: ApiError | undefined;
  const result = await tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    assertEditable(r);
    const lines = await loadLines(c, id);
    const live = lines.filter((l) => l.status !== "removed");
    const refuse = async (err: ApiError) => {
      await recordEvent(c, id, user.id, "seal_refused", { code: err.code, details: err.details });
      refusal = err;
      return undefined;
    };
    if (r.locked_total_paise === null) return refuse(conflict("TOTAL_NOT_LOCKED", "Type the printed grand total first"));
    if (!live.length) return refuse(conflict("NO_LINES", "The bill has no lines"));
    const totals = rowTotals(r);
    const balance = verificationBalance(r.locked_total_paise, lines, totals);
    if (!balance.balanced) {
      return refuse(
        conflict("NOT_BALANCED", balance.pendingCount ? `${balance.pendingCount} line(s) still to check` : "The lines do not add up to the typed total", {
          ...balance,
          hints: balanceHints(balance.remainingPaise, lines),
        }),
      );
    }
    const checks = checksFor(r, lines, await storeGstins(c));
    const failures = blockingFailures(checks);
    if (failures.length) {
      await c.query("UPDATE invoices SET checks = $2 WHERE id = $1", [id, JSON.stringify(checks)]);
      return refuse(conflict("CHECKS_FAILED", failures.map((f) => f.message).join("; "), { failures }));
    }
    if (!r.vendor_id) return refuse(conflict("VENDOR_REQUIRED", "Choose the vendor for this bill"));
    const dup = await findLiveDuplicate(c, id, { irn: r.irn, sellerGstin: r.seller_gstin, invoiceNo: r.invoice_no, financialYear: r.financial_year, docType: r.doc_type });
    if (dup) return refuse(conflict("DUPLICATE_INVOICE", "Another bill with the same number already exists", { duplicateOf: dup }));
    const due = await dueDateFor(c, r.vendor_id, r.invoice_date);
    await c.query(
      `UPDATE invoices SET state = 'VERIFIED', verified_by = $2, verified_at = now(), verify_duration_ms = $3, due_date = $4,
              checks = $5, flagged_count = $6, updated_at = now()
        WHERE id = $1`,
      [id, user.id, Math.max(0, Math.round(durationMs)), due, JSON.stringify(checks), countFlags(r.header_meta, r.totals_meta, lines, r.lock_flagged)],
    );
    await recordEvent(c, id, user.id, "seal", { durationMs, editCount: r.edit_count, lockedTotalPaise: r.locked_total_paise });
    await audit(c, actorOf(user), {
      action: "invoice.seal",
      entity: "invoice",
      entityId: id,
      detail: { grandTotalPaise: r.grand_total_paise, lockedTotalPaise: r.locked_total_paise, lines: live.length, editCount: r.edit_count, durationMs, dueDate: due },
    });
    const fresh = await one<InvoiceRow>(c, `${INVOICE_SELECT} WHERE i.id = $1`, [id]);
    return toDetail(fresh!, lines);
  });
  if (refusal) throw refusal;
  return result!;
}

export async function reject(ctx: AppContext, user: SessionUser, id: string, reason: string) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    const allowed: InvoiceState[] = ["CAPTURED", "EXTRACTING", "NEEDS_VERIFICATION", "EXTRACTION_FAILED", "DUPLICATE", "ON_HOLD", "VERIFIED"];
    if (!allowed.includes(r.state)) throw conflict("INVALID_STATE", `A ${r.state} bill cannot be rejected`);
    if ((r.state === "VERIFIED" || r.held_from_state === "VERIFIED") && !isOwner(user)) throw forbidden("Only the owner can reject a verified bill");
    const inRun = await one(c, "SELECT 1 FROM payment_run_bills WHERE invoice_id = $1 AND active", [id]);
    if (inRun) throw conflict("IN_PAYMENT_RUN", "This bill is in a payment run; cancel the run first");
    await c.query("UPDATE invoices SET state = 'REJECTED', reject_reason = $2, held_from_state = NULL, updated_at = now() WHERE id = $1", [id, reason]);
    await recordEvent(c, id, user.id, "reject", { reason, from: r.state });
    await audit(c, actorOf(user), { action: "invoice.reject", entity: "invoice", entityId: id, reason, detail: { from: r.state } });
    const fresh = await refresh(c, user, id);
    return toDetail(fresh.row, fresh.lines);
  });
}

export async function hold(ctx: AppContext, user: SessionUser, id: string, reason: string) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    const allowed: InvoiceState[] = ["NEEDS_VERIFICATION", "EXTRACTION_FAILED", "VERIFIED", "DUPLICATE"];
    if (!allowed.includes(r.state)) throw conflict("INVALID_STATE", `A ${r.state} bill cannot be put on hold`);
    const inRun = await one(c, "SELECT 1 FROM payment_run_bills WHERE invoice_id = $1 AND active", [id]);
    if (inRun) throw conflict("IN_PAYMENT_RUN", "This bill is in a payment run; cancel the run first");
    await c.query("UPDATE invoices SET state = 'ON_HOLD', held_from_state = $2, hold_reason = $3, updated_at = now() WHERE id = $1", [id, r.state, reason]);
    await recordEvent(c, id, user.id, "hold", { reason, from: r.state });
    await audit(c, actorOf(user), { action: "invoice.hold", entity: "invoice", entityId: id, reason, detail: { from: r.state } });
    const fresh = await refresh(c, user, id);
    return toDetail(fresh.row, fresh.lines);
  });
}

export async function unhold(ctx: AppContext, user: SessionUser, id: string) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    if (r.state !== "ON_HOLD" || !r.held_from_state) throw conflict("INVALID_STATE", "This bill is not on hold");
    if (r.held_from_state === "VERIFIED" && !isOwner(user)) throw forbidden("Only the owner can release a verified bill from hold");
    await c.query("UPDATE invoices SET state = held_from_state, held_from_state = NULL, hold_reason = NULL, updated_at = now() WHERE id = $1", [id]);
    await recordEvent(c, id, user.id, "unhold", { to: r.held_from_state });
    await audit(c, actorOf(user), { action: "invoice.unhold", entity: "invoice", entityId: id, detail: { to: r.held_from_state } });
    const fresh = await refresh(c, user, id);
    return toDetail(fresh.row, fresh.lines);
  });
}

export async function reExtract(ctx: AppContext, user: SessionUser, id: string) {
  return tx(ctx.pool, async (c) => {
    const r = await loadInvoice(c, user, id, { forUpdate: true });
    const allowed: InvoiceState[] = ["CAPTURED", "NEEDS_VERIFICATION", "EXTRACTION_FAILED"];
    if (!allowed.includes(r.state)) throw conflict("INVALID_STATE", `A ${r.state} bill cannot be read again`);
    await c.query("UPDATE invoices SET state = 'CAPTURED', updated_at = now() WHERE id = $1", [id]);
    await enqueue(c, "extract", { invoiceId: id, reason: "re_extract" }, { dedupeKey: `extract:${id}` });
    await recordEvent(c, id, user.id, "re_extract", { from: r.state });
    await audit(c, actorOf(user), { action: "invoice.re_extract", entity: "invoice", entityId: id, detail: { from: r.state } });
    const fresh = await refresh(c, user, id);
    return toDetail(fresh.row, fresh.lines);
  });
}
