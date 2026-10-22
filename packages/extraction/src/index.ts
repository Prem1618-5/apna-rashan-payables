/**
 * @arad/extraction — turns invoice photos into a merged, paise-normalised draft (MergedExtraction).
 *
 *   const extractor = createExtractor(process.env);
 *   const draft = await extractor.extract(pages, { dataClass: "synthetic", storeGstins });
 */

import type { ExtractContext, Extractor, MergedExtraction, PageImage, ProviderStatus } from "@arad/core";
import { CircuitBreaker } from "./breaker.js";
import { GeminiProvider } from "./gemini/provider.js";
import { KeyPool, readKeys } from "./keypool.js";
import { DEMO_RAW, MockProvider } from "./mock.js";
import { extractWithProviders, type ExtractionOutcome, type RouterOptions } from "./router.js";
import { TextractProvider } from "./textract.js";
import { jsonLogger, type ExtractContextExt, type Logger, type Provider } from "./types.js";

export * from "./types.js";
export * from "./normalise.js";
export * from "./convert.js";
export * from "./merge.js";
export * from "./similarity.js";
export * from "./json.js";
export * from "./keypool.js";
export * from "./breaker.js";
export * from "./router.js";
export * from "./mock.js";
export * from "./textract.js";
export * from "./gemini/provider.js";
export { SYSTEM_PROMPT, RESPONSE_SCHEMA, EXTRACTION_PROMPT_VERSION } from "./gemini/prompt.js";

export type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface CreateExtractorOptions {
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  /** Replace the provider list (tests). */
  providers?: Provider[];
}

/** Build the configured providers from env, in priority order. */
export function providersFromEnv(env: Env, opts: CreateExtractorOptions = {}): Provider[] {
  const log = opts.logger ?? jsonLogger(env.LOG_LEVEL ?? "info");
  if ((env.EXTRACTOR ?? "auto") === "mock") {
    return [new MockProvider(DEMO_RAW, { id: "mock-a", vendor: "mock-a" }), new MockProvider(DEMO_RAW, { id: "mock-b", vendor: "mock-b" })];
  }
  const out: Provider[] = [];
  const timeoutMs = Number(env.GEMINI_TIMEOUT_MS ?? 60_000) || 60_000;
  const keys = readKeys(env, "GEMINI_API_KEY");
  const tier = env.GEMINI_TIER ?? "free";
  const primary = env.GEMINI_MODEL || "gemini-flash-latest";
  const second = env.GEMINI_SECOND_MODEL || "gemini-pro-latest";
  if (env.TEXTRACT_ENABLED === "true") out.push(new TextractProvider({ enabled: true, region: env.AWS_REGION || "ap-south-1", logger: log }));
  // Each model gets its own pool (quotas are per model), both built from the same keys.
  out.push(new GeminiProvider({ model: primary, pool: new KeyPool(keys, opts.now), tier, fetch: opts.fetch, timeoutMs, logger: log }));
  if (second && second !== primary) out.push(new GeminiProvider({ model: second, pool: new KeyPool(keys, opts.now), tier, fetch: opts.fetch, timeoutMs, logger: log }));
  // With Textract on, the readers are Textract + Gemini primary (different vendors); Gemini second is the fallback.
  return out;
}

function status(p: Provider, allowTraining: boolean): ProviderStatus {
  const s: ProviderStatus = {
    id: p.id,
    enabled: p.available(),
    keys: p.keyCount?.() ?? 0,
    trainsOnInput: p.info.trainsOnInput,
    allowedForRealData: !p.info.trainsOnInput || allowTraining,
  };
  if (p.info.model) s.model = p.info.model;
  return s;
}

/** Strip evaluation-only fields so the result is exactly MergedExtraction (safe to store / send). */
export function toMergedExtraction(o: MergedExtraction): MergedExtraction {
  return { header: o.header, headerMeta: o.headerMeta, totals: o.totals, totalsMeta: o.totalsMeta, lines: o.lines, runs: o.runs };
}

export interface DetailedExtractor extends Extractor {
  /** Same as extract, plus per-reader drafts and notes (evaluation, debugging). */
  extractDetailed(pages: PageImage[], ctx: ExtractContextExt): Promise<ExtractionOutcome>;
}

export function createExtractor(env: Env, opts: CreateExtractorOptions = {}): DetailedExtractor {
  const providers = opts.providers ?? providersFromEnv(env, opts);
  const allowTraining = env.AI_ALLOW_TRAINING_PROVIDERS_FOR_REAL_DATA === "true";
  const breakers = new Map<string, CircuitBreaker>();
  const logger = opts.logger ?? jsonLogger(env.LOG_LEVEL ?? "info");
  const routerOpts = (): RouterOptions => ({ allowTrainingForReal: allowTraining, breakers, logger, now: opts.now });
  return {
    async extract(pages: PageImage[], ctx: ExtractContext): Promise<MergedExtraction> {
      return toMergedExtraction(await extractWithProviders(pages, ctx as ExtractContextExt, providers, routerOpts()));
    },
    extractDetailed(pages: PageImage[], ctx: ExtractContextExt) {
      return extractWithProviders(pages, ctx, providers, routerOpts());
    },
    providers(): ProviderStatus[] {
      return providers.map((p) => status(p, allowTraining));
    },
  };
}
