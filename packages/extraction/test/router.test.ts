import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEMO_RAW, MockProvider, ProviderError, createExtractor, extractWithProviders, pickReaders, type ExtractContextExt } from "../src/index.js";
import { STD_LINES, TODAY, clone, invoice, silent } from "./router-helpers.js";

const PAGE = { mime: "image/png" as const, data: new Uint8Array([1, 2, 3]) };
const synthetic: ExtractContextExt = { dataClass: "synthetic", storeGstins: [] };
const real: ExtractContextExt = { dataClass: "real", storeGstins: [] };
const base = { logger: silent, checkConfig: { today: TODAY } };

describe("router: data policy", () => {
  it("real invoices never go to providers that may train on input", async () => {
    const free = new MockProvider(invoice(STD_LINES()), { id: "gemini:free", vendor: "google", trainsOnInput: true });
    const out = await extractWithProviders([PAGE], real, [free], base);
    expect(free.calls).toBe(0);
    expect(out.lines).toEqual([]);
    expect(out.header).toEqual({});
    expect(out.runs.find((r) => r.provider === "gemini:free")!.error).toMatch(/training/);
    expect(out.runs.find((r) => r.provider === "router")!.error).toMatch(/enter the bill by hand/);
  });

  it("the owner switch allows it", async () => {
    const free = new MockProvider(invoice(STD_LINES()), { id: "gemini:free", vendor: "google", trainsOnInput: true });
    const out = await extractWithProviders([PAGE], real, [free], { ...base, allowTrainingForReal: true });
    expect(free.calls).toBe(1);
    expect(out.lines).toHaveLength(4);
  });

  it("synthetic data may use training providers; non-training providers serve real data", async () => {
    const free = new MockProvider(invoice(STD_LINES()), { id: "free", vendor: "google", trainsOnInput: true });
    const paid = new MockProvider(invoice(STD_LINES()), { id: "paid", vendor: "aws" });
    const s = await extractWithProviders([PAGE], synthetic, [free, paid], base);
    expect(s.runs.filter((r) => r.ok).map((r) => r.provider)).toEqual(["free", "paid"]);
    const r = await extractWithProviders([PAGE], real, [free, paid], base);
    expect(r.runs.filter((x) => x.ok).map((x) => x.provider)).toEqual(["paid"]);
    expect(r.notes.join(" ")).toMatch(/only one reader/);
  });
});

describe("router: reader choice and failover", () => {
  it("prefers two different vendors", () => {
    const a = new MockProvider(DEMO_RAW, { id: "g1", vendor: "google" });
    const b = new MockProvider(DEMO_RAW, { id: "g2", vendor: "google" });
    const c = new MockProvider(DEMO_RAW, { id: "t", vendor: "aws" });
    expect(pickReaders([a, b, c]).chosen.map((p) => p.id)).toEqual(["g1", "t"]);
    expect(pickReaders([a, b]).chosen.map((p) => p.id)).toEqual(["g1", "g2"]);
  });

  it("runs both readers in parallel and marks same-vendor pairs as not independent", async () => {
    const a = new MockProvider(invoice(STD_LINES()), { id: "g1", vendor: "google", delayMs: 30 });
    const b = new MockProvider(invoice(STD_LINES()), { id: "g2", vendor: "google", delayMs: 30 });
    const t0 = Date.now();
    const out = await extractWithProviders([PAGE], synthetic, [a, b], base);
    expect(Date.now() - t0).toBeLessThan(55);
    expect(out.independent).toBe(false);
    expect(out.headerMeta.invoiceNo!.confidence).toBeCloseTo(0.9);
  });

  it("a failing reader is replaced by the next candidate", async () => {
    const a = new MockProvider(invoice(STD_LINES()), { id: "a", vendor: "x", fail: new ProviderError("rate limited", "rate_limited", 429) });
    const b = new MockProvider(invoice(STD_LINES()), { id: "b", vendor: "y" });
    const c = new MockProvider(invoice(STD_LINES()), { id: "c", vendor: "z" });
    const out = await extractWithProviders([PAGE], synthetic, [a, b, c], base);
    expect(out.runs.map((r) => [r.provider, r.ok])).toEqual([["a", false], ["b", true], ["c", true]]);
    expect(out.runs[0]!.error).toMatch(/rate_limited/);
    expect(out.drafts).toHaveLength(2);
  });

  it("every reader failing -> empty draft with explanations, no throw", async () => {
    const a = new MockProvider(DEMO_RAW, { id: "a", fail: new ProviderError("boom", "server", 503) });
    const out = await extractWithProviders([PAGE], synthetic, [a], base);
    expect(out.lines).toEqual([]);
    expect(out.runs[0]).toMatchObject({ provider: "a", ok: false });
  });

  it("no pages / no providers -> empty draft", async () => {
    expect((await extractWithProviders([], synthetic, [new MockProvider(DEMO_RAW)], base)).runs[0]!.error).toMatch(/no pages/);
    expect((await extractWithProviders([PAGE], synthetic, [], base)).runs[0]!.error).toMatch(/no extraction provider configured/);
  });

  it("uses the e-invoice QR from raw QR strings", async () => {
    const raw = invoice(STD_LINES());
    const data = { SellerGstin: raw.header.sellerGstin, BuyerGstin: raw.header.buyerGstin, DocNo: raw.header.invoiceNo, DocTyp: "INV", DocDt: "20/10/2026", TotInvVal: raw.totals.grandTotal, ItemCnt: 4, MainHsnCode: "2501", Irn: "e".repeat(64), IrnDt: "2026-10-20 10:00:00" };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "RS256" })}.${b64({ data: JSON.stringify(data) })}.sig`;
    const out = await extractWithProviders([PAGE], { ...synthetic, qrRaw: ["upi://pay?pa=x@y", jwt] }, [new MockProvider(raw, { id: "a" }), new MockProvider(clone(raw), { id: "b" })], base);
    expect(out.header.irn).toBe("e".repeat(64));
    expect(out.headerMeta.invoiceNo!.confidence).toBeGreaterThanOrEqual(0.99);
  });
});

describe("circuit breaker", () => {
  it("opens after 5 failures in 60 s, stays open 5 min, then lets a trial through", () => {
    let t = 0;
    const b = new CircuitBreaker(undefined, () => t);
    for (let i = 0; i < 4; i++) b.failure();
    expect(b.state()).toBe("closed");
    b.failure();
    expect(b.state()).toBe("open");
    expect(b.allow()).toBe(false);
    t += 5 * 60_000;
    expect(b.state()).toBe("half-open");
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state()).toBe("open");
    t += 5 * 60_000;
    b.success();
    expect(b.state()).toBe("closed");
  });

  it("failures spread over more than 60 s do not open it", () => {
    let t = 0;
    const b = new CircuitBreaker(undefined, () => t);
    for (let i = 0; i < 10; i++) {
      b.failure();
      t += 20_000;
    }
    expect(b.state()).toBe("closed");
  });

  it("router skips a provider whose circuit is open", async () => {
    let t = 0;
    const failing = new MockProvider(DEMO_RAW, { id: "flaky", vendor: "x", fail: new ProviderError("down", "server", 500) });
    const good = new MockProvider(DEMO_RAW, { id: "good", vendor: "y" });
    const breakers = new Map<string, CircuitBreaker>();
    const o = { ...base, breakers, now: () => t };
    for (let i = 0; i < 5; i++) await extractWithProviders([PAGE], synthetic, [failing, good], o);
    expect(failing.calls).toBe(5);
    const out = await extractWithProviders([PAGE], synthetic, [failing, good], o);
    expect(failing.calls).toBe(5);
    expect(out.runs.find((r) => r.provider === "flaky")!.error).toMatch(/circuit open/);
    t += 5 * 60_000 + 1;
    await extractWithProviders([PAGE], synthetic, [failing, good], o);
    expect(failing.calls).toBe(6);
  });
});

describe("createExtractor", () => {
  it("builds Gemini readers from env; status shows key counts, never keys", () => {
    const ex = createExtractor({ GEMINI_API_KEY_1: "AIza-secret-1", GEMINI_API_KEY_2: "AIza-secret-2", GEMINI_TIER: "free" }, { logger: silent });
    const st = ex.providers();
    expect(st.map((s) => s.id)).toEqual(["gemini:gemini-flash-latest", "gemini:gemini-pro-latest"]);
    expect(st[0]).toMatchObject({ enabled: true, keys: 2, trainsOnInput: true, allowedForRealData: false, model: "gemini-flash-latest" });
    expect(JSON.stringify(st)).not.toMatch(/secret/);
  });

  it("paid tier is allowed for real data; Textract appears when enabled", () => {
    const ex = createExtractor({ GEMINI_API_KEY: "k", GEMINI_TIER: "paid", TEXTRACT_ENABLED: "true", GEMINI_MODEL: "gemini-2.5-flash", GEMINI_SECOND_MODEL: "gemini-2.5-pro" }, { logger: silent });
    const st = ex.providers();
    expect(st.map((s) => s.id)).toEqual(["textract", "gemini:gemini-2.5-flash", "gemini:gemini-2.5-pro"]);
    expect(st.every((s) => s.allowedForRealData)).toBe(true);
  });

  it("no keys -> providers disabled, extract returns an empty draft", async () => {
    const ex = createExtractor({}, { logger: silent });
    expect(ex.providers().every((s) => !s.enabled)).toBe(true);
    const out = await ex.extract([PAGE], synthetic);
    expect(out.lines).toEqual([]);
    expect(out.runs.at(-1)!.error).toMatch(/enter the bill by hand/);
    expect(Object.keys(out).sort()).toEqual(["header", "headerMeta", "lines", "runs", "totals", "totalsMeta"]);
  });

  it("EXTRACTOR=mock gives a deterministic, clean demo draft", async () => {
    const ex = createExtractor({ EXTRACTOR: "mock" }, { logger: silent });
    const a = await ex.extract([PAGE], { dataClass: "real", storeGstins: [] });
    const b = await ex.extract([PAGE], { dataClass: "real", storeGstins: [] });
    expect(a.lines).toHaveLength(2);
    expect(a.runs.map((r) => ({ ...r, ms: 0 }))).toEqual(b.runs.map((r) => ({ ...r, ms: 0 })));
    expect(a.totals.grandTotalPaise).toBe(308_000);
    // invoiceDate is fixed in the fixture and will age past 6 months; everything else must be clean.
    const flagged = [...Object.entries(a.headerMeta).filter(([k]) => k !== "invoiceDate").map(([, m]) => m), ...Object.values(a.totalsMeta)].filter((m) => m?.flagged);
    expect(flagged).toEqual([]);
  });

  it("Gemini end-to-end with a mocked fetch: two models, same keys, merged", async () => {
    const raw = invoice(STD_LINES());
    const text = JSON.stringify({ ...raw, confidence: { invoiceNo: 0.9 } });
    const fetchMock = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }), { status: 200 })) as unknown as typeof fetch;
    const ex = createExtractor({ GEMINI_API_KEY_1: "a", GEMINI_API_KEY_2: "b" }, { logger: silent, fetch: fetchMock });
    const out = await ex.extractDetailed([PAGE], synthetic);
    expect(out.runs.map((r) => [r.provider, r.ok, r.keySlot])).toEqual([["gemini:gemini-flash-latest", true, 1], ["gemini:gemini-pro-latest", true, 1]]);
    expect(out.independent).toBe(false);
    expect(out.lines).toHaveLength(4);
  });
});
