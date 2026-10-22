/** In-memory database of the mock backend, persisted to localStorage so a reload keeps the demo state. */
import type {
  AuditEntry,
  BankVersion,
  EInvoiceQr,
  FieldMeta,
  HeaderField,
  InvoiceHeader,
  InvoiceLine,
  InvoiceState,
  InvoiceTotals,
  Lang,
  PaymentRunItem,
  PaymentRunState,
  Role,
  RunWarning,
  Store,
  TotalsField,
  VendorStatus,
} from "@arad/core";
import type { PaperBill } from "./invoice-svg";

export interface DbUser {
  id: string;
  name: string;
  phone: string;
  pin: string;
  role: Role;
  storeIds: string[];
  active: boolean;
  lang: Lang;
}

export interface DbBank extends Omit<BankVersion, "accountMasked"> {
  /** Full number lives only on the "server" side of the mock. */
  accountNumber: string;
}

export interface DbVendor {
  id: string;
  name: string;
  tradeName?: string;
  gstin?: string;
  pan?: string;
  phone?: string;
  email?: string;
  paymentTermsDays: number;
  status: VendorStatus;
  createdAt: string;
  bank: DbBank[];
}

export interface DbInvoice {
  id: string;
  documentId: string;
  clientId?: string;
  storeId: string;
  state: InvoiceState;
  vendorId?: string;
  header: InvoiceHeader;
  headerMeta: Partial<Record<HeaderField, FieldMeta>>;
  totals: InvoiceTotals;
  totalsMeta: Partial<Record<TotalsField, FieldMeta>>;
  lines: InvoiceLine[];
  qr?: EInvoiceQr;
  lockedTotalPaise?: number;
  lockAttempts: number;
  /** What is printed on the paper (drawn as the page image). */
  paper: PaperBill;
  dueDate?: string;
  duplicateOfId?: string;
  holdReason?: string;
  rejectReason?: string;
  createdAt: string;
  capturedBy: string;
  verifiedBy?: string;
  verifiedAt?: string;
  verifyMs?: number;
  /** EXTRACTING bills become NEEDS_VERIFICATION after this time. */
  readyAt?: string;
  extraPages?: number;
}

export interface DbRun {
  id: string;
  ref: string;
  state: PaymentRunState;
  valueDate: string;
  createdAt: string;
  preparedBy: string;
  preparedById: string;
  approvedBy?: string;
  items: PaymentRunItem[];
  warnings: RunWarning[];
  invoiceIds: string[];
  file?: {
    name: string;
    sha256: string;
    content: string;
    control: { count: number; total: string; byType: Record<"N" | "R" | "I", { count: number; totalPaise: number }> };
  };
}

export interface Db {
  version: 1;
  seq: number;
  stores: Store[];
  users: DbUser[];
  vendors: DbVendor[];
  invoices: DbInvoice[];
  runs: DbRun[];
  audit: AuditEntry[];
  fileSeqByDate: Record<string, number>;
}

const KEY = "arad.mock.db.v1";
const SID = "arad.mock.sid";

export function loadDb(): Db | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const db = JSON.parse(raw) as Db;
    return db.version === 1 ? db : undefined;
  } catch {
    return undefined;
  }
}

export function saveDb(db: Db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* quota: the demo keeps working in memory */
  }
}

export function clearDb() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(SID);
  } catch {
    /* ignore */
  }
}

export const session = {
  get(): string | undefined {
    try {
      return localStorage.getItem(SID) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(userId: string | undefined) {
    try {
      if (userId) localStorage.setItem(SID, userId);
      else localStorage.removeItem(SID);
    } catch {
      /* ignore */
    }
  },
};
