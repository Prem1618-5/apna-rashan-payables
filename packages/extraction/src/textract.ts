/** AWS Textract AnalyzeExpense reader. Enabled only with TEXTRACT_ENABLED=true. Data stays in our AWS account. */

import { AnalyzeExpenseCommand, TextractClient, type AnalyzeExpenseCommandOutput, type ExpenseField } from "@aws-sdk/client-textract";
import type { PageImage, ProviderInfo, RawExtractedLine, RawExtraction } from "@arad/core";
import { normaliseGstin, parseNum } from "./normalise.js";
import { ProviderError, silentLogger, type Logger, type Provider, type ProviderResult } from "./types.js";

const GSTIN_RE = /\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]/;
const BUYER_LABEL = /(bill(ed)?\s*to|buyer|customer|recipient|consignee|ship(ped)?\s*to|party|receiver|sold\s*to)/i;

const text = (f: ExpenseField) => f.ValueDetection?.Text?.trim() ?? "";
const label = (f: ExpenseField) => f.LabelDetection?.Text?.trim() ?? "";
const type = (f: ExpenseField) => f.Type?.Text ?? "";
const conf = (f: ExpenseField) => {
  const c = f.ValueDetection?.Confidence ?? f.Type?.Confidence;
  return c === undefined ? undefined : Math.max(0, Math.min(1, c / 100));
};
const groups = (f: ExpenseField) => (f.GroupProperties ?? []).flatMap((g) => g.Types ?? []);

function findGstin(s: string): string | undefined {
  const m = GSTIN_RE.exec(s.replace(/\s/g, "").toUpperCase());
  return m ? normaliseGstin(m[0]).value : undefined;
}

/** "%" columns and "18%" values -> 18. */
const pct = (s: string) => parseNum(s.replace(/%/g, ""));

/** Map AnalyzeExpense output (one per page, in page order) to RawExtraction. Pure: used by tests with recorded output. */
export function mapTextractExpense(outputs: Pick<AnalyzeExpenseCommandOutput, "ExpenseDocuments">[]): RawExtraction {
  const header: RawExtraction["header"] = {};
  const totals: RawExtraction["totals"] = {};
  const confidence: Record<string, number> = {};
  const lines: RawExtractedLine[] = [];
  const set = <K extends keyof RawExtraction["header"]>(k: K, v: RawExtraction["header"][K] | undefined, c?: number) => {
    if (v === undefined || v === "" || header[k] !== undefined) return;
    header[k] = v;
    if (c !== undefined) confidence[k] = c;
  };
  const setT = (k: keyof RawExtraction["totals"], s: string, c?: number, add = false) => {
    const n = parseNum(s);
    if (n === undefined) return;
    if (add && totals[k] !== undefined) totals[k] = Math.round((totals[k]! + n) * 100) / 100;
    else if (totals[k] === undefined) totals[k] = n;
    else return;
    if (c !== undefined) confidence[`totals.${k}`] = c;
  };

  outputs.forEach((out, pageIdx) => {
    for (const doc of out.ExpenseDocuments ?? []) {
      for (const f of doc.SummaryFields ?? []) {
        const t = type(f);
        const v = text(f);
        const l = label(f);
        const c = conf(f);
        const g = findGstin(v) ?? (/gst/i.test(l) ? findGstin(v) : undefined);
        if (g) {
          const isBuyer = groups(f).includes("RECEIVER") || BUYER_LABEL.test(l) || t.startsWith("RECEIVER");
          if (isBuyer) set("buyerGstin", g, c);
          else if (!header.sellerGstin) set("sellerGstin", g, c);
          else set("buyerGstin", g, c);
          continue;
        }
        switch (t) {
          case "INVOICE_RECEIPT_ID": set("invoiceNo", v, c); break;
          case "INVOICE_RECEIPT_DATE": set("invoiceDate", v, c); break;
          case "VENDOR_NAME": set("vendorName", v, c); break;
          case "NAME": if (groups(f).includes("VENDOR")) set("vendorName", v, c); break;
          case "SUBTOTAL": setT("taxable", v, c); break;
          case "TAX":
            if (/igst/i.test(l)) setT("igst", v, c);
            else if (/cgst/i.test(l)) setT("cgst", v, c);
            else if (/sgst|utgst/i.test(l)) setT("sgst", v, c);
            break;
          case "TOTAL": setT("grandTotal", v, c); break;
          case "AMOUNT_DUE": if (totals.grandTotal === undefined) setT("grandTotal", v, c); break;
          case "DISCOUNT": setT("discount", v.replace(/^-/, ""), c); break;
          case "SHIPPING_HANDLING_CHARGE": setT("otherCharges", v, c, true); break;
          case "OTHER":
            if (/round/i.test(l)) setT("roundOff", v, c);
            else if (/freight|cartage|packing|delivery|transport/i.test(l)) setT("otherCharges", v, c, true);
            else if (/taxable/i.test(l)) setT("taxable", v, c);
            else if (/^\s*igst/i.test(l)) setT("igst", v, c);
            else if (/^\s*cgst/i.test(l)) setT("cgst", v, c);
            else if (/^\s*sgst/i.test(l)) setT("sgst", v, c);
            else if (/credit\s*note/i.test(l + v)) set("docType", "CRN", c);
            else if (/\birn\b/i.test(l)) set("irn", v.replace(/\s/g, ""), c);
            break;
          default: break;
        }
      }
      for (const group of doc.LineItemGroups ?? []) {
        for (const item of group.LineItems ?? []) {
          const fields = item.LineItemExpenseFields ?? [];
          const row: Record<string, unknown> = {};
          let rowConf: number | undefined;
          for (const f of fields) {
            const t = type(f);
            const v = text(f);
            const l = label(f);
            const c = conf(f);
            if (c !== undefined && t !== "EXPENSE_ROW") rowConf = rowConf === undefined ? c : Math.min(rowConf, c);
            switch (t) {
              case "ITEM": row.description = v; break;
              case "QUANTITY": row.qty = parseNum(v.replace(/[a-z]+$/i, "")) ?? v; if (/[a-z]+$/i.test(v)) row.unit = /[a-z]+$/i.exec(v)![0]; break;
              case "UNIT_PRICE": row.rate = parseNum(v); break;
              case "PRICE": row.amount = parseNum(v); break;
              case "PRODUCT_CODE": if (/^\d{4,8}$/.test(v.replace(/\s/g, ""))) row.hsn = v; break;
              case "EXPENSE_ROW": {
                const bb = f.ValueDetection?.Geometry?.BoundingBox;
                if (bb) row.box = { page: (f.PageNumber ?? pageIdx + 1) - 1, x: bb.Left ?? 0, y: bb.Top ?? 0, w: bb.Width ?? 0, h: bb.Height ?? 0 };
                break;
              }
              case "OTHER":
                if (/hsn|sac/i.test(l)) row.hsn = v;
                else if (/gst\s*%|tax\s*%|gst\s*rate|^gst$/i.test(l)) row.gstRate = pct(v);
                else if (/mrp/i.test(l)) row.mrp = parseNum(v);
                else if (/taxable/i.test(l)) row.taxable = parseNum(v);
                else if (/disc/i.test(l)) {
                  if (/%/.test(l + v)) row.discountPercent = pct(v);
                  else row.discount = parseNum(v);
                } else if (/unit|uom/i.test(l)) row.unit = v;
                else if (/gst\s*amt|tax\s*amt/i.test(l)) row.tax = parseNum(v);
                break;
              default: break;
            }
          }
          if (row.description === undefined && row.amount === undefined) continue;
          if (rowConf !== undefined) row.confidence = rowConf;
          lines.push({ description: String(row.description ?? ""), qty: (row.qty as number) ?? NaN, rate: (row.rate as number) ?? NaN, amount: (row.amount as number) ?? NaN, ...row } as RawExtractedLine);
        }
      }
    }
  });
  return { header, totals, lines, confidence };
}

export interface TextractOptions {
  region?: string;
  client?: Pick<TextractClient, "send">;
  logger?: Logger;
  enabled: boolean;
}

export class TextractProvider implements Provider {
  readonly id = "textract";
  readonly vendor = "aws";
  readonly info: ProviderInfo = { id: "textract", trainsOnInput: false, model: "AnalyzeExpense" };
  private client?: Pick<TextractClient, "send">;
  private readonly log: Logger;

  constructor(private readonly opts: TextractOptions) {
    this.client = opts.client;
    this.log = opts.logger ?? silentLogger;
  }

  available() {
    return this.opts.enabled;
  }

  async extract(pages: PageImage[], signal?: AbortSignal): Promise<ProviderResult> {
    if (!pages.length) throw new ProviderError("no pages", "config");
    if (pages.some((p) => p.mime === "image/webp")) throw new ProviderError("Textract does not accept WebP", "config");
    this.client ??= new TextractClient({ region: this.opts.region ?? "ap-south-1" });
    const outputs: AnalyzeExpenseCommandOutput[] = [];
    for (const p of pages) {
      try {
        outputs.push((await this.client.send(new AnalyzeExpenseCommand({ Document: { Bytes: p.data } }), { abortSignal: signal })) as AnalyzeExpenseCommandOutput);
      } catch (e) {
        const name = (e as { name?: string }).name ?? "";
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        this.log.warn("textract call failed", { provider: this.id, name, status });
        const kind = name === "ThrottlingException" || name === "ProvisionedThroughputExceededException" ? "rate_limited" : name === "AccessDeniedException" || status === 403 ? "forbidden" : status && status >= 500 ? "server" : name === "AbortError" ? "aborted" : "other";
        throw new ProviderError(`textract ${name || "error"}${status ? ` (${status})` : ""}`, kind, status);
      }
    }
    return { raw: mapTextractExpense(outputs), model: "AnalyzeExpense" };
  }
}
