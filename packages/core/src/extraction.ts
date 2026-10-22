/** Contract between extraction providers and the rest of the system. */

import type { Box, FieldMeta, HeaderField, InvoiceHeader, InvoiceLine, InvoiceTotals, TotalsField } from "./invoice.js";

/** What one provider read from the page, in rupees as printed (converted to paise by the merger). */
export interface RawExtractedLine {
  description: string;
  hsn?: string;
  qty: number;
  unit?: string;
  mrp?: number;
  rate: number;
  discount?: number;
  gstRate?: number;
  taxable?: number;
  tax?: number;
  amount: number;
  box?: Box;
  confidence?: number;
}

export interface RawExtraction {
  header: InvoiceHeader;
  totals: {
    taxable?: number;
    cgst?: number;
    sgst?: number;
    igst?: number;
    otherCharges?: number;
    discount?: number;
    roundOff?: number;
    grandTotal?: number;
  };
  lines: RawExtractedLine[];
  /** Whether line "amount" on this invoice includes GST. */
  amountIncludesTax?: boolean;
  confidence?: Partial<Record<HeaderField | `totals.${string}`, number>>;
}

export interface ProviderInfo {
  id: string;
  /** Does the provider's terms allow it to train on what we send? */
  trainsOnInput: boolean;
  model?: string;
}

export interface ProviderRun {
  provider: string;
  model?: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** Which key slot was used (1, 2, 3 …), never the key itself. */
  keySlot?: number;
  raw?: RawExtraction;
}

/** The merged, paise-normalised draft the verify screen starts from. */
export interface MergedExtraction {
  header: InvoiceHeader;
  headerMeta: Partial<Record<HeaderField, FieldMeta>>;
  totals: InvoiceTotals;
  totalsMeta: Partial<Record<TotalsField, FieldMeta>>;
  lines: Omit<InvoiceLine, "id">[];
  runs: ProviderRun[];
}

export type PageImage = { mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"; data: Uint8Array };

export type DataClass = "synthetic" | "real";

export interface ExtractContext {
  /** Real invoices are never sent to providers whose terms allow training on input, unless explicitly allowed. */
  dataClass: DataClass;
  storeGstins: string[];
  /** For logs and idempotency; never sent to providers. */
  invoiceId?: string;
}

export interface ProviderStatus {
  id: string;
  enabled: boolean;
  /** Number of keys configured (e.g. GEMINI_API_KEY_1..3), never the keys. */
  keys: number;
  trainsOnInput: boolean;
  allowedForRealData: boolean;
  model?: string;
}

/** Implemented by @arad/extraction (createExtractor(env)) and by a mock for tests. */
export interface Extractor {
  extract(pages: PageImage[], ctx: ExtractContext): Promise<MergedExtraction>;
  providers(): ProviderStatus[];
}
