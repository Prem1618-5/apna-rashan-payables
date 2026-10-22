import type { EInvoiceQr, ExtractContext, PageImage, ProviderInfo, RawExtraction } from "@arad/core";

/** Extra per-line hint some readers give: the printed rate already includes GST. */
export interface RawLineHints {
  rateIncludesTax?: boolean;
  /** Only a discount percent was printed; the amount is computed from qty × rate. */
  discountPercent?: number;
}

/** What one provider call returns. */
export interface ProviderResult {
  raw: RawExtraction;
  /** Which key slot answered (1, 2, 3 …), never the key itself. */
  keySlot?: number;
  model: string;
  /** Free-text warnings the reader gave (handwriting, torn page …). */
  notes?: string[];
}

export interface Provider {
  id: string;
  /** Company behind the model. Two readers from the same vendor are not independent. */
  vendor: string;
  info: ProviderInfo;
  available(): boolean;
  /** Number of keys configured (status only, never the keys). */
  keyCount?(): number;
  extract(pages: PageImage[], signal?: AbortSignal): Promise<ProviderResult>;
}

/** Thrown by providers for transport-level failures. The router turns them into ProviderRun errors. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limited" | "forbidden" | "server" | "timeout" | "bad_response" | "blocked" | "config" | "aborted" | "other",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** ExtractContext plus the e-invoice QR when the phone decoded one (proposed for core). */
export type ExtractContextExt = ExtractContext & {
  qr?: EInvoiceQr;
  /** Raw QR strings as captured; parsed with classifyQr when `qr` is not given. */
  qrRaw?: string[];
};

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** JSON lines to stdout (twelve-factor). Never pass keys or personal data in fields. */
export function jsonLogger(level: string = "info"): Logger {
  const order = ["debug", "info", "warn", "error"];
  const min = Math.max(0, order.indexOf(level));
  const write = (lvl: string, msg: string, fields?: Record<string, unknown>) => {
    if (order.indexOf(lvl) < min) return;
    process.stdout.write(`${JSON.stringify({ level: lvl, time: new Date().toISOString(), component: "extraction", msg, ...fields })}\n`);
  };
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
