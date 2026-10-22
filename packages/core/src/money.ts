/** Money is always integer paise. These helpers are the only way in and out. */

/** "1,23,456.7" / "123456.70" / 123456.7 -> 12345670. Throws on anything ambiguous. */
export function toPaise(value: string | number): number {
  const text = typeof value === "number" ? numberToFixed2(value) : value.replace(/[,\s₹]/g, "").replace(/^Rs\.?/i, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new Error(`not an amount: ${value}`);
  const [, sign, whole, frac = ""] = m;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) throw new Error(`amount too large: ${value}`);
  return sign ? -paise : paise;
}

/** Like toPaise but returns undefined instead of throwing. */
export function tryPaise(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  try {
    return toPaise(value);
  } catch {
    return undefined;
  }
}

function numberToFixed2(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not an amount: ${n}`);
  // toFixed rounds the binary float correctly enough for 2 decimals of human-entered amounts.
  return n.toFixed(2);
}

/** 12345670 -> "1,23,456.70" (Indian digit grouping). */
export function formatInr(paise: number, opts: { symbol?: boolean } = {}): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100).toString();
  const frac = String(abs % 100).padStart(2, "0");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}${opts.symbol === false ? "" : "₹"}${grouped}.${frac}`;
}

/** Quantity is stored in thousandths so 2.5 kg = 2500. */
export function toMilli(value: string | number): number {
  const text = typeof value === "number" ? value.toFixed(3) : value.replace(/[,\s]/g, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) throw new Error(`not a quantity: ${value}`);
  const [, sign, whole, frac = ""] = m;
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  return sign ? -milli : milli;
}

export function formatMilli(milli: number): string {
  const s = (milli / 1000).toFixed(3);
  return s.replace(/\.?0+$/, "");
}

/** GST rate in basis points: 18% = 1800. */
export function toBp(percent: string | number): number {
  return Math.round(Number(percent) * 100);
}

export function formatBp(bp: number): string {
  return `${(bp / 100).toString()}%`;
}
