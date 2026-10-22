import { describe, expect, it } from "vitest";
import { checkAccountNumber, cleanText, formatDate, formatPaise, isValidIfsc, packIntoLines } from "../src/index.js";

describe("formatPaise", () => {
  it("formats integer paise with two decimals and no separators", () => {
    expect(formatPaise(0)).toBe("0.00");
    expect(formatPaise(5)).toBe("0.05");
    expect(formatPaise(1234505)).toBe("12345.05");
    expect(formatPaise(2_00_000_00)).toBe("200000.00");
  });
  it("refuses floats and negatives", () => {
    expect(() => formatPaise(10.5)).toThrow();
    expect(() => formatPaise(-1)).toThrow();
  });
});

describe("formatDate", () => {
  it("writes DD/MM/YYYY", () => expect(formatDate("2026-01-05")).toBe("05/01/2026"));
  it("refuses impossible dates", () => {
    expect(() => formatDate("2026-02-29")).toThrow();
    expect(() => formatDate("23/10/2026")).toThrow();
  });
});

describe("cleanText", () => {
  it("keeps only safe characters", () => {
    expect(cleanText("M/s Ram & Sons, Ranchi")).toBe("M/s Ram Sons Ranchi");
    expect(cleanText("Café  Dairy\n")).toBe("Cafe Dairy");
  });
});

describe("bank detail checks", () => {
  it("validates IFSC", () => {
    expect(isValidIfsc("HDFC0000060")).toBe(true);
    expect(isValidIfsc("HDFC1000060")).toBe(false);
    expect(isValidIfsc("hdfc0000060")).toBe(false);
  });
  it("flags unusual account numbers", () => {
    expect(checkAccountNumber("50200012345678")).toEqual({ ok: true, unusual: false });
    expect(checkAccountNumber("AB1234567")).toEqual({ ok: true, unusual: true });
    expect(checkAccountNumber("12-34")).toEqual({ ok: false, unusual: false });
  });
});

describe("packIntoLines", () => {
  it("packs bill numbers into 30-character lines", () => {
    expect(packIntoLines("BILLS", ["INV-001", "INV-002", "INV-003", "INV-004"], 7, 30)).toEqual([
      "BILLS INV-001 INV-002 INV-003",
      "INV-004",
    ]);
  });
  it("notes how many did not fit without cutting a bill number", () => {
    const tokens = Array.from({ length: 40 }, (_, i) => `INV-${String(i).padStart(4, "0")}`);
    const lines = packIntoLines("BILLS", tokens, 7, 30);
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    const last = lines[6]!;
    expect(last).toMatch(/\+\d+ MORE$/);
    const shown = lines.join(" ").split(" ").filter((t) => t.startsWith("INV-")).length;
    expect(Number(/\+(\d+) MORE/.exec(last)![1])).toBe(40 - shown);
  });
});
