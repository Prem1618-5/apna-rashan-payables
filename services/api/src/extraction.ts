/**
 * Extractor factory. EXTRACTOR=mock → deterministic fixture (tests, demo).
 * Otherwise the real router from @arad/extraction (`createExtractor(env)`), loaded with a dynamic
 * import because that package is optional for this service. If it can't be loaded, development
 * falls back to the mock; production fails extraction jobs instead of inventing data.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeLine, gstinCheckChar, type ExtractContext, type Extractor, type InvoiceLine, type MergedExtraction, type PageImage, type ProviderStatus } from "@arad/core";
import type { Config } from "./config.js";

interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

type ExtractionModule = { createExtractor(env: NodeJS.ProcessEnv): Extractor | Promise<Extractor> };

// ---------------------------------------------------------------- mock

export const MOCK_SELLER = {
  name: "Mock Distributors Ranchi Pvt Ltd",
  gstin: (() => {
    const first14 = "20AAACM4821K1Z";
    return first14 + gstinCheckChar(first14);
  })(),
};

const MOCK_ITEMS: { description: string; hsn: string; qty: number; unit: string; mrp: number; rate: number; discount: number; gstBp: number }[] = [
  { description: "Aashirvaad Atta 10kg", hsn: "1101", qty: 5, unit: "BAG", mrp: 48500, rate: 42000, discount: 0, gstBp: 500 },
  { description: "Tata Salt Iodised 1kg", hsn: "2501", qty: 20, unit: "PKT", mrp: 2800, rate: 2400, discount: 0, gstBp: 0 },
  { description: "Fortune Soyabean Oil 1L", hsn: "1507", qty: 12, unit: "PCS", mrp: 16500, rate: 13800, discount: 0, gstBp: 500 },
  { description: "Surf Excel Easy Wash 1kg", hsn: "3402", qty: 6, unit: "PKT", mrp: 14000, rate: 11500, discount: 2000, gstBp: 1800 },
  { description: "Parle-G Biscuit 800g", hsn: "1905", qty: 10, unit: "PKT", mrp: 10000, rate: 8000, discount: 0, gstBp: 500 },
];

/** Lines, totals and grand total of the mock invoice (identical for every page set). */
export function mockFixture() {
  const lines: Omit<InvoiceLine, "id">[] = MOCK_ITEMS.map((it, idx) => {
    const base = { qtyMilli: it.qty * 1000, ratePaise: it.rate, discountPaise: it.discount, gstRateBp: it.gstBp };
    return {
      idx,
      description: it.description,
      hsn: it.hsn,
      unit: it.unit,
      mrpPaise: it.mrp,
      ...base,
      ...computeLine(base),
      status: "pending",
      meta: { description: { confidence: 0.96 }, qtyMilli: { confidence: 0.95 }, ratePaise: { confidence: idx === 3 ? 0.78 : 0.94 }, totalPaise: { confidence: 0.97 } },
      box: { page: 0, x: 0.05, y: 0.32 + idx * 0.06, w: 0.9, h: 0.05 },
    };
  });
  const taxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
  const sum = lines.reduce((s, l) => s + l.totalPaise, 0);
  const roundOff = Math.round(sum / 100) * 100 - sum;
  const cgst = Math.floor(tax / 2);
  return {
    lines,
    totals: {
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: tax - cgst,
      igstPaise: 0,
      otherChargesPaise: 0,
      discountPaise: 0,
      roundOffPaise: roundOff,
      grandTotalPaise: sum + roundOff,
    },
  };
}

export function createMockExtractor(opts: { delayMs?: number } = {}): Extractor {
  return {
    async extract(pages: PageImage[], ctx: ExtractContext): Promise<MergedExtraction> {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const h = createHash("sha256");
      for (const p of pages) h.update(p.data);
      const digest = h.digest("hex").toUpperCase();
      const d = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
      const { lines, totals } = mockFixture();
      const buyer = ctx.storeGstins[0];
      return {
        header: {
          vendorName: MOCK_SELLER.name,
          sellerGstin: MOCK_SELLER.gstin,
          buyerGstin: buyer,
          invoiceNo: `MD/${d.slice(2, 4)}/${digest.slice(0, 6)}`,
          invoiceDate: d,
          docType: "INV",
        },
        headerMeta: {
          vendorName: { confidence: 0.98 },
          sellerGstin: { confidence: 0.99 },
          buyerGstin: { confidence: buyer ? 0.97 : 0 },
          invoiceNo: { confidence: 0.95 },
          invoiceDate: { confidence: 0.96 },
        },
        totals,
        totalsMeta: { grandTotalPaise: { confidence: 0.97 }, taxablePaise: { confidence: 0.95 } },
        lines,
        runs: [{ provider: "mock", model: "fixture-v1", ok: true, ms: opts.delayMs ?? 1 }],
      };
    },
    providers(): ProviderStatus[] {
      return [{ id: "mock", enabled: true, keys: 0, trainsOnInput: false, allowedForRealData: true, model: "fixture-v1" }];
    },
  };
}

/** Used in production when the real extractor can't be loaded: jobs fail loudly instead of inventing data. */
function unavailableExtractor(reason: string): Extractor {
  return {
    async extract() {
      throw new Error(`extraction unavailable: ${reason}`);
    },
    providers: () => [],
  };
}

// ---------------------------------------------------------------- factory

async function importExtractionModule(): Promise<ExtractionModule> {
  try {
    // The `as string` keeps TypeScript from requiring the (optional) package at compile time.
    return (await import("@arad/extraction" as string)) as ExtractionModule;
  } catch (first) {
    // Monorepo dev fallback: the package exists but is not linked as a dependency yet.
    const local = fileURLToPath(new URL("../../../packages/extraction/src/index.ts", import.meta.url));
    if (existsSync(local)) return (await import(pathToFileURL(local).href)) as ExtractionModule;
    throw first;
  }
}

export async function createExtractorFromEnv(config: Pick<Config, "EXTRACTOR" | "isProd">, env: NodeJS.ProcessEnv, log: Log): Promise<Extractor> {
  if (config.EXTRACTOR === "mock") {
    log.info({ extractor: "mock" }, "using mock extractor");
    return createMockExtractor();
  }
  try {
    const mod = await importExtractionModule();
    if (typeof mod.createExtractor !== "function") throw new Error("@arad/extraction does not export createExtractor");
    const extractor = await mod.createExtractor(env);
    log.info({ extractor: "auto", providers: extractor.providers().map((p) => ({ id: p.id, enabled: p.enabled, keys: p.keys })) }, "extractor ready");
    return extractor;
  } catch (e) {
    const reason = (e as Error).message;
    if (config.isProd) {
      log.error({ err: reason }, "could not load @arad/extraction; extraction jobs will fail");
      return unavailableExtractor(reason);
    }
    log.warn({ err: reason }, "could not load @arad/extraction; falling back to the mock extractor (development only)");
    return createMockExtractor();
  }
}
