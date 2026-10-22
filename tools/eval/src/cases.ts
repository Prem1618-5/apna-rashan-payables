/**
 * Loading evaluation cases from a folder.
 *
 * Layouts understood:
 *  1. Synthetic output: `<id>.json` truth files with a `pages` list (tools/synth-invoices).
 *  2. Real invoices, one folder per invoice: `<name>/page-1.jpg, page-2.jpg …` + optional `<name>/truth.json`.
 *  3. Real invoices, flat: `<name>.jpg` (or .png/.webp/.pdf) + optional `<name>.json` / `<name>.truth.json`.
 * Truth files only need `expected: { header, totals, lines }` (paise form); everything else is optional.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { InvoiceHeader, InvoiceLine, InvoiceTotals, PageImage, RawExtraction } from "@arad/core";

export interface Expected {
  header: InvoiceHeader;
  totals: InvoiceTotals;
  lines: Omit<InvoiceLine, "id" | "meta" | "box">[];
}

export interface TruthFile {
  id?: string;
  layout?: string;
  dataClass?: "synthetic" | "real";
  generatedOn?: string;
  pages?: string[];
  distortions?: string[];
  raw?: RawExtraction;
  expected?: Expected;
  qr?: { raw: string };
  printedRates?: number[];
  notes?: string[];
}

export interface EvalCase {
  id: string;
  pages: PageImage[];
  pagePaths: string[];
  truth?: TruthFile;
  /** Where a truth draft would be written for a real invoice without truth. */
  truthPath: string;
  dataClass: "synthetic" | "real";
}

const MIME: Record<string, PageImage["mime"]> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf" };
const isPage = (f: string) => extname(f).toLowerCase() in MIME;
const load = (p: string): PageImage => ({ mime: MIME[extname(p).toLowerCase()]!, data: new Uint8Array(readFileSync(p)) });
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function readTruth(p: string): TruthFile | undefined {
  if (!existsSync(p)) return undefined;
  const t = JSON.parse(readFileSync(p, "utf8")) as TruthFile;
  return t;
}

export function loadCases(dir: string, opts: { real?: boolean } = {}): EvalCase[] {
  const entries = readdirSync(dir).sort(byNumber);
  const cases: EvalCase[] = [];
  const used = new Set<string>();

  // 1. Synthetic truth files that list their pages.
  for (const f of entries.filter((e) => e.endsWith(".json") && !e.endsWith(".draft.json"))) {
    const t = readTruth(join(dir, f));
    if (!t?.pages?.length) continue;
    const paths = t.pages.map((p) => join(dir, p));
    if (!paths.every((p) => existsSync(p))) continue;
    t.pages.forEach((p) => used.add(p));
    used.add(f);
    cases.push({ id: t.id ?? basename(f, ".json"), pages: paths.map(load), pagePaths: paths, truth: t, truthPath: join(dir, f), dataClass: opts.real ? "real" : (t.dataClass ?? "synthetic") });
  }

  // 2. One folder per invoice.
  for (const e of entries) {
    const p = join(dir, e);
    if (!statSync(p).isDirectory() || e.startsWith(".")) continue;
    const files = readdirSync(p).filter(isPage).sort(byNumber);
    if (!files.length) continue;
    const truthPath = join(p, "truth.json");
    cases.push({ id: e, pages: files.map((f) => load(join(p, f))), pagePaths: files.map((f) => join(p, f)), truth: readTruth(truthPath), truthPath, dataClass: opts.real === false ? "synthetic" : "real" });
  }

  // 3. Flat images not claimed by a synthetic truth file.
  for (const f of entries.filter((e) => isPage(e) && !used.has(e))) {
    const stem = basename(f, extname(f));
    const truthPath = [join(dir, `${stem}.truth.json`), join(dir, `${stem}.json`)].find((x) => existsSync(x)) ?? join(dir, `${stem}.truth.json`);
    cases.push({ id: stem, pages: [load(join(dir, f))], pagePaths: [join(dir, f)], truth: readTruth(truthPath), truthPath, dataClass: opts.real === false ? "synthetic" : "real" });
  }
  return cases;
}
