import type { CheckResult } from "@arad/core";
import { DICTS, format, type MessageKey } from "../i18n";

/** Shows a check in the person's language; falls back to the server's English message. */
export function checkText(c: CheckResult, lang: "en" | "hi"): string {
  const key = `chk.${c.id}.${c.status}` as MessageKey;
  const tpl = DICTS[lang][key];
  if (!tpl) return c.message;
  const line = /^Line (\d+)/.exec(c.message)?.[1];
  const qr = /QR says (\d+) items, bill has (\d+)/.exec(c.message);
  // English wording varies within one id (e.g. two tax-split messages); keep the server's exact text in English.
  if (lang === "en" && (c.id === "tax_split" || c.id === "invoice_date" || c.id === "gst_rate")) return c.message;
  return format(tpl, { n: line ?? "", a: qr?.[1] ?? "", b: qr?.[2] ?? "" });
}
