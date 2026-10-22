/** Runs the extractor over evaluation cases and scores raw readers, merged, and merged-with-flags. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChecks, type InvoiceLine, type MergedExtraction, type ProviderRun, type RawExtraction } from "@arad/core";
import { CircuitBreaker, MockProvider, extractWithProviders, mergeDrafts, providersFromEnv, silentLogger, type ExtractionOutcome, type Provider } from "@arad/extraction";
import type { EvalCase } from "./cases.js";
import { scoreDraft, type FieldResult } from "./score.js";
import { simProviders, type SimRates } from "./sim.js";

export type Mode = "sim" | "live" | "replay";

export interface RunOptions {
  mode: Mode;
  env: Record<string, string | undefined>;
  /** Folder for raw provider outputs (written in live mode, read in replay mode). */
  cacheDir?: string;
  /** Give the e-invoice QR (as the phone would decode it) to the extractor. */
  useQr: boolean;
  /** Wait between live invoices (free tiers have per-minute limits). */
  paceMs?: number;
  simRates?: SimRates;
  storeGstins?: string[];
  log?: (m: string) => void;
}

export interface CaseResult {
  id: string;
  layout?: string;
  distortions?: string[];
  pages: number;
  hasTruth: boolean;
  merged: FieldResult[];
  readers: { provider: string; results: FieldResult[] }[];
  runs: ProviderRun[];
  independent: boolean;
  notes: string[];
  failedChecks: string[];
  flaggedFields: number;
  totalFields: number;
  outcome: MergedExtraction;
}

const vendorOf = (id: string) => (id.startsWith("gemini") ? "google" : id.startsWith("textract") ? "aws" : id);
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

function replayProviders(cacheDir: string, id: string): Provider[] {
  if (!existsSync(cacheDir)) return [];
  const prefix = `${safe(id)}.`;
  return readdirSync(cacheDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .map((f) => {
      const rec = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as { provider: string; raw: RawExtraction };
      return new MockProvider(rec.raw, { id: rec.provider, vendor: vendorOf(rec.provider) });
    });
}

function countFlags(m: MergedExtraction): { flagged: number; total: number } {
  const metas = [...Object.values(m.headerMeta), ...Object.values(m.totalsMeta), ...m.lines.flatMap((l) => Object.values(l.meta ?? {}))];
  return { flagged: metas.filter((x) => x && (x.flagged || x.confidence < 0.8)).length, total: metas.length };
}

export async function runEval(cases: EvalCase[], opts: RunOptions): Promise<CaseResult[]> {
  const breakers = new Map<string, CircuitBreaker>();
  const liveProviders = opts.mode === "live" ? providersFromEnv(opts.env, { logger: silentLogger }) : [];
  if (opts.mode === "live" && opts.cacheDir) mkdirSync(opts.cacheDir, { recursive: true });
  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const today = c.truth?.generatedOn ?? new Date().toISOString().slice(0, 10);
    let providers: Provider[];
    if (opts.mode === "sim") {
      if (!c.truth?.raw) {
        opts.log?.(`${c.id}: skipped (simulation needs truth.raw)`);
        continue;
      }
      providers = simProviders(c.truth, c.id, opts.simRates);
    } else if (opts.mode === "replay") providers = replayProviders(opts.cacheDir ?? "", c.id);
    else providers = liveProviders;

    const storeGstins = opts.storeGstins?.length ? opts.storeGstins : c.truth?.expected?.header.buyerGstin ? [c.truth.expected.header.buyerGstin] : [];
    const qrRaw = opts.useQr && c.truth?.qr?.raw ? [c.truth.qr.raw] : undefined;
    const t0 = Date.now();
    const out: ExtractionOutcome = await extractWithProviders(c.pages, { dataClass: c.dataClass, storeGstins, invoiceId: c.id, qrRaw }, providers, {
      breakers,
      logger: silentLogger,
      allowTrainingForReal: opts.env.AI_ALLOW_TRAINING_PROVIDERS_FOR_REAL_DATA === "true",
      checkConfig: { today },
    });
    if (opts.mode === "live" && opts.cacheDir) {
      for (const r of out.runs) if (r.ok && r.raw) writeFileSync(join(opts.cacheDir, `${safe(c.id)}.${safe(r.provider)}.json`), `${JSON.stringify({ provider: r.provider, model: r.model, ms: r.ms, raw: r.raw }, null, 2)}\n`);
    }
    const exp = c.truth?.expected;
    const merged = exp ? scoreDraft(c.id, out, exp, true) : [];
    const readers = exp
      ? out.drafts.map((d) => ({ provider: d.provider, results: scoreDraft(c.id, mergeDrafts([d], { checkConfig: { today } }), exp, false) }))
      : [];
    const lines = out.lines.map((l) => ({ ...l, id: `l${l.idx}` }) as InvoiceLine);
    const failedChecks = runChecks({ header: out.header, totals: out.totals, lines }, { today, storeGstins }).filter((x) => x.status === "fail").map((x) => x.id);
    const { flagged, total } = countFlags(out);
    results.push({ id: c.id, layout: c.truth?.layout, distortions: c.truth?.distortions, pages: c.pages.length, hasTruth: !!exp, merged, readers, runs: out.runs.map(({ raw: _raw, ...r }) => r), independent: out.independent, notes: out.notes, failedChecks, flaggedFields: flagged, totalFields: total, outcome: out });
    const wrong = merged.filter((r) => !r.ok);
    opts.log?.(`${c.id}: ${out.runs.map((r) => `${r.provider}${r.ok ? "" : " FAILED"}`).join(" + ")} | ${exp ? `${merged.length - wrong.length}/${merged.length} fields right, ${wrong.filter((r) => !r.caught).length} silent` : "no truth"} | ${Date.now() - t0} ms`);
    if (opts.mode === "live" && opts.paceMs && i < cases.length - 1) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  return results;
}

/** For real invoices without truth: write the merged draft as a truth file to correct by hand. */
export function writeTruthDraft(c: EvalCase, r: CaseResult) {
  const o = r.outcome;
  const draft = {
    id: c.id,
    dataClass: c.dataClass,
    note: "DRAFT made by the extractor. Correct every value against the paper invoice, then save as truth.json / <name>.truth.json.",
    expected: {
      header: o.header,
      totals: o.totals,
      lines: o.lines.map(({ meta: _m, box: _b, ...l }) => l),
    },
  };
  const p = c.truthPath.replace(/\.json$/, "") + ".draft.json";
  writeFileSync(p, `${JSON.stringify(draft, null, 2)}\n`);
  return p;
}
