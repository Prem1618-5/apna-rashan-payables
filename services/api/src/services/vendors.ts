/**
 * Vendor master and versioned bank details.
 * Bank details are typed by a person (twice), never taken from invoice text or a UPI QR, stored
 * encrypted, shown masked, and need owner approval plus a cooling-off period before they can be paid.
 */
import { gstinPan, isValidGstin, normalizeGstin, type BankInput, type BankVersion, type VendorDetail, type VendorInput, type VendorStatus, type VendorSummary } from "@arad/core";
import { isValidIfsc } from "@arad/hdfc-bulk-file";
import { audit } from "../audit.js";
import { actorOf, assertOwner, isOwner, storeScope, type AppContext, type SessionUser } from "../context.js";
import { blindIndex, encrypt, maskFromLast4 } from "../crypto.js";
import { many, one, tx, type Db } from "../db.js";
import { ApiError, conflict, forbidden, notFound } from "../errors.js";

interface VendorRow {
  id: string;
  name: string;
  trade_name: string | null;
  gstin: string | null;
  pan: string | null;
  phone: string | null;
  email: string | null;
  payment_terms_days: number;
  status: VendorStatus;
  created_at: Date;
  approved_at: Date | null;
}

interface BankRow {
  id: string;
  vendor_id: string;
  version: number;
  account_last4: string;
  account_length: number;
  ifsc: string;
  bank_name: string | null;
  branch_name: string | null;
  bene_code: string | null;
  status: BankVersion["status"];
  usable_from: Date | null;
  created_by_name: string;
  created_at: Date;
  approved_by_name: string | null;
  approved_at: Date | null;
}

const u = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

export const OWED_STATES = ["VERIFIED", "IN_PAYMENT_RUN"];
/** Signed amount of a bill: credit notes reduce what is owed. */
export const SIGNED_AMOUNT_SQL = (alias = "i") => `(CASE WHEN ${alias}.doc_type = 'CRN' THEN -${alias}.grand_total_paise ELSE ${alias}.grand_total_paise END)`;

function bankVersion(b: BankRow): BankVersion {
  return {
    id: b.id,
    version: b.version,
    accountMasked: maskFromLast4(b.account_last4, b.account_length),
    ifsc: b.ifsc,
    bankName: u(b.bank_name),
    branchName: u(b.branch_name),
    beneCode: u(b.bene_code),
    status: b.status,
    createdBy: b.created_by_name,
    createdAt: b.created_at.toISOString(),
    approvedBy: u(b.approved_by_name),
    approvedAt: b.approved_at?.toISOString(),
    usableFrom: b.usable_from?.toISOString(),
  };
}

const BANK_SELECT = `
  SELECT b.id, b.vendor_id, b.version, b.account_last4, b.account_length, b.ifsc, b.bank_name, b.branch_name, b.bene_code, b.status,
         b.usable_from, b.created_at, b.approved_at, cu.name AS created_by_name, au.name AS approved_by_name
    FROM vendor_bank_accounts b
    JOIN users cu ON cu.id = b.created_by
    LEFT JOIN users au ON au.id = b.approved_by`;

async function owedByVendor(db: Db, user: SessionUser, vendorIds: string[]): Promise<Map<string, number>> {
  if (!vendorIds.length) return new Map();
  const params: unknown[] = [vendorIds, OWED_STATES];
  const scope = storeScope(user, "i.store_id", params);
  const rows = await many<{ vendor_id: string; owed: number }>(
    db,
    `SELECT i.vendor_id, sum(${SIGNED_AMOUNT_SQL()})::bigint AS owed FROM invoices i
      WHERE i.vendor_id = ANY($1::uuid[]) AND i.state = ANY($2::text[]) AND ${scope}
      GROUP BY i.vendor_id`,
    params,
  );
  return new Map(rows.map((r) => [r.vendor_id, r.owed]));
}

function summaryOf(v: VendorRow, banks: BankRow[], owed: number): VendorSummary {
  const approved = banks.find((b) => b.status === "APPROVED");
  const pending = banks.filter((b) => b.status === "PENDING").sort((a, b) => b.version - a.version)[0];
  const shown = approved ?? pending;
  return {
    id: v.id,
    name: v.name,
    gstin: u(v.gstin),
    status: v.status,
    bankStatus: approved ? "APPROVED" : pending ? "PENDING" : "NONE",
    accountMasked: shown ? maskFromLast4(shown.account_last4, shown.account_length) : undefined,
    ifsc: shown?.ifsc,
    owedPaise: owed,
  };
}

export async function listVendors(db: Db, user: SessionUser, q: { q?: string; status?: string }): Promise<VendorSummary[]> {
  const params: unknown[] = [];
  const where: string[] = ["TRUE"];
  if (q.q) {
    params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(v.name ILIKE $${params.length} OR v.trade_name ILIKE $${params.length} OR v.gstin ILIKE $${params.length})`);
  }
  if (q.status) {
    params.push(q.status.split(",").map((s) => s.trim().toUpperCase()));
    where.push(`v.status = ANY($${params.length}::text[])`);
  }
  const vendors = await many<VendorRow>(db, `SELECT v.* FROM vendors v WHERE ${where.join(" AND ")} ORDER BY lower(v.name), v.id LIMIT 1000`, params);
  const ids = vendors.map((v) => v.id);
  const banks = ids.length ? await many<BankRow>(db, `${BANK_SELECT} WHERE b.vendor_id = ANY($1::uuid[]) AND b.status IN ('APPROVED', 'PENDING')`, [ids]) : [];
  const owed = await owedByVendor(db, user, ids);
  const byVendor = new Map<string, BankRow[]>();
  for (const b of banks) byVendor.set(b.vendor_id, [...(byVendor.get(b.vendor_id) ?? []), b]);
  return vendors.map((v) => summaryOf(v, byVendor.get(v.id) ?? [], owed.get(v.id) ?? 0));
}

export async function getVendor(db: Db, user: SessionUser, id: string): Promise<VendorDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Vendor not found");
  const v = await one<VendorRow>(db, "SELECT * FROM vendors WHERE id = $1", [id]);
  if (!v) throw notFound("Vendor not found");
  const banks = await many<BankRow>(db, `${BANK_SELECT} WHERE b.vendor_id = $1 ORDER BY b.version DESC`, [id]);
  const owed = await owedByVendor(db, user, [id]);
  return {
    ...summaryOf(v, banks, owed.get(id) ?? 0),
    tradeName: u(v.trade_name),
    pan: u(v.pan),
    phone: u(v.phone),
    email: u(v.email),
    paymentTermsDays: v.payment_terms_days,
    bankVersions: banks.map(bankVersion),
  };
}

function normalizeVendorInput(input: VendorInput) {
  const gstin = normalizeGstin(input.gstin);
  if (gstin && !isValidGstin(gstin)) throw new ApiError(400, "INVALID_GSTIN", "GSTIN is not valid (check the characters)");
  const pan = input.pan?.trim().toUpperCase() || (gstin ? gstinPan(gstin) : undefined);
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw new ApiError(400, "INVALID_PAN", "PAN must look like ABCDE1234F");
  if (gstin && pan && gstinPan(gstin) !== pan) throw new ApiError(400, "PAN_GSTIN_MISMATCH", "PAN does not match the GSTIN");
  return {
    name: input.name.trim(),
    tradeName: input.tradeName?.trim() || null,
    gstin: gstin ?? null,
    pan: pan ?? null,
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    paymentTermsDays: input.paymentTermsDays,
  };
}

async function findDuplicateVendors(db: Db, selfId: string | null, gstin: string | null, pan: string | null) {
  const matches: { vendorId: string; name: string; field: "gstin" | "pan" | "accountNumber" }[] = [];
  if (gstin) {
    for (const r of await many<{ id: string; name: string }>(db, "SELECT id, name FROM vendors WHERE gstin = $1 AND id IS DISTINCT FROM $2::uuid", [gstin, selfId])) {
      matches.push({ vendorId: r.id, name: r.name, field: "gstin" });
    }
  }
  if (pan) {
    for (const r of await many<{ id: string; name: string }>(db, "SELECT id, name FROM vendors WHERE pan = $1 AND id IS DISTINCT FROM $2::uuid", [pan, selfId])) {
      if (!matches.some((m) => m.vendorId === r.id)) matches.push({ vendorId: r.id, name: r.name, field: "pan" });
    }
  }
  return matches;
}

export async function createVendor(ctx: AppContext, user: SessionUser, input: VendorInput): Promise<VendorDetail> {
  const v = normalizeVendorInput(input);
  const id = await tx(ctx.pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7243100003)"); // serialise duplicate checks
    const dups = await findDuplicateVendors(c, null, v.gstin, v.pan);
    if (dups.length) throw conflict("DUPLICATE_VENDOR", `A vendor with the same ${dups[0]!.field.toUpperCase()} already exists: ${dups[0]!.name}`, { matches: dups });
    const owner = isOwner(user);
    const row = await one<{ id: string }>(
      c,
      `INSERT INTO vendors (name, trade_name, gstin, pan, phone, email, payment_terms_days, status, created_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 30), $8, $9, $10, $11) RETURNING id`,
      [v.name, v.tradeName, v.gstin, v.pan, v.phone, v.email, v.paymentTermsDays ?? null, owner ? "ACTIVE" : "PENDING", user.id, owner ? user.id : null, owner ? new Date() : null],
    );
    await audit(c, actorOf(user), { action: "vendor.create", entity: "vendor", entityId: row!.id, detail: { ...v, status: owner ? "ACTIVE" : "PENDING" } });
    return row!.id;
  });
  return getVendor(ctx.pool, user, id);
}

export async function updateVendor(ctx: AppContext, user: SessionUser, id: string, input: VendorInput): Promise<VendorDetail> {
  const v = normalizeVendorInput(input);
  await tx(ctx.pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7243100003)");
    const before = await one<VendorRow>(c, "SELECT * FROM vendors WHERE id = $1 FOR UPDATE", [id]);
    if (!before) throw notFound("Vendor not found");
    if (!isOwner(user) && before.status !== "PENDING") throw forbidden("Only the owner can change an approved vendor");
    const dups = await findDuplicateVendors(c, id, v.gstin, v.pan);
    if (dups.length) throw conflict("DUPLICATE_VENDOR", `A vendor with the same ${dups[0]!.field.toUpperCase()} already exists: ${dups[0]!.name}`, { matches: dups });
    const terms = v.paymentTermsDays ?? before.payment_terms_days;
    await c.query(
      `UPDATE vendors SET name = $2, trade_name = $3, gstin = $4, pan = $5, phone = $6, email = $7, payment_terms_days = $8, updated_at = now() WHERE id = $1`,
      [id, v.name, v.tradeName, v.gstin, v.pan, v.phone, v.email, terms],
    );
    if (terms !== before.payment_terms_days) {
      // New terms apply to bills not yet in a payment run.
      await c.query(`UPDATE invoices SET due_date = invoice_date + $2::int, updated_at = now() WHERE vendor_id = $1 AND state IN ('NEEDS_VERIFICATION', 'VERIFIED') AND invoice_date IS NOT NULL`, [id, terms]);
    }
    const changed = Object.fromEntries(
      (
        [
          ["name", before.name, v.name],
          ["tradeName", before.trade_name, v.tradeName],
          ["gstin", before.gstin, v.gstin],
          ["pan", before.pan, v.pan],
          ["phone", before.phone, v.phone],
          ["email", before.email, v.email],
          ["paymentTermsDays", before.payment_terms_days, terms],
        ] as const
      )
        .filter(([, a, b]) => a !== b)
        .map(([k, a, b]) => [k, { from: a, to: b }]),
    );
    await audit(c, actorOf(user), { action: "vendor.update", entity: "vendor", entityId: id, detail: changed });
  });
  return getVendor(ctx.pool, user, id);
}

export async function approveVendor(ctx: AppContext, user: SessionUser, id: string): Promise<VendorDetail> {
  assertOwner(user);
  await tx(ctx.pool, async (c) => {
    const v = await one<VendorRow>(c, "SELECT * FROM vendors WHERE id = $1 FOR UPDATE", [id]);
    if (!v) throw notFound("Vendor not found");
    if (v.status === "ACTIVE") throw conflict("ALREADY_ACTIVE", "This vendor is already approved");
    await c.query("UPDATE vendors SET status = 'ACTIVE', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1", [id, user.id]);
    await audit(c, actorOf(user), { action: "vendor.approve", entity: "vendor", entityId: id, detail: { from: v.status } });
  });
  return getVendor(ctx.pool, user, id);
}

export function normalizeAccount(s: string) {
  return s.replace(/[\s-]/g, "").toUpperCase();
}

export async function proposeBank(ctx: AppContext, user: SessionUser, vendorId: string, input: BankInput): Promise<VendorDetail> {
  const account = normalizeAccount(input.accountNumber);
  const confirm = normalizeAccount(input.accountNumberConfirm);
  if (account !== confirm) throw new ApiError(400, "ACCOUNT_MISMATCH", "The two account numbers do not match. Type it again.");
  if (!/^[A-Z0-9]{6,25}$/.test(account)) throw new ApiError(400, "INVALID_ACCOUNT", "Account number must be 6-25 letters or digits");
  const ifsc = input.ifsc.replace(/\s/g, "").toUpperCase();
  if (!isValidIfsc(ifsc)) throw new ApiError(400, "INVALID_IFSC", "IFSC must be 4 letters, 0, then 6 letters or digits (e.g. HDFC0001234)");
  const beneCode = input.beneCode?.replace(/\s/g, "").toUpperCase() || null;
  if (beneCode && !/^[A-Z0-9]{1,13}$/.test(beneCode)) throw new ApiError(400, "INVALID_BENE_CODE", "Beneficiary code must be 1-13 letters or digits");
  const hash = blindIndex(account, ctx.config.dataKey, "bank_account");

  await tx(ctx.pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(7243100003)");
    const v = await one<{ id: string; status: VendorStatus }>(c, "SELECT id, status FROM vendors WHERE id = $1 FOR UPDATE", [vendorId]);
    if (!v) throw notFound("Vendor not found");
    if (v.status === "BLOCKED" && !isOwner(user)) throw forbidden("This vendor is blocked");
    const sameAccount = await many<{ vendor_id: string; name: string; status: string }>(
      c,
      `SELECT b.vendor_id, v.name, b.status FROM vendor_bank_accounts b JOIN vendors v ON v.id = b.vendor_id
        WHERE b.account_hash = $1 AND b.status IN ('PENDING', 'APPROVED')`,
      [hash],
    );
    const other = sameAccount.filter((r) => r.vendor_id !== vendorId);
    if (other.length) {
      throw conflict("DUPLICATE_VENDOR", `This account number is already saved for another vendor: ${other[0]!.name}`, {
        matches: other.map((r) => ({ vendorId: r.vendor_id, name: r.name, field: "accountNumber" })),
      });
    }
    if (sameAccount.length) throw conflict("SAME_ACCOUNT", "This account is already saved for this vendor");
    const next = await one<{ version: number }>(c, "SELECT coalesce(max(version), 0)::int + 1 AS version FROM vendor_bank_accounts WHERE vendor_id = $1", [vendorId]);
    // A newer proposal replaces any older one still waiting for approval.
    await c.query(
      `UPDATE vendor_bank_accounts SET status = 'REJECTED', status_reason = 'replaced by a newer proposal' WHERE vendor_id = $1 AND status = 'PENDING'`,
      [vendorId],
    );
    const row = await one<{ id: string }>(
      c,
      `INSERT INTO vendor_bank_accounts (vendor_id, version, account_number_enc, account_hash, account_last4, account_length, ifsc, bank_name, branch_name, bene_code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        vendorId,
        next!.version,
        encrypt(account, ctx.config.dataKey, "bank_account"),
        hash,
        account.slice(-4),
        account.length,
        ifsc,
        input.bankName?.trim() || null,
        input.branchName?.trim() || null,
        beneCode,
        user.id,
      ],
    );
    await audit(c, actorOf(user), {
      action: "vendor.bank_propose",
      entity: "vendor",
      entityId: vendorId,
      detail: { bankAccountId: row!.id, version: next!.version, accountLast4: account.slice(-4), ifsc, beneCode },
    });
  });
  return getVendor(ctx.pool, user, vendorId);
}

export async function approveBank(ctx: AppContext, user: SessionUser, vendorId: string, versionId: string): Promise<VendorDetail> {
  assertOwner(user);
  await tx(ctx.pool, async (c) => {
    const b = await one<{ id: string; status: string; version: number; account_last4: string; ifsc: string }>(
      c,
      "SELECT id, status, version, account_last4, ifsc FROM vendor_bank_accounts WHERE id = $1 AND vendor_id = $2 FOR UPDATE",
      [versionId, vendorId],
    );
    if (!b) throw notFound("Bank details not found");
    if (b.status !== "PENDING") throw conflict("INVALID_STATE", `These bank details are ${b.status}`);
    const old = await one<{ id: string; version: number }>(c, "SELECT id, version FROM vendor_bank_accounts WHERE vendor_id = $1 AND status = 'APPROVED' FOR UPDATE", [vendorId]);
    if (old) await c.query("UPDATE vendor_bank_accounts SET status = 'SUPERSEDED', status_reason = $2 WHERE id = $1", [old.id, `replaced by version ${b.version}`]);
    const r = await one<{ usable_from: Date }>(
      c,
      `UPDATE vendor_bank_accounts SET status = 'APPROVED', approved_by = $2, approved_at = now(), usable_from = now() + ($3::int * interval '1 hour')
        WHERE id = $1 RETURNING usable_from`,
      [versionId, user.id, ctx.config.COOLING_OFF_HOURS],
    );
    await audit(c, actorOf(user), {
      action: "vendor.bank_approve",
      entity: "vendor",
      entityId: vendorId,
      detail: { bankAccountId: versionId, version: b.version, accountLast4: b.account_last4, ifsc: b.ifsc, supersedes: old?.id, usableFrom: r!.usable_from.toISOString() },
    });
  });
  return getVendor(ctx.pool, user, vendorId);
}

/** Why a vendor can't be paid right now (undefined = ready). */
export function bankBlockedReason(v: { status: VendorStatus; bank_id: string | null; usable_from: Date | null }, now = new Date()): string | undefined {
  if (v.status === "BLOCKED") return "Vendor is blocked";
  if (v.status !== "ACTIVE") return "Vendor is not approved by the owner yet";
  if (!v.bank_id) return "No approved bank account";
  if (v.usable_from && v.usable_from > now) return `New bank account is in cooling-off until ${v.usable_from.toISOString()}`;
  return undefined;
}
