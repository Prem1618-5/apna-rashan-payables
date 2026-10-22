/**
 * Router (docs/design/ai-providers.md §5): filter providers by availability, data policy and circuit
 * breaker; pick two readers (different vendors preferred); run them in parallel; if one fails, try the
 * next candidate; merge. Never throws for business reasons: with no usable reader it returns an empty
 * draft whose `runs` explain why, so a person can still enter the bill.
 */

import { classifyQr, type EInvoiceQr, type MergedExtraction, type PageImage, type ProviderRun } from "@arad/core";
import { CircuitBreaker, DEFAULT_BREAKER, type BreakerConfig } from "./breaker.js";
import { toDraft, type ReaderDraft } from "./convert.js";
import { mergeDrafts, type MergeOptions } from "./merge.js";
import { ProviderError, silentLogger, type ExtractContextExt, type Logger, type Provider } from "./types.js";

export interface RouterOptions {
  /** Allow real invoices to go to providers whose terms allow training on input (owner setting, audit-logged elsewhere). */
  allowTrainingForReal?: boolean;
  /** Readers per invoice (default 2). */
  readers?: number;
  /** Circuit breakers by provider id; shared across calls by createExtractor. */
  breakers?: Map<string, CircuitBreaker>;
  breakerConfig?: BreakerConfig;
  logger?: Logger;
  now?: () => number;
  /** Overall abort (e.g. worker shutdown). */
  signal?: AbortSignal;
  checkConfig?: MergeOptions["checkConfig"];
}

export interface ExtractionOutcome extends MergedExtraction {
  /** The per-reader drafts (normalised, in paise) before merging; for evaluation. */
  drafts: ReaderDraft[];
  /** Were the two readers from different vendors? */
  independent: boolean;
  notes: string[];
}

export function blockedReason(p: Provider, ctx: ExtractContextExt, opts: RouterOptions): string | undefined {
  if (!p.available()) return "not configured";
  if (ctx.dataClass === "real" && p.info.trainsOnInput && !opts.allowTrainingForReal) return "blocked: provider terms allow training on input; real invoices are not sent to it";
  return undefined;
}

/** Pick readers in priority order, preferring a different vendor for the second one. */
export function pickReaders(candidates: Provider[], n = 2): { chosen: Provider[]; rest: Provider[] } {
  const chosen: Provider[] = [];
  const pool = [...candidates];
  while (chosen.length < n && pool.length) {
    const vendors = new Set(chosen.map((p) => p.vendor));
    let i = pool.findIndex((p) => !vendors.has(p.vendor));
    if (i < 0) i = 0;
    chosen.push(pool.splice(i, 1)[0]!);
  }
  return { chosen, rest: pool };
}

function resolveQr(ctx: ExtractContextExt): EInvoiceQr | undefined {
  if (ctx.qr) return ctx.qr;
  for (const raw of ctx.qrRaw ?? []) {
    const c = classifyQr(raw);
    if (c.kind === "einvoice") return c.data;
  }
  return undefined;
}

function breakerFor(opts: RouterOptions, id: string): CircuitBreaker {
  const map = (opts.breakers ??= new Map());
  let b = map.get(id);
  if (!b) {
    b = new CircuitBreaker(opts.breakerConfig ?? DEFAULT_BREAKER, opts.now);
    map.set(id, b);
  }
  return b;
}

async function runOne(p: Provider, pages: PageImage[], opts: RouterOptions, log: Logger, invoiceId?: string): Promise<{ run: ProviderRun; draft?: ReaderDraft; notes: string[] }> {
  const t0 = Date.now();
  const breaker = breakerFor(opts, p.id);
  try {
    const res = await p.extract(pages, opts.signal);
    breaker.success();
    const draft = toDraft(p.id, p.vendor, res.raw);
    const run: ProviderRun = { provider: p.id, model: res.model, ok: true, ms: Date.now() - t0, raw: res.raw };
    if (res.keySlot !== undefined) run.keySlot = res.keySlot;
    log.info("reader done", { provider: p.id, model: res.model, keySlot: res.keySlot, ms: run.ms, lines: res.raw.lines?.length ?? 0, invoiceId });
    return { run, draft, notes: [...(res.notes ?? []).map((n) => `${p.id}: ${n}`), ...draft.notes.map((n) => `${p.id}: ${n}`)] };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e), "other");
    // Our own abort is not the provider's fault; an unknown model (404) will not fix itself.
    if (err.kind === "config" && err.status === 404) breaker.trip();
    else if (err.kind !== "aborted" && err.kind !== "config") breaker.failure();
    log.warn("reader failed", { provider: p.id, kind: err.kind, status: err.status, ms: Date.now() - t0, invoiceId });
    return { run: { provider: p.id, model: p.info.model, ok: false, ms: Date.now() - t0, error: `${err.kind}: ${err.message}` }, notes: [] };
  }
}

/** Run the readers and merge. Exposed for tests and the evaluation harness. */
export async function extractWithProviders(pages: PageImage[], ctx: ExtractContextExt, providers: Provider[], opts: RouterOptions = {}): Promise<ExtractionOutcome> {
  const log = opts.logger ?? silentLogger;
  const runs: ProviderRun[] = [];
  const notes: string[] = [];
  const candidates: Provider[] = [];
  for (const p of providers) {
    const why = blockedReason(p, ctx, opts);
    if (why) {
      if (why !== "not configured") runs.push({ provider: p.id, model: p.info.model, ok: false, ms: 0, error: why });
      continue;
    }
    const b = breakerFor(opts, p.id);
    if (!b.allow()) {
      runs.push({ provider: p.id, model: p.info.model, ok: false, ms: 0, error: `circuit open after repeated failures (retry in ${Math.ceil(b.retryInMs() / 1000)}s)` });
      continue;
    }
    candidates.push(p);
  }
  const qr = resolveQr(ctx);
  const want = opts.readers ?? 2;
  const { chosen, rest } = pickReaders(candidates, want);

  const drafts: ReaderDraft[] = [];
  const used: Provider[] = [];
  if (!pages.length) {
    runs.push({ provider: "router", ok: false, ms: 0, error: "no pages to read" });
  } else if (!chosen.length) {
    runs.push({ provider: "router", ok: false, ms: 0, error: providers.length ? "no extraction provider is usable (see other runs); enter the bill by hand" : "no extraction provider configured; enter the bill by hand" });
  } else {
    const first = await Promise.all(chosen.map((p) => runOne(p, pages, opts, log, ctx.invoiceId)));
    first.forEach((r, i) => {
      runs.push(r.run);
      notes.push(...r.notes);
      if (r.draft) {
        drafts.push(r.draft);
        used.push(chosen[i]!);
      }
    });
    // Fall back to the next candidates, one at a time, until we have enough readers.
    const queue = [...rest];
    while (drafts.length < want && queue.length) {
      const vendors = new Set(used.map((p) => p.vendor));
      let i = queue.findIndex((p) => !vendors.has(p.vendor));
      if (i < 0) i = 0;
      const p = queue.splice(i, 1)[0]!;
      const r = await runOne(p, pages, opts, log, ctx.invoiceId);
      runs.push(r.run);
      notes.push(...r.notes);
      if (r.draft) {
        drafts.push(r.draft);
        used.push(p);
      }
    }
  }
  const independent = used.length >= 2 && used[0]!.vendor !== used[1]!.vendor;
  if (used.length >= 2 && !independent) notes.push(`readers ${used[0]!.id} and ${used[1]!.id} are from the same vendor: agreement is weaker evidence`);
  if (used.length === 1) notes.push("only one reader succeeded: nothing to cross-check against");

  const merged = mergeDrafts(drafts, { qr, storeGstins: ctx.storeGstins, independent, checkConfig: opts.checkConfig });
  return { ...merged, runs, drafts, independent, notes };
}
