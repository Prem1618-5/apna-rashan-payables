/** Classify and parse QR codes found on an invoice page. */

export interface EInvoiceQr {
  sellerGstin: string;
  buyerGstin: string;
  docNo: string;
  docType: string;
  /** YYYY-MM-DD */
  docDate: string;
  totalPaise: number;
  itemCount: number;
  mainHsn?: string;
  irn: string;
  irnDate?: string;
}

export interface UpiQr {
  payeeVpa: string;
  payeeName?: string;
  amount?: string;
}

export type ClassifiedQr =
  | { kind: "einvoice"; raw: string; data: EInvoiceQr }
  | { kind: "upi"; raw: string; data: UpiQr }
  | { kind: "other"; raw: string };

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

function ddmmyyyyToIso(d: string | undefined): string | undefined {
  const m = d && /^(\d{2})\/(\d{2})\/(\d{4})/.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/**
 * GST e-invoice QR is a signed JWT. The payload's "data" field is a JSON string
 * with header-level fields only (no line items). Signature is not checked here.
 */
export function parseEInvoiceQr(raw: string): EInvoiceQr | undefined {
  const parts = raw.trim().split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as { data?: string | Record<string, unknown> };
    const data = (typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data) as Record<string, unknown> | undefined;
    if (!data || typeof data.SellerGstin !== "string" || typeof data.Irn !== "string") return undefined;
    const total = Number(data.TotInvVal);
    return {
      sellerGstin: String(data.SellerGstin),
      buyerGstin: String(data.BuyerGstin ?? ""),
      docNo: String(data.DocNo ?? ""),
      docType: String(data.DocTyp ?? "INV"),
      docDate: ddmmyyyyToIso(String(data.DocDt ?? "")) ?? "",
      totalPaise: Math.round(total * 100),
      itemCount: Number(data.ItemCnt ?? 0),
      mainHsn: data.MainHsnCode ? String(data.MainHsnCode) : undefined,
      irn: String(data.Irn),
      irnDate: data.IrnDt ? String(data.IrnDt) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** UPI QR is only a hint about the payee. Never use it as bank details. */
export function parseUpiQr(raw: string): UpiQr | undefined {
  if (!/^upi:\/\/pay\?/i.test(raw.trim())) return undefined;
  const params = new URLSearchParams(raw.trim().replace(/^upi:\/\/pay\?/i, ""));
  const pa = params.get("pa");
  if (!pa) return undefined;
  return { payeeVpa: pa, payeeName: params.get("pn") ?? undefined, amount: params.get("am") ?? undefined };
}

export function classifyQr(raw: string): ClassifiedQr {
  const einv = parseEInvoiceQr(raw);
  if (einv) return { kind: "einvoice", raw, data: einv };
  const upi = parseUpiQr(raw);
  if (upi) return { kind: "upi", raw, data: upi };
  return { kind: "other", raw };
}
