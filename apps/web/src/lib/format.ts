import type { Lang } from "@arad/core";
import { formatInr } from "@arad/core";

export const inr = (paise: number) => formatInr(paise);
/** Whole rupees when there are no paise: ₹1,250 instead of ₹1,250.00 (for summaries only). */
export const inrShort = (paise: number) => {
  const s = formatInr(paise);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
};

const locale = (lang: Lang) => (lang === "hi" ? "hi-IN" : "en-IN");

/** "2026-10-22" -> "22 Oct" (or "22 Oct 2025" if another year). Calendar strings, no time-zone shift. */
export function fmtDate(iso: string | undefined, lang: Lang, opts: { year?: boolean } = {}): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d, 12);
  const showYear = opts.year ?? y !== new Date().getFullYear();
  return date.toLocaleDateString(locale(lang), { day: "numeric", month: "short", ...(showYear ? { year: "numeric" } : {}) });
}

export function fmtDateTime(iso: string | undefined, lang: Lang): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(locale(lang), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function fmtTime(iso: string | undefined, lang: Lang): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(locale(lang), { hour: "numeric", minute: "2-digit" });
}

/** "5 min ago", "2 days ago" in the person's language. */
export function fmtAgo(iso: string | undefined, lang: Lang, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

/** Local calendar date as YYYY-MM-DD. */
export function todayIso(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Days from today to an ISO date (negative = past). */
export function daysFromToday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const a = new Date(y, m - 1, d).getTime();
  const t = new Date();
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

/** Typed keypad text ("1234.5") -> paise, or undefined if incomplete. */
export function keypadToPaise(text: string): number | undefined {
  if (!text || text === ".") return undefined;
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(text);
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Paise -> editable rupee text for inputs ("1250.5" for 125050, "" for undefined). */
export function paiseToInput(p: number | undefined): string {
  if (p === undefined) return "";
  const r = Math.floor(Math.abs(p) / 100);
  const f = Math.abs(p) % 100;
  return `${p < 0 ? "-" : ""}${r}${f ? `.${String(f).padStart(2, "0")}` : ""}`;
}

/** Rupee input text -> paise; undefined when empty/invalid. */
export function inputToPaise(s: string): number | undefined {
  const t = s.replace(/[,\s₹]/g, "");
  if (!t) return undefined;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(t);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : undefined;
}

export function inputToMilli(s: string): number | undefined {
  const t = s.replace(/[,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{0,3}))?$/.exec(t);
  return m ? Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0")) : undefined;
}

export function milliToInput(m: number | undefined): string {
  if (m === undefined) return "";
  return (m / 1000).toFixed(3).replace(/\.?0+$/, "");
}
