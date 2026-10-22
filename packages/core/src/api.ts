/**
 * HTTP API contract between apps/web and services/api.
 * All routes are under /api, JSON unless noted, session via httpOnly cookie "sid".
 * Errors: { error: { code: string; message: string; details?: unknown } } with a 4xx/5xx status.
 *
 * AUTH
 *   POST /api/auth/login            LoginRequest -> Me
 *   POST /api/auth/logout           -> { ok: true }
 *   GET  /api/me                    -> Me
 *   PUT  /api/me/lang               { lang } -> Me
 *
 * STORES / USERS (owner)
 *   GET  /api/stores                -> Store[]            (staff: only their stores)
 *   POST /api/stores                StoreInput -> Store
 *   GET  /api/users                 -> UserRow[]
 *   POST /api/users                 UserInput -> UserRow
 *
 * CAPTURE (staff, owner)
 *   POST /api/documents             multipart: fields storeId, clientId (uuid, idempotency), qr (JSON string[]);
 *                                   files "page" (1..10 images or 1 PDF) -> CaptureResponse
 *   GET  /api/documents/:id/pages/:n  -> image bytes (auth + store scope checked)
 *
 * INVOICES
 *   GET  /api/invoices?state=&storeId=&q=&limit=&cursor=   -> Page<InvoiceSummary>
 *   GET  /api/invoices/:id                                 -> InvoiceDetail
 *   POST /api/invoices/:id/lock-total   { typedTotalPaise } -> LockTotalResponse
 *   PUT  /api/invoices/:id/header       HeaderUpdate -> InvoiceDetail
 *   PUT  /api/invoices/:id/lines/:lineId LineUpdate -> InvoiceDetail      (accept / edit / remove)
 *   POST /api/invoices/:id/lines        LineInput -> InvoiceDetail         (add a missing line)
 *   POST /api/invoices/:id/seal         { durationMs } -> InvoiceDetail    (409 if checks fail or not balanced)
 *   POST /api/invoices/:id/reject       { reason } -> InvoiceDetail
 *   POST /api/invoices/:id/hold         { reason } -> InvoiceDetail ; POST /api/invoices/:id/unhold
 *   POST /api/invoices/:id/re-extract   -> InvoiceDetail
 *
 * VENDORS
 *   GET  /api/vendors?q=&status=        -> VendorSummary[]
 *   GET  /api/vendors/:id               -> VendorDetail
 *   POST /api/vendors                   VendorInput -> VendorDetail     (staff: status PENDING)
 *   PUT  /api/vendors/:id               VendorInput -> VendorDetail
 *   POST /api/vendors/:id/approve       -> VendorDetail                 (owner)
 *   POST /api/vendors/:id/bank          BankInput -> VendorDetail       (new PENDING version)
 *   POST /api/vendors/:id/bank/:versionId/approve -> VendorDetail       (owner)
 *
 * PAYABLES & PAYMENT RUNS
 *   GET  /api/payables?due=overdue|today|week|all  -> PayablesResponse
 *   POST /api/payment-runs              { invoiceIds, valueDate } -> PaymentRunDetail   (DRAFT)
 *   GET  /api/payment-runs              -> PaymentRunSummary[]
 *   GET  /api/payment-runs/:id          -> PaymentRunDetail
 *   POST /api/payment-runs/:id/approve  -> PaymentRunDetail   (owner; generates HDFC file)
 *   GET  /api/payment-runs/:id/file     -> text/plain attachment (the HDFC file)
 *   GET  /api/payment-runs/:id/advice.csv -> remittance advice CSV
 *   POST /api/payment-runs/:id/mark-uploaded -> PaymentRunDetail
 *   POST /api/payment-runs/:id/mark-paid { utrs?: Record<itemId, string> } -> PaymentRunDetail
 *   POST /api/payment-runs/:id/items/:itemId/mark-failed { reason } -> PaymentRunDetail
 *   POST /api/payment-runs/:id/cancel   -> PaymentRunDetail   (only before UPLOADED)
 *
 * DASHBOARD & SETTINGS (owner)
 *   GET  /api/dashboard                 -> Dashboard
 *   GET  /api/settings                  -> Settings (read-only view of config; secrets masked)
 *   GET  /api/audit?entity=&id=         -> AuditEntry[]
 *   GET  /api/health                    -> { ok: true, version } (no auth)
 */

import type { CheckResult, FieldMeta, HeaderField, InvoiceHeader, InvoiceLine, InvoiceState, InvoiceTotals, TotalsField } from "./invoice.js";
import type { EInvoiceQr } from "./qr.js";

export type Role = "owner" | "staff";
export type Lang = "en" | "hi";

export interface LoginRequest {
  phone: string;
  pin: string;
}
export interface Me {
  id: string;
  name: string;
  phone: string;
  role: Role;
  storeIds: string[];
  lang: Lang;
}

export interface Store {
  id: string;
  code: string;
  name: string;
  gstin?: string;
  address?: string;
}
export type StoreInput = Omit<Store, "id">;

export interface UserRow {
  id: string;
  name: string;
  phone: string;
  role: Role;
  storeIds: string[];
  active: boolean;
}
export interface UserInput {
  name: string;
  phone: string;
  pin: string;
  role: Role;
  storeIds: string[];
}

export interface CaptureResponse {
  documentId: string;
  invoiceId: string;
  state: InvoiceState;
  /** Set when this looks like a bill already captured. */
  duplicateOf?: { invoiceId: string; reason: "same_image" | "same_irn" | "same_number" };
}

export interface InvoiceSummary {
  id: string;
  storeId: string;
  storeName: string;
  state: InvoiceState;
  vendorId?: string;
  vendorName?: string;
  invoiceNo?: string;
  invoiceDate?: string;
  grandTotalPaise?: number;
  lineCount: number;
  flaggedCount: number;
  createdAt: string;
  thumbUrl?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface InvoiceDetail {
  id: string;
  storeId: string;
  state: InvoiceState;
  vendorId?: string;
  vendorName?: string;
  header: InvoiceHeader;
  headerMeta: Partial<Record<HeaderField, FieldMeta>>;
  totals: InvoiceTotals;
  totalsMeta: Partial<Record<TotalsField, FieldMeta>>;
  lines: InvoiceLine[];
  checks: CheckResult[];
  qr?: EInvoiceQr;
  lockedTotalPaise?: number;
  pages: { url: string; width?: number; height?: number }[];
  dueDate?: string;
  duplicateOfId?: string;
  holdReason?: string;
  createdAt: string;
  capturedBy: string;
  verifiedBy?: string;
  verifiedAt?: string;
  extraction?: { providers: { provider: string; ok: boolean; ms: number; error?: string }[] };
}

export interface LockTotalResponse {
  match: boolean;
  /** Only revealed after the typed value is stored (blind entry). */
  extractedTotalPaise: number;
  /** Attempts so far; after 2 mismatches the typed value is trusted and the bill is flagged. */
  attempts: number;
  invoice: InvoiceDetail;
}

export type HeaderUpdate = Partial<InvoiceHeader> & { vendorId?: string; totals?: Partial<InvoiceTotals> };

export type LineUpdate =
  | { action: "accept" }
  | { action: "remove" }
  | { action: "edit"; line: LineInput };

export interface LineInput {
  description: string;
  hsn?: string;
  qtyMilli: number;
  unit?: string;
  mrpPaise?: number;
  ratePaise: number;
  discountPaise: number;
  gstRateBp: number;
  /** If omitted, computed from qty × rate − discount + GST. */
  totalPaise?: number;
}

export type VendorStatus = "PENDING" | "ACTIVE" | "BLOCKED";

export interface VendorSummary {
  id: string;
  name: string;
  gstin?: string;
  status: VendorStatus;
  bankStatus: "NONE" | "PENDING" | "APPROVED";
  /** e.g. "XXXXXX5678" — never the full number. */
  accountMasked?: string;
  ifsc?: string;
  owedPaise: number;
}

export interface VendorDetail extends VendorSummary {
  tradeName?: string;
  pan?: string;
  phone?: string;
  email?: string;
  paymentTermsDays: number;
  bankVersions: BankVersion[];
}

export interface BankVersion {
  id: string;
  version: number;
  accountMasked: string;
  ifsc: string;
  bankName?: string;
  branchName?: string;
  beneCode?: string;
  status: "PENDING" | "APPROVED" | "SUPERSEDED" | "REJECTED";
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Payments to a newly approved account are blocked until this time (cooling-off). */
  usableFrom?: string;
}

export interface VendorInput {
  name: string;
  tradeName?: string;
  gstin?: string;
  pan?: string;
  phone?: string;
  email?: string;
  paymentTermsDays?: number;
}

export interface BankInput {
  accountNumber: string;
  /** Must equal accountNumber (typed twice). */
  accountNumberConfirm: string;
  ifsc: string;
  bankName?: string;
  branchName?: string;
  beneCode?: string;
}

export interface PayableBill {
  invoiceId: string;
  storeId: string;
  storeName: string;
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  amountPaise: number;
  docType: "INV" | "CRN" | "DBN";
}
export interface PayableVendor {
  vendorId: string;
  vendorName: string;
  bankReady: boolean;
  /** Why the vendor cannot be paid yet, if so. */
  blockedReason?: string;
  totalPaise: number;
  bills: PayableBill[];
}
export interface PayablesResponse {
  vendors: PayableVendor[];
  totalPaise: number;
}

export type PaymentRunState = "DRAFT" | "APPROVED" | "UPLOADED" | "PAID" | "CANCELLED";

export interface PaymentRunSummary {
  id: string;
  ref: string;
  state: PaymentRunState;
  valueDate: string;
  count: number;
  totalPaise: number;
  createdAt: string;
  preparedBy: string;
  approvedBy?: string;
}

export interface PaymentRunItem {
  id: string;
  vendorId: string;
  vendorName: string;
  accountMasked: string;
  ifsc: string;
  txnType: "N" | "R" | "I";
  amountPaise: number;
  customerRef: string;
  bills: { invoiceId: string; invoiceNo: string; storeName: string; amountPaise: number }[];
  state: "PENDING" | "PAID" | "FAILED";
  utr?: string;
  failReason?: string;
}

export interface RunWarning {
  vendorId?: string;
  level: "info" | "warn" | "block";
  code: "new_vendor" | "bank_recent_change" | "amount_unusual" | "possible_duplicate" | "bank_not_ready" | "same_preparer" | "over_limit";
  message: string;
}

export interface PaymentRunDetail extends PaymentRunSummary {
  items: PaymentRunItem[];
  warnings: RunWarning[];
  file?: { name: string; sha256: string; control: { count: number; total: string; byType: Record<"N" | "R" | "I", { count: number; totalPaise: number }> } };
}

export interface StoreToday {
  storeId: string;
  storeName: string;
  captured: number;
  needsVerification: number;
  verified: number;
  flagged: number;
}
export interface Dashboard {
  stores: StoreToday[];
  owedPaise: number;
  overduePaise: number;
  dueThisWeekPaise: number;
  vendorsDue: number;
  pendingApprovals: { vendors: number; bankChanges: number; runs: number };
  recentRuns: PaymentRunSummary[];
}

export interface Settings {
  hdfcClientCode?: string;
  rtgsFromPaise: number;
  coolingOffHours: number;
  requireDifferentApprover: boolean;
  aiProviders: { id: string; enabled: boolean; keys: number; trainsOnInput: boolean; allowedForRealData: boolean; model?: string }[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  detail?: unknown;
}
