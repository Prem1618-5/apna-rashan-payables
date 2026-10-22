import type { InvoiceLine, InvoiceTotals } from "@arad/core";
import { computeLine } from "@arad/core";
import { describe, expect, it } from "vitest";
import { cropStrips, cropStyle, decideSwipe, dwellMs, effectiveLines, lowFields, mathOff, meterState, pendingLines } from "../src/screens/verify/logic";

function line(idx: number, qty: number, rate: number, gst = 500, extra: Partial<InvoiceLine> = {}): InvoiceLine {
  const c = computeLine({ qtyMilli: qty * 1000, ratePaise: rate, discountPaise: 0, gstRateBp: gst });
  return { id: `l${idx}`, idx, description: `Item ${idx}`, qtyMilli: qty * 1000, ratePaise: rate, discountPaise: 0, gstRateBp: gst, status: "pending", ...c, ...extra };
}
const totals = (grand: number, roundOff = 0): InvoiceTotals => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, otherChargesPaise: 0, discountPaise: 0, roundOffPaise: roundOff, grandTotalPaise: grand });

describe("balance meter glue", () => {
  const lines = [line(0, 10, 10000), line(1, 2, 5000), line(2, 1, 1990)]; // 10500 + 10500 + 2090 (rounded)
  const sum = lines.reduce((s, l) => s + l.totalPaise, 0);
  const grand = Math.round(sum / 100) * 100;
  const inv = { totals: totals(grand, grand - sum), lockedTotalPaise: grand };

  it("starts at the locked total and reaches zero when every line is confirmed", () => {
    const m0 = meterState(inv, lines);
    expect(m0.remainingPaise).toBe(grand - (grand - sum));
    expect(m0.progress).toBeCloseTo(0, 2);
    expect(m0.balanced).toBe(false);
    const all = effectiveLines(lines, { l0: "accepted", l1: "accepted", l2: "edited" });
    const m = meterState(inv, all);
    expect(m.remainingPaise).toBe(0);
    expect(m.balanced).toBe(true);
    expect(m.progress).toBe(1);
    expect(m.hints).toEqual([]);
  });

  it("undo (local pending override) puts the line back and the money back on the meter", () => {
    const server = lines.map((l) => ({ ...l, status: "accepted" as const }));
    const local = effectiveLines(server, { l1: "pending" });
    expect(pendingLines(local).map((l) => l.id)).toEqual(["l1"]);
    expect(meterState(inv, local).remainingPaise).toBe(lines[1]!.totalPaise);
  });

  it("when lines are done but money is left, suggests a missing line of that amount", () => {
    const two = effectiveLines(lines.slice(0, 2), { l0: "accepted", l1: "accepted" });
    const m = meterState(inv, two);
    expect(m.stuck).toBe(true);
    expect(m.hints[0]).toEqual({ kind: "missing_line", amountPaise: m.remainingPaise });
  });

  it("over the total by exactly one line suggests a duplicate", () => {
    const dup = [...lines, { ...lines[2]!, id: "l3", idx: 3 }].map((l) => ({ ...l, status: "accepted" as const }));
    const m = meterState(inv, dup);
    expect(m.remainingPaise).toBe(-lines[2]!.totalPaise);
    expect(m.hints.some((h) => h.kind === "duplicate_line")).toBe(true);
  });

  it("removed lines do not count", () => {
    const m = meterState(inv, effectiveLines(lines, { l0: "accepted", l1: "accepted", l2: "removed" }));
    expect(m.totalCount).toBe(2);
    expect(m.pendingCount).toBe(0);
  });
});

describe("swipe and dwell", () => {
  it("decides by distance or by a quick flick in the same direction", () => {
    expect(decideSwipe(150, 0.1, 360)).toBe("accept");
    expect(decideSwipe(-150, -0.1, 360)).toBe("edit");
    expect(decideSwipe(60, 0.1, 360)).toBe("cancel");
    expect(decideSwipe(60, 0.9, 360)).toBe("accept");
    expect(decideSwipe(-60, 0.9, 360)).toBe("cancel"); // flick against the drag
    expect(decideSwipe(20, 2, 360)).toBe("cancel");
  });

  it("dwell is at least 600 ms and longer for doubtful lines", () => {
    const plain = line(0, 1, 100);
    const doubtful = { ...plain, meta: { qtyMilli: { confidence: 0.5, flagged: true }, ratePaise: { confidence: 0.7 } } };
    expect(dwellMs(plain)).toBeGreaterThanOrEqual(600);
    expect(dwellMs(doubtful)).toBeGreaterThan(dwellMs(plain) + 800);
    expect(lowFields(doubtful).sort()).toEqual(["qtyMilli", "ratePaise"]);
    expect(lowFields({ meta: { hsn: { confidence: 0.95 } } })).toEqual([]);
  });

  it("flags a line whose printed amount disagrees with its maths", () => {
    const l = line(0, 12, 15800);
    expect(mathOff(l)).toBe(0);
    expect(mathOff({ ...l, qtyMilli: 72000 })).not.toBe(0);
  });
});

describe("line crops", () => {
  it("splits a wide line into readable strips that cover it, and maps them to CSS", () => {
    const box = { page: 0, x: 0.03, y: 0.3, w: 0.94, h: 0.035 };
    const strips = cropStrips(box, 1000, 1414);
    expect(strips.length).toBe(3);
    expect(strips[0]!.x).toBeCloseTo(0.03);
    const last = strips[strips.length - 1]!;
    expect(last.x + last.w).toBeCloseTo(0.97, 2);
    const css = cropStyle("u.svg", strips[0]!, 1000, 1414);
    expect(css.backgroundSize).toMatch(/%/);
    expect(Number(css.aspectRatio)).toBeGreaterThan(3);
    expect(cropStrips({ page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, 1000, 1000)).toHaveLength(1);
  });
});
