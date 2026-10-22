import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { hi } from "../src/i18n/hi";
import { translate } from "../src/i18n";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("i18n", () => {
  it("every English key exists in Hindi, with the same placeholders", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(hi[k], `missing hi: ${k}`).toBeTruthy();
      expect(placeholders(hi[k]), `placeholders differ: ${k}`).toEqual(placeholders(en[k]));
    }
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
  });

  it("Hindi strings are actually Hindi (Devanagari), apart from codes and names", () => {
    const latinOnly = (Object.keys(hi) as (keyof typeof hi)[]).filter((k) => !/[ऀ-ॿ]/.test(hi[k]));
    // Allowed to stay Latin: brand/bank/tax terms that staff read in English.
    const allowed = new Set(["line.hsn", "line.mrp", "line.gst", "vendor.pan", "bankForm.ifsc", "txn.N", "txn.R", "bill.igst", "bill.cgstSgst", "install.add", "chk.tax_split.fail"]);
    expect(latinOnly.filter((k) => !allowed.has(k))).toEqual([]);
  });

  it("every key used in the source exists in the dictionary", () => {
    const src = sourceFiles(join(__dirname, "../src"))
      .filter((f) => !f.includes("/i18n/") && !f.includes("/api/mock/"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const used = new Set([...src.matchAll(/\bt2?\(\s*"([a-zA-Z]+\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]!));
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(150);
  });

  it("fills placeholders and picks singular forms", () => {
    expect(translate("en", "home.lines", { n: 1 })).toBe("1 line");
    expect(translate("en", "home.lines", { n: 8 })).toBe("8 lines");
    expect(translate("hi", "home.lines", { n: 8 })).toBe("8 लाइन");
    expect(translate("en", "meter.lines", { done: 3, total: 8 })).toBe("3 of 8 lines");
  });
});
