import type { LayoutSpec } from "./spec.js";

/** N = NEFT, R = RTGS, I = transfer to another HDFC Bank account. */
export type TxnType = "N" | "R" | "I";

/** A vendor's payee details, entered once in the vendor master. */
export interface Vendor {
  id: string;
  name: string;
  accountNumber: string;
  ifsc: string;
  /** Code under which this vendor is registered as a beneficiary in ENet, if any. */
  beneCode?: string;
  email?: string;
  bankName?: string;
  branchName?: string;
  address?: string[];
}

/** A verified bill that is due for payment. */
export interface PayableBill {
  vendorId: string;
  billNo: string;
  storeCode: string;
  /** Positive for a bill, negative for a credit note. Integer paise. */
  amountPaise: number;
}

/** One line of the bank file: one payment to one vendor. */
export interface PaymentInstruction {
  /** Our unique reference for this payment (max 20, letters and digits). Used to match the bank's response. */
  customerRef: string;
  vendor: Vendor;
  amountPaise: number;
  billRefs: string[];
}

export interface FileOptions {
  /** Corporate client code given by HDFC for ENet. */
  clientCode: string;
  /** Payment date, YYYY-MM-DD. */
  valueDate: string;
  /** File number for that day, 1 to 999. */
  sequence: number;
  /** Amounts at or above this go by RTGS. Default Rs 2,00,000 (RTGS minimum). */
  rtgsFromPaise?: number;
  /** Use the internal transfer type (I) when the vendor banks with HDFC. Default true. */
  internalForHdfc?: boolean;
  /** Transaction types that need an ENet beneficiary code. Default ["I"]. */
  beneCodeRequiredFor?: TxnType[];
  /** Refuse any single payment above this amount. Optional safety limit. */
  maxAmountPaise?: number;
  /** First word(s) of the narration. Default "BILLS". */
  narrationPrefix?: string;
  layout?: LayoutSpec;
}

export interface Issue {
  customerRef?: string;
  vendorId?: string;
  field?: string;
  message: string;
}

export interface RowPreview {
  customerRef: string;
  vendorId: string;
  vendorName: string;
  txnType: TxnType;
  amount: string;
  billRefs: string[];
}

export interface ControlTotals {
  count: number;
  totalPaise: number;
  /** Total formatted as the bank shows it, e.g. "125000.50". */
  total: string;
  byType: Record<TxnType, { count: number; totalPaise: number }>;
}

export type FileResult =
  | { ok: true; fileName: string; content: string; sha256: string; control: ControlTotals; rows: RowPreview[]; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };
