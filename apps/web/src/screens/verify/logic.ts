/** Pure glue between the verify UI and @arad/core (unit-tested in test/verify-logic.test.ts). */
import type { Box, FieldMeta, InvoiceDetail, InvoiceLine, LineField, LineStatus } from "@arad/core";
import { balanceHints, computeLine, verificationBalance } from "@arad/core";

export type LocalStatus = Record<string, LineStatus>;

/** Server lines with local overrides (optimistic accepts, undos) applied. */
export function effectiveLines(lines: InvoiceLine[], local: LocalStatus): InvoiceLine[] {
  return lines.map((l) => (local[l.id] && local[l.id] !== l.status ? { ...l, status: local[l.id]! } : l));
}

/** Lines still to swipe, in paper order. */
export const pendingLines = (lines: InvoiceLine[]) => lines.filter((l) => l.status === "pending").sort((a, b) => a.idx - b.idx);

export interface MeterState {
  lockedPaise: number;
  remainingPaise: number;
  confirmedPaise: number;
  confirmedCount: number;
  pendingCount: number;
  totalCount: number;
  balanced: boolean;
  /** 0..1 progress toward the locked total (clamped). */
  progress: number;
  /** Lines all done but the money doesn't add up. */
  stuck: boolean;
  hints: ReturnType<typeof balanceHints>;
}

export function meterState(inv: Pick<InvoiceDetail, "totals" | "lockedTotalPaise">, lines: InvoiceLine[]): MeterState {
  const locked = inv.lockedTotalPaise ?? 0;
  const b = verificationBalance(locked, lines, inv.totals);
  const confirmedPaise = locked - b.remainingPaise;
  const live = lines.filter((l) => l.status !== "removed");
  const stuck = b.pendingCount === 0 && b.remainingPaise !== 0;
  return {
    lockedPaise: locked,
    remainingPaise: b.remainingPaise,
    confirmedPaise,
    confirmedCount: b.confirmedCount,
    pendingCount: b.pendingCount,
    totalCount: live.length,
    balanced: b.balanced,
    progress: locked > 0 ? Math.max(0, Math.min(1, confirmedPaise / locked)) : 0,
    stuck,
    hints: stuck ? balanceHints(b.remainingPaise, lines) : [],
  };
}

/** Low confidence = below 0.8 or flagged by a check/disagreement. */
export const isLow = (m?: FieldMeta) => !!m && (m.confidence < 0.8 || !!m.flagged);
export function lowFields(line: Pick<InvoiceLine, "meta">): LineField[] {
  return Object.entries(line.meta ?? {})
    .filter(([, m]) => isLow(m))
    .map(([k]) => k as LineField);
}

/** Minimum look time before "matches" is allowed: ~600 ms, longer for busy or doubtful lines. */
export function dwellMs(line: InvoiceLine): number {
  const fields = [line.description, line.hsn, line.qtyMilli, line.unit, line.mrpPaise, line.ratePaise, line.discountPaise || undefined, line.gstRateBp, line.totalPaise].filter(
    (v) => v !== undefined && v !== "",
  ).length;
  return Math.max(600, Math.min(2200, 250 + fields * 55 + lowFields(line).length * 450));
}

export type SwipeResult = "accept" | "edit" | "cancel";
/** Distance or a quick flick decides; small moves snap back. */
export function decideSwipe(dx: number, velocityPxPerMs: number, width: number): SwipeResult {
  const far = Math.abs(dx) > width * 0.32;
  const flick = Math.abs(velocityPxPerMs) > 0.55 && Math.abs(dx) > 36 && Math.sign(velocityPxPerMs) === Math.sign(dx);
  if (!far && !flick) return "cancel";
  return dx > 0 ? "accept" : "edit";
}

/** True when the line's printed amount disagrees with qty × rate − discount + GST. */
export function mathOff(line: Pick<InvoiceLine, "qtyMilli" | "ratePaise" | "discountPaise" | "gstRateBp" | "totalPaise">, tolerancePaise = 5): number {
  const c = computeLine(line);
  const diff = line.totalPaise - c.totalPaise;
  return Math.abs(diff) > tolerancePaise ? diff : 0;
}

/** Split a wide line crop into 1–3 strips so the print stays readable on a narrow phone. */
export function cropStrips(box: Box, pageW: number, pageH: number, padY = 0.1): Box[] {
  const y = Math.max(0, box.y - box.h * padY);
  const h = Math.min(1 - y, box.h * (1 + 2 * padY));
  const aspect = (box.w * pageW) / (h * pageH);
  const n = Math.max(1, Math.min(3, Math.round(aspect / 5)));
  if (n === 1) return [{ ...box, y, h }];
  const overlap = box.w * 0.02;
  const part = box.w / n;
  return Array.from({ length: n }, (_, i) => {
    const x = Math.max(0, box.x + i * part - (i ? overlap : 0));
    const w = Math.min(1 - x, part + (i ? overlap : 0) + (i < n - 1 ? overlap : 0));
    return { page: box.page, x, y, w, h };
  });
}

/** CSS that shows just `box` of a page image as a background. */
export function cropStyle(url: string, box: Box, pageW: number, pageH: number): Record<string, string> {
  const pos = (start: number, size: number) => (size >= 1 ? 0 : (start / (1 - size)) * 100);
  return {
    aspectRatio: `${(box.w * pageW) / (box.h * pageH)}`,
    backgroundImage: `url("${url}")`,
    backgroundSize: `${100 / box.w}% auto`,
    backgroundPosition: `${pos(box.x, box.w)}% ${pos(box.y, box.h)}%`,
    backgroundRepeat: "no-repeat",
  };
}
