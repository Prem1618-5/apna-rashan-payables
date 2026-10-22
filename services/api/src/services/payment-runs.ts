/**
 * Payment runs: DRAFT (maker) → APPROVED by the owner (checker; HDFC file generated once) → UPLOADED → PAID.
 * One payment per vendor across all stores. The app never moves money: the owner uploads the file in ENet.
 */
import { chooseTxnType, consolidate, formatPaise, generateBulkFile, type PayableBill as BankBill, type Vendor as BankVendor } from "@arad/hdfc-bulk-file";
import type { PaymentRunDetail, PaymentRunItem, PaymentRunState, PaymentRunSummary, RunWarning, VendorStatus } from "@arad/core";
import { audit } from "../audit.js";
import { actorOf, assertOwner, isOwner, storeScope, type AppContext, type SessionUser } from "../context.js";
import { decrypt, encrypt, maskFromLast4, sha256Hex } from "../crypto.js";
import { isUniqueViolation, many, one, tx, type Db } from "../db.js";
import { ApiError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { istToday } from "./invoices.js";
import { bankBlockedReason, SIGNED_AMOUNT_SQL } from "./vendors.js";

const DAY_MS = 86_400_000;
export const NEW_VENDOR_DAYS = 30;
export const RECENT_BANK_CHANGE_DAYS = 30;
export const UNUSUAL_FACTOR = 3;

interface RunRow {
  id: string;
  ref: string;
  state: PaymentRunState;
  value_date: string;
  prepared_by: string;
  prepared_by_name: string;
  approved_by: string | null;
  approved_by_name: string | null;
  file_name: string | null;
  file_content: string | null;
  file_sha256: string | null;
  file_sequence: number | null;
  control: { count: number; total: string; totalPaise: number; byType: Record<"N" | "R" | "I", { count: number; totalPaise: number }> } | null;
  warnings: RunWarning[];
  created_at: Date;
  item_count: number;
  total_paise: number;
}

const RUN_SELECT = `
  SELECT r.*, pu.name AS prepared_by_name, au.name AS approved_by_name,
         (SELECT count(*)::int FROM payment_run_items it WHERE it.run_id = r.id AND it.state <> 'FAILED') AS item_count,
         (SELECT coalesce(sum(it.amount_paise), 0)::bigint FROM payment_run_items it WHERE it.run_id = r.id AND it.state <> 'FAILED') AS total_paise
    FROM payment_runs r
    JOIN users pu ON pu.id = r.prepared_by
    LEFT JOIN users au ON au.id = r.approved_by`;

interface ItemRow {
  id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_status: VendorStatus;
  vendor_created_at: Date;
  bank_account_id: string | null;
  amount_paise: number;
  customer_ref: string;
  txn_type: "N" | "R" | "I" | null;
  state: "PENDING" | "PAID" | "FAILED";
  utr: string | null;
  fail_reason: string | null;
  item_last4: string | null;
  item_length: number | null;
  item_ifsc: string | null;
  current_bank_id: string | null;
  current_usable_from: Date | null;
  current_approved_at: Date | null;
  current_version: number | null;
}

const ITEM_SELECT = `
  SELECT it.*, v.name AS vendor_name, v.status AS vendor_status, v.created_at AS vendor_created_at,
         ib.account_last4 AS item_last4, ib.account_length AS item_length, ib.ifsc AS item_ifsc,
         cb.id AS current_bank_id, cb.usable_from AS current_usable_from, cb.approved_at AS current_approved_at, cb.version AS current_version
    FROM payment_run_items it
    JOIN vendors v ON v.id = it.vendor_id
    LEFT JOIN vendor_bank_accounts ib ON ib.id = it.bank_account_id
    LEFT JOIN vendor_bank_accounts cb ON cb.vendor_id = it.vendor_id AND cb.status = 'APPROVED'`;

interface BillRow {
  item_id: string;
  invoice_id: string;
  invoice_no: string;
  invoice_date: string;
  store_name: string;
  store_code: string;
  amount_paise: number;
  doc_type: string;
  active: boolean;
  vendor_id: string;
}

async function loadBills(db: Db, runId: string, activeOnly = false): Promise<BillRow[]> {
  return many<BillRow>(
    db,
    `SELECT rb.item_id, rb.invoice_id, i.invoice_no, i.invoice_date, s.name AS store_name, s.code AS store_code, rb.amount_paise, i.doc_type, rb.active, i.vendor_id
       FROM payment_run_bills rb JOIN invoices i ON i.id = rb.invoice_id JOIN stores s ON s.id = i.store_id
      WHERE rb.run_id = $1 ${activeOnly ? "AND rb.active" : ""}
      ORDER BY i.invoice_date, i.invoice_no`,
    [runId],
  );
}

function summaryOf(r: RunRow): PaymentRunSummary {
  return {
    id: r.id,
    ref: r.ref,
    state: r.state,
    valueDate: r.value_date,
    count: r.item_count,
    totalPaise: r.total_paise,
    createdAt: r.created_at.toISOString(),
    preparedBy: r.prepared_by_name,
    approvedBy: r.approved_by_name ?? undefined,
  };
}

async function loadRun(db: Db, user: SessionUser, id: string, forUpdate = false): Promise<RunRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Payment run not found");
  const r = await one<RunRow>(db, `${RUN_SELECT} WHERE r.id = $1${forUpdate ? " FOR UPDATE OF r" : ""}`, [id]);
  // Staff see only the runs they prepared.
  if (!r || (!isOwner(user) && r.prepared_by !== user.id)) throw notFound("Payment run not found");
  return r;
}

const normNo = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Warnings the owner sees on the review screen. "block" warnings stop approval. */
export async function computeWarnings(db: Db, ctx: AppContext, run: Pick<RunRow, "id" | "prepared_by" | "prepared_by_name">): Promise<RunWarning[]> {
  const out: RunWarning[] = [];
  const now = Date.now();
  const items = await many<ItemRow>(db, `${ITEM_SELECT} WHERE it.run_id = $1 AND it.state <> 'FAILED' ORDER BY lower(v.name)`, [run.id]);
  for (const it of items) {
    const blocked = bankBlockedReason({ status: it.vendor_status, bank_id: it.current_bank_id, usable_from: it.current_usable_from });
    if (blocked) out.push({ vendorId: it.vendor_id, level: "block", code: "bank_not_ready", message: `${it.vendor_name}: ${blocked}` });
    else if (it.bank_account_id !== it.current_bank_id) {
      out.push({ vendorId: it.vendor_id, level: "block", code: "bank_not_ready", message: `${it.vendor_name}: bank details changed after this run was prepared; cancel it and prepare again` });
    }
    if (now - it.vendor_created_at.getTime() < NEW_VENDOR_DAYS * DAY_MS) {
      out.push({ vendorId: it.vendor_id, level: "warn", code: "new_vendor", message: `${it.vendor_name}: new vendor (added in the last ${NEW_VENDOR_DAYS} days)` });
    }
    if (it.current_version && it.current_version > 1 && it.current_approved_at && now - it.current_approved_at.getTime() < RECENT_BANK_CHANGE_DAYS * DAY_MS) {
      out.push({ vendorId: it.vendor_id, level: "warn", code: "bank_recent_change", message: `${it.vendor_name}: bank account changed on ${it.current_approved_at.toISOString().slice(0, 10)}` });
    }
    const past = await many<{ amount_paise: number }>(
      db,
      `SELECT it.amount_paise FROM payment_run_items it JOIN payment_runs r ON r.id = it.run_id
        WHERE it.vendor_id = $1 AND r.id <> $2 AND r.state IN ('APPROVED', 'UPLOADED', 'PAID') AND it.state <> 'FAILED'
        ORDER BY r.created_at DESC LIMIT 50`,
      [it.vendor_id, run.id],
    );
    if (past.length) {
      const m = median(past.map((p) => p.amount_paise));
      if (m > 0 && it.amount_paise > UNUSUAL_FACTOR * m) {
        out.push({ vendorId: it.vendor_id, level: "warn", code: "amount_unusual", message: `${it.vendor_name}: ₹${formatPaise(it.amount_paise)} is more than ${UNUSUAL_FACTOR}× the usual payment (₹${formatPaise(m)})` });
      }
    }
  }

  // Possible duplicates: the same vendor bill number twice in this run, or already paid / being paid.
  const bills = await loadBills(db, run.id, true);
  const seen = new Map<string, BillRow>();
  const vendorName = new Map(items.map((i) => [i.vendor_id, i.vendor_name]));
  for (const b of bills) {
    const key = `${b.vendor_id}|${b.doc_type}|${normNo(b.invoice_no)}`;
    const first = seen.get(key);
    if (first) {
      out.push({ vendorId: b.vendor_id, level: "warn", code: "possible_duplicate", message: `${vendorName.get(b.vendor_id)}: bill ${b.invoice_no} appears twice (${first.store_name}, ${b.store_name})` });
    } else seen.set(key, b);
  }
  if (bills.length) {
    const prior = await many<{ vendor_id: string; invoice_no: string; state: string }>(
      db,
      `SELECT i.vendor_id, i.invoice_no, i.state FROM invoices i
        WHERE i.state IN ('PAID', 'IN_PAYMENT_RUN') AND i.vendor_id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM payment_run_bills rb WHERE rb.invoice_id = i.id AND rb.run_id = $2)`,
      [[...new Set(bills.map((b) => b.vendor_id))], run.id],
    );
    const priorKeys = new Map(prior.map((p) => [`${p.vendor_id}|${normNo(p.invoice_no)}`, p.state]));
    for (const b of bills) {
      const st = priorKeys.get(`${b.vendor_id}|${normNo(b.invoice_no)}`);
      if (st) {
        out.push({ vendorId: b.vendor_id, level: "warn", code: "possible_duplicate", message: `${vendorName.get(b.vendor_id)}: a bill numbered ${b.invoice_no} was already ${st === "PAID" ? "paid" : "put in another run"}` });
      }
    }
  }

  if (ctx.config.REQUIRE_DIFFERENT_APPROVER) {
    out.push({ level: "info", code: "same_preparer", message: `Prepared by ${run.prepared_by_name}; someone else must approve it` });
  }
  return out;
}

async function itemsOf(db: Db, runId: string): Promise<PaymentRunItem[]> {
  const items = await many<ItemRow>(db, `${ITEM_SELECT} WHERE it.run_id = $1 ORDER BY it.customer_ref`, [runId]);
  const bills = await loadBills(db, runId);
  return items.map((it) => ({
    id: it.id,
    vendorId: it.vendor_id,
    vendorName: it.vendor_name,
    accountMasked: it.item_last4 ? maskFromLast4(it.item_last4, it.item_length ?? 10) : "",
    ifsc: it.item_ifsc ?? "",
    txnType: it.txn_type ?? "N",
    amountPaise: it.amount_paise,
    customerRef: it.customer_ref,
    bills: bills.filter((b) => b.item_id === it.id).map((b) => ({ invoiceId: b.invoice_id, invoiceNo: b.invoice_no, storeName: b.store_name, amountPaise: b.amount_paise })),
    state: it.state,
    utr: it.utr ?? undefined,
    failReason: it.fail_reason ?? undefined,
  }));
}

async function detailOf(db: Db, ctx: AppContext, r: RunRow): Promise<PaymentRunDetail> {
  const warnings = r.state === "DRAFT" ? await computeWarnings(db, ctx, r) : r.warnings;
  return {
    ...summaryOf(r),
    items: await itemsOf(db, r.id),
    warnings,
    file:
      r.file_name && r.file_sha256 && r.control
        ? { name: r.file_name, sha256: r.file_sha256, control: { count: r.control.count, total: r.control.total, byType: r.control.byType } }
        : undefined,
  };
}

export async function getRun(ctx: AppContext, user: SessionUser, id: string): Promise<PaymentRunDetail> {
  return detailOf(ctx.pool, ctx, await loadRun(ctx.pool, user, id));
}

export async function listRuns(ctx: AppContext, user: SessionUser, limit = 100): Promise<PaymentRunSummary[]> {
  const params: unknown[] = [limit];
  const where = isOwner(user) ? "TRUE" : `r.prepared_by = $${params.push(user.id)}`;
  return (await many<RunRow>(ctx.pool, `${RUN_SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT $1`, params)).map(summaryOf);
}

function assertRealDate(d: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok) throw new ApiError(400, "INVALID_DATE", "valueDate must be a real date (YYYY-MM-DD)");
}

export async function createRun(ctx: AppContext, user: SessionUser, invoiceIds: string[], valueDate: string): Promise<PaymentRunDetail> {
  assertRealDate(valueDate);
  if (valueDate < istToday()) throw unprocessable("VALUE_DATE_PAST", "The payment date cannot be in the past");
  const ids = [...new Set(invoiceIds)];
  try {
    const runId = await tx(ctx.pool, async (c) => {
      const params: unknown[] = [ids];
      const scope = storeScope(user, "i.store_id", params);
      const bills = await many<{ id: string; state: string; vendor_id: string | null; invoice_no: string; amount_paise: number; in_run: boolean }>(
        c,
        `SELECT i.id, i.state, i.vendor_id, i.invoice_no, ${SIGNED_AMOUNT_SQL()} AS amount_paise,
                EXISTS (SELECT 1 FROM payment_run_bills rb WHERE rb.invoice_id = i.id AND rb.active) AS in_run
           FROM invoices i WHERE i.id = ANY($1::uuid[]) AND ${scope}
          ORDER BY i.id FOR UPDATE OF i`,
        params,
      );
      const found = new Set(bills.map((b) => b.id));
      const missing = ids.filter((i) => !found.has(i));
      if (missing.length) throw new ApiError(404, "NOT_FOUND", "Some bills were not found", { invoiceIds: missing });
      const notPayable = bills.filter((b) => b.state !== "VERIFIED" || !b.vendor_id);
      if (notPayable.length) throw conflict("NOT_PAYABLE", "Only verified bills can be paid", { invoices: notPayable.map((b) => ({ invoiceId: b.id, state: b.state })) });
      const inRun = bills.filter((b) => b.in_run);
      if (inRun.length) throw conflict("ALREADY_IN_RUN", "Some bills are already in another payment run", { invoiceIds: inRun.map((b) => b.id) });

      const byVendor = new Map<string, typeof bills>();
      for (const b of bills) byVendor.set(b.vendor_id!, [...(byVendor.get(b.vendor_id!) ?? []), b]);
      const vendors = await many<{ id: string; name: string; bank_id: string | null; ifsc: string | null }>(
        c,
        `SELECT v.id, v.name, b.id AS bank_id, b.ifsc FROM vendors v LEFT JOIN vendor_bank_accounts b ON b.vendor_id = v.id AND b.status = 'APPROVED' WHERE v.id = ANY($1::uuid[])`,
        [[...byVendor.keys()]],
      );
      // Same order as consolidate(): by vendor name, then id, so references match the file.
      vendors.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      for (const v of vendors) {
        const total = byVendor.get(v.id)!.reduce((s, b) => s + b.amount_paise, 0);
        if (total <= 0) throw unprocessable("NOTHING_TO_PAY", `${v.name}: credit notes are equal to or larger than the bills`, { vendorId: v.id, totalPaise: total });
      }

      const seq = await one<{ n: number }>(c, "SELECT nextval('payment_run_ref_seq')::int AS n");
      const ref = `PR${valueDate.slice(2, 4)}${valueDate.slice(5, 7)}${valueDate.slice(8, 10)}${String(seq!.n).padStart(5, "0")}`;
      const run = await one<{ id: string }>(c, "INSERT INTO payment_runs (ref, value_date, prepared_by) VALUES ($1, $2, $3) RETURNING id", [ref, valueDate, user.id]);
      let n = 0;
      for (const v of vendors) {
        const vb = byVendor.get(v.id)!;
        const amount = vb.reduce((s, b) => s + b.amount_paise, 0);
        const item = await one<{ id: string }>(
          c,
          `INSERT INTO payment_run_items (run_id, vendor_id, bank_account_id, amount_paise, customer_ref, txn_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [run!.id, v.id, v.bank_id, amount, `${ref}${String(++n).padStart(3, "0")}`, v.ifsc ? chooseTxnType(v.ifsc, amount, { rtgsFromPaise: ctx.config.RTGS_FROM_PAISE }) : null],
        );
        for (const b of vb) {
          await c.query("INSERT INTO payment_run_bills (run_id, item_id, invoice_id, amount_paise) VALUES ($1, $2, $3, $4)", [run!.id, item!.id, b.id, b.amount_paise]);
        }
      }
      const warnings = await computeWarnings(c, ctx, { id: run!.id, prepared_by: user.id, prepared_by_name: user.name });
      await c.query("UPDATE payment_runs SET warnings = $2 WHERE id = $1", [run!.id, JSON.stringify(warnings)]);
      await audit(c, actorOf(user), {
        action: "payment_run.create",
        entity: "payment_run",
        entityId: run!.id,
        detail: { ref, valueDate, vendors: vendors.length, bills: bills.length, totalPaise: bills.reduce((s, b) => s + b.amount_paise, 0) },
      });
      return run!.id;
    });
    return getRun(ctx, user, runId);
  } catch (e) {
    if (isUniqueViolation(e, "payment_run_bills_one_open_run")) throw conflict("ALREADY_IN_RUN", "Some bills are already in another payment run");
    throw e;
  }
}

export async function approveRun(ctx: AppContext, user: SessionUser, id: string): Promise<PaymentRunDetail> {
  assertOwner(user);
  await tx(ctx.pool, async (c) => {
    const r = await loadRun(c, user, id, true);
    if (r.state !== "DRAFT") throw conflict("INVALID_STATE", `This run is ${r.state}`);
    if (ctx.config.REQUIRE_DIFFERENT_APPROVER && r.prepared_by === user.id) {
      throw conflict("SAME_APPROVER", "The person who prepared this run cannot approve it. Ask a staff member to prepare it, then approve.");
    }
    if (r.value_date < istToday()) throw unprocessable("VALUE_DATE_PAST", "The payment date has passed; cancel this run and prepare a new one");
    const warnings = await computeWarnings(c, ctx, r);
    const blocks = warnings.filter((w) => w.level === "block");
    if (blocks.length) throw conflict("RUN_BLOCKED", blocks.map((b) => b.message).join("; "), { warnings: blocks });
    if (!ctx.config.HDFC_CLIENT_CODE) throw unprocessable("CONFIG_MISSING", "HDFC_CLIENT_CODE is not configured");

    // Re-lock the bills and make sure nothing changed under the draft.
    const bills = await many<BillRow & { state: string }>(
      c,
      `SELECT rb.item_id, rb.invoice_id, i.invoice_no, i.invoice_date, s.name AS store_name, s.code AS store_code, rb.amount_paise, i.doc_type, rb.active, i.vendor_id, i.state
         FROM payment_run_bills rb JOIN invoices i ON i.id = rb.invoice_id JOIN stores s ON s.id = i.store_id
        WHERE rb.run_id = $1 AND rb.active ORDER BY i.id FOR UPDATE OF i`,
      [id],
    );
    const changed = bills.filter((b) => b.state !== "VERIFIED");
    if (changed.length) throw conflict("BILLS_CHANGED", "Some bills changed after this run was prepared; cancel and prepare again", { invoiceIds: changed.map((b) => b.invoice_id) });

    const items = await many<{ id: string; vendor_id: string; customer_ref: string; amount_paise: number; name: string; email: string | null; enc: string; ifsc: string; bene_code: string | null; bank_name: string | null; branch_name: string | null }>(
      c,
      `SELECT it.id, it.vendor_id, it.customer_ref, it.amount_paise, v.name, v.email, b.account_number_enc AS enc, b.ifsc, b.bene_code, b.bank_name, b.branch_name
         FROM payment_run_items it JOIN vendors v ON v.id = it.vendor_id JOIN vendor_bank_accounts b ON b.id = it.bank_account_id
        WHERE it.run_id = $1 AND it.state = 'PENDING'`,
      [id],
    );
    const bankVendors: BankVendor[] = items.map((it) => ({
      id: it.vendor_id,
      name: it.name,
      accountNumber: decrypt(it.enc, ctx.config.dataKey, "bank_account"),
      ifsc: it.ifsc,
      beneCode: it.bene_code ?? undefined,
      email: it.email ?? undefined,
      bankName: it.bank_name ?? undefined,
      branchName: it.branch_name ?? undefined,
    }));
    const bankBills: BankBill[] = bills.map((b) => ({ vendorId: b.vendor_id, billNo: b.invoice_no, storeCode: b.store_code, amountPaise: b.amount_paise }));
    const cons = consolidate(bankBills, bankVendors, r.ref);
    if (cons.errors.length) throw unprocessable("FILE_INVALID", "The bank file cannot be made", { errors: cons.errors });

    await c.query("SELECT pg_advisory_xact_lock(724310004, hashtext($1::text))", [r.value_date]);
    const seq = await one<{ n: number }>(c, "SELECT coalesce(max(file_sequence), 0)::int + 1 AS n FROM payment_runs WHERE value_date = $1", [r.value_date]);
    const file = generateBulkFile(cons.instructions, { clientCode: ctx.config.HDFC_CLIENT_CODE, valueDate: r.value_date, sequence: seq!.n, rtgsFromPaise: ctx.config.RTGS_FROM_PAISE });
    if (!file.ok) throw unprocessable("FILE_INVALID", file.errors.map((e) => e.message).join("; "), { errors: file.errors, warnings: file.warnings });

    const itemByVendor = new Map(items.map((it) => [it.vendor_id, it]));
    for (const row of file.rows) {
      const it = itemByVendor.get(row.vendorId)!;
      await c.query("UPDATE payment_run_items SET customer_ref = $2, txn_type = $3, updated_at = now() WHERE id = $1", [it.id, row.customerRef, row.txnType]);
    }
    const finalWarnings = [...warnings, ...file.warnings.map((w) => ({ vendorId: w.vendorId, level: "info" as const, code: "over_limit" as const, message: w.message }))].filter(
      (w) => !(w.code === "over_limit" && !/shortened|written as|not valid|double-check/.test(w.message)),
    );
    await c.query(
      `UPDATE payment_runs SET state = 'APPROVED', approved_by = $2, approved_at = now(), file_name = $3, file_content = $4, file_sha256 = $5,
              file_sequence = $6, control = $7, warnings = $8, updated_at = now() WHERE id = $1`,
      [id, user.id, file.fileName, encrypt(file.content, ctx.config.dataKey, "bank_file"), file.sha256, seq!.n, JSON.stringify(file.control), JSON.stringify(finalWarnings)],
    );
    await c.query(`UPDATE invoices SET state = 'IN_PAYMENT_RUN', updated_at = now() WHERE id = ANY($1::uuid[])`, [bills.map((b) => b.invoice_id)]);
    await audit(c, actorOf(user), {
      action: "payment_run.approve",
      entity: "payment_run",
      entityId: id,
      detail: { ref: r.ref, fileName: file.fileName, sha256: file.sha256, control: file.control, preparedBy: r.prepared_by },
    });
  });
  return getRun(ctx, user, id);
}

export async function runFile(ctx: AppContext, user: SessionUser, id: string): Promise<{ name: string; content: string }> {
  assertOwner(user);
  const r = await loadRun(ctx.pool, user, id);
  if (!["APPROVED", "UPLOADED", "PAID"].includes(r.state) || !r.file_content || !r.file_name) throw conflict("NO_FILE", "This run has no bank file (approve it first)");
  const content = decrypt(r.file_content, ctx.config.dataKey, "bank_file");
  if (sha256Hex(Buffer.from(content, "ascii")) !== r.file_sha256) throw new ApiError(500, "FILE_TAMPERED", "The stored bank file does not match its recorded hash");
  await audit(ctx.pool, actorOf(user), { action: "payment_run.file_download", entity: "payment_run", entityId: id, detail: { fileName: r.file_name, sha256: r.file_sha256 } });
  return { name: r.file_name, content };
}

const csvCell = (v: string | number | undefined | null) => {
  const s = v === undefined || v === null ? "" : String(v);
  // Quote everything that needs it; neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const rupees = (p: number) => (p < 0 ? `-${formatPaise(-p)}` : formatPaise(p));

export async function adviceCsv(ctx: AppContext, user: SessionUser, id: string): Promise<{ name: string; content: string }> {
  assertOwner(user);
  const r = await loadRun(ctx.pool, user, id);
  const items = await itemsOf(ctx.pool, id);
  const bills = await loadBills(ctx.pool, id);
  const header = ["Run", "Value date", "Payment ref", "Vendor", "Account", "IFSC", "Mode", "Payment amount", "Payment status", "UTR", "Bill no", "Bill date", "Store", "Bill type", "Bill amount", "Bill status"];
  const lines = [header.map(csvCell).join(",")];
  for (const it of items) {
    for (const b of bills.filter((x) => x.item_id === it.id)) {
      lines.push(
        [r.ref, r.value_date, it.customerRef, it.vendorName, it.accountMasked, it.ifsc, it.txnType, rupees(it.amountPaise), it.state, it.utr, b.invoice_no, b.invoice_date, b.store_name, b.doc_type, rupees(b.amount_paise), b.active ? "INCLUDED" : "RELEASED"]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return { name: `advice-${r.ref}.csv`, content: lines.join("\r\n") + "\r\n" };
}

export async function markUploaded(ctx: AppContext, user: SessionUser, id: string) {
  assertOwner(user);
  await tx(ctx.pool, async (c) => {
    const r = await loadRun(c, user, id, true);
    if (r.state !== "APPROVED") throw conflict("INVALID_STATE", `This run is ${r.state}`);
    await c.query("UPDATE payment_runs SET state = 'UPLOADED', uploaded_by = $2, uploaded_at = now(), updated_at = now() WHERE id = $1", [id, user.id]);
    await audit(c, actorOf(user), { action: "payment_run.mark_uploaded", entity: "payment_run", entityId: id, detail: { ref: r.ref } });
  });
  return getRun(ctx, user, id);
}

export async function markPaid(ctx: AppContext, user: SessionUser, id: string, utrs: Record<string, string> = {}) {
  assertOwner(user);
  await tx(ctx.pool, async (c) => {
    const r = await loadRun(c, user, id, true);
    if (r.state !== "APPROVED" && r.state !== "UPLOADED") throw conflict("INVALID_STATE", `This run is ${r.state}`);
    const items = await many<{ id: string; state: string }>(c, "SELECT id, state FROM payment_run_items WHERE run_id = $1 FOR UPDATE", [id]);
    const known = new Set(items.map((i) => i.id));
    const clean: Record<string, string> = {};
    for (const [itemId, utr] of Object.entries(utrs)) {
      if (!known.has(itemId)) throw new ApiError(400, "UNKNOWN_ITEM", `Payment ${itemId} is not in this run`);
      const u = utr.trim().toUpperCase();
      if (!/^[A-Z0-9]{6,30}$/.test(u)) throw new ApiError(400, "INVALID_UTR", "UTR must be 6-30 letters or digits");
      clean[itemId] = u;
    }
    for (const it of items.filter((i) => i.state === "PENDING")) {
      await c.query("UPDATE payment_run_items SET state = 'PAID', utr = $2, updated_at = now() WHERE id = $1", [it.id, clean[it.id] ?? null]);
    }
    await c.query(
      `UPDATE invoices SET state = 'PAID', updated_at = now()
        WHERE id IN (SELECT rb.invoice_id FROM payment_run_bills rb JOIN payment_run_items it ON it.id = rb.item_id WHERE rb.run_id = $1 AND rb.active AND it.state = 'PAID')`,
      [id],
    );
    await c.query("UPDATE payment_runs SET state = 'PAID', paid_by = $2, paid_at = now(), updated_at = now() WHERE id = $1", [id, user.id]);
    await audit(c, actorOf(user), { action: "payment_run.mark_paid", entity: "payment_run", entityId: id, detail: { ref: r.ref, utrs: clean } });
  });
  return getRun(ctx, user, id);
}

async function releaseBills(db: Db, where: string, params: unknown[], reason: string) {
  const released = await many<{ invoice_id: string }>(
    db,
    `UPDATE payment_run_bills SET active = false, released_at = now(), released_reason = $${params.length + 1} WHERE active AND ${where} RETURNING invoice_id`,
    [...params, reason],
  );
  if (released.length) {
    await db.query(`UPDATE invoices SET state = 'VERIFIED', updated_at = now() WHERE id = ANY($1::uuid[]) AND state IN ('IN_PAYMENT_RUN', 'PAID')`, [released.map((r) => r.invoice_id)]);
  }
  return released.map((r) => r.invoice_id);
}

export async function markItemFailed(ctx: AppContext, user: SessionUser, id: string, itemId: string, reason: string) {
  assertOwner(user);
  await tx(ctx.pool, async (c) => {
    const r = await loadRun(c, user, id, true);
    if (!["APPROVED", "UPLOADED", "PAID"].includes(r.state)) throw conflict("INVALID_STATE", `This run is ${r.state}`);
    const it = await one<{ id: string; state: string; vendor_id: string; amount_paise: number }>(c, "SELECT id, state, vendor_id, amount_paise FROM payment_run_items WHERE id = $1 AND run_id = $2 FOR UPDATE", [itemId, id]);
    if (!it) throw notFound("Payment not found in this run");
    if (it.state === "FAILED") throw conflict("INVALID_STATE", "This payment is already marked failed");
    await c.query("UPDATE payment_run_items SET state = 'FAILED', fail_reason = $2, updated_at = now() WHERE id = $1", [itemId, reason]);
    const released = await releaseBills(c, "item_id = $1", [itemId], `payment failed: ${reason}`);
    await audit(c, actorOf(user), { action: "payment_run.item_failed", entity: "payment_run", entityId: id, reason, detail: { itemId, vendorId: it.vendor_id, amountPaise: it.amount_paise, released } });
  });
  return getRun(ctx, user, id);
}

export async function cancelRun(ctx: AppContext, user: SessionUser, id: string) {
  await tx(ctx.pool, async (c) => {
    const r = await loadRun(c, user, id, true);
    if (r.state !== "DRAFT" && r.state !== "APPROVED") throw conflict("INVALID_STATE", `A ${r.state} run cannot be cancelled`);
    if (!isOwner(user) && !(r.state === "DRAFT" && r.prepared_by === user.id)) throw forbidden("Only the owner can cancel this run");
    await c.query("UPDATE payment_runs SET state = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), updated_at = now() WHERE id = $1", [id, user.id]);
    const released = await releaseBills(c, "run_id = $1", [id], "run cancelled");
    await audit(c, actorOf(user), { action: "payment_run.cancel", entity: "payment_run", entityId: id, detail: { ref: r.ref, from: r.state, released: released.length } });
  });
  return getRun(ctx, user, id);
}
