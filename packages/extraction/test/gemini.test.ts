import { describe, expect, it, vi } from "vitest";
import { GeminiProvider, KeyPool, ProviderError, buildGeminiRequest, parseGeminiPayload, parseModelJson, readKeys, repairJson, retryDelayMs, type Logger } from "../src/index.js";
import { STD_LINES, invoice } from "./helpers.js";

const PAGE = { mime: "image/jpeg" as const, data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };
const KEYS = { GEMINI_API_KEY_1: "AIzaSyKEYONE-aaaaaaaaaaaaaaaaaaaaaaa", GEMINI_API_KEY_2: "AIzaSyKEYTWO-bbbbbbbbbbbbbbbbbbbbbbb", GEMINI_API_KEY_3: "AIzaSyKEYTHREE-ccccccccccccccccccccc" };

function payload() {
  const raw = invoice(STD_LINES());
  return {
    header: { ...raw.header, irn: null },
    lines: raw.lines.map((l) => ({ ...l, mrp: null, box: { page: 0, x: 0.1, y: 0.3, w: 0.8, h: 0.03 } })),
    amountIncludesTax: false,
    totals: { ...raw.totals, igst: null },
    confidence: { vendorName: 0.9, grandTotal: 0.97, taxable: 0.9 },
    notes: [],
  };
}

const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text }] }, finishReason: "STOP" }] }), { status: 200 });
const err = (status: number, body: unknown = { error: { code: status, message: "nope" } }) => new Response(JSON.stringify(body), { status });

function setup(responses: ((url: string, init: RequestInit) => Response | Promise<Response>)[], env: Record<string, string> = KEYS, extra: Partial<ConstructorParameters<typeof GeminiProvider>[0]> = {}) {
  let t = 1_000_000;
  const now = () => t;
  const calls: { url: string; key: string; body: Record<string, unknown> }[] = [];
  const logs: unknown[] = [];
  const logger: Logger = { info: (m, f) => logs.push([m, f]), warn: (m, f) => logs.push([m, f]), error: (m, f) => logs.push([m, f]) };
  let i = 0;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    calls.push({ url: String(url), key: headers["x-goog-api-key"]!, body: JSON.parse(String(init!.body)) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return r(String(url), init!);
  });
  const pool = new KeyPool(readKeys(env, "GEMINI_API_KEY"), now);
  const p = new GeminiProvider({ model: "gemini-flash-latest", pool, fetch: fetchMock as unknown as typeof fetch, logger, backoffMs: 0, ...extra });
  return { p, calls, logs, pool, advance: (ms: number) => (t += ms) };
}

describe("gemini request", () => {
  it("sends images inline, JSON schema, temperature 0, key in header not URL", async () => {
    const { p, calls } = setup([() => ok(JSON.stringify(payload()))]);
    const r = await p.extract([PAGE, PAGE]);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    expect(c.url).not.toMatch(/key=/);
    expect(c.key).toBe(KEYS.GEMINI_API_KEY_1);
    const gc = c.body.generationConfig as Record<string, unknown>;
    expect(gc.temperature).toBe(0);
    expect(gc.responseMimeType).toBe("application/json");
    expect(gc.responseSchema).toBeTruthy();
    const parts = (c.body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
    expect(parts.filter((x) => x.inlineData)).toHaveLength(2);
    expect((parts[1]!.inlineData as { data: string }).data).toBe(Buffer.from(PAGE.data).toString("base64"));
    expect(r.keySlot).toBe(1);
    expect(r.model).toBe("gemini-flash-latest");
    expect(r.raw.lines).toHaveLength(4);
    expect(r.raw.confidence!["totals.grandTotal"]).toBe(0.97);
    expect(r.raw.header.irn).toBeUndefined();
  });

  it("free tier trains on input; paid does not", () => {
    const pool = new KeyPool([]);
    expect(new GeminiProvider({ model: "m", pool, tier: "free" }).info.trainsOnInput).toBe(true);
    expect(new GeminiProvider({ model: "m", pool }).info.trainsOnInput).toBe(true);
    expect(new GeminiProvider({ model: "m", pool, tier: "paid" }).info.trainsOnInput).toBe(false);
  });

  it("buildGeminiRequest numbers pages from 0", () => {
    const req = buildGeminiRequest([PAGE]);
    expect(JSON.stringify(req.contents)).toMatch(/Image index 0/);
  });
});

describe("key pool", () => {
  it("reads GEMINI_API_KEY and _1.._9, skipping blanks and duplicates", () => {
    const keys = readKeys({ GEMINI_API_KEY: "k0", GEMINI_API_KEY_1: "k1", GEMINI_API_KEY_2: "", GEMINI_API_KEY_3: "k1", GEMINI_API_KEY_9: "k9" }, "GEMINI_API_KEY");
    expect(keys.map((k) => k.slot)).toEqual([0, 1, 9]);
  });

  it("round-robins the start slot", () => {
    const pool = new KeyPool(readKeys(KEYS, "GEMINI_API_KEY"));
    expect(pool.order().map((k) => k.slot)).toEqual([1, 2, 3]);
    expect(pool.order().map((k) => k.slot)).toEqual([2, 3, 1]);
    expect(pool.order().map((k) => k.slot)).toEqual([3, 1, 2]);
  });

  it("parses retryDelay", () => {
    expect(retryDelayMs({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] } })).toBe(37_000);
    expect(retryDelayMs({ error: {} })).toBeUndefined();
  });

  it("429 -> next key; the limited key cools down (retryDelay respected), then comes back", async () => {
    const body429 = { error: { code: 429, message: "quota", details: [{ retryDelay: "30s" }] } };
    const { p, calls, pool, advance } = setup([() => err(429, body429), () => ok(JSON.stringify(payload())), () => ok(JSON.stringify(payload())), () => ok(JSON.stringify(payload()))]);
    const r = await p.extract([PAGE]);
    expect(r.keySlot).toBe(2);
    expect(calls.map((c) => c.key)).toEqual([KEYS.GEMINI_API_KEY_1, KEYS.GEMINI_API_KEY_2]);
    expect(pool.isCooling(1)).toBe(true);
    // Next call starts at slot 2 (round robin) and never touches slot 1 while it cools.
    await p.extract([PAGE]);
    await p.extract([PAGE]);
    expect(calls.slice(2).map((c) => c.key)).toEqual([KEYS.GEMINI_API_KEY_2, KEYS.GEMINI_API_KEY_3]);
    advance(31_000);
    expect(pool.isCooling(1)).toBe(false);
  });

  it("429 without retryDelay cools for 60 s", async () => {
    const { p, pool, advance } = setup([() => err(429), () => ok(JSON.stringify(payload()))]);
    await p.extract([PAGE]);
    advance(59_000);
    expect(pool.isCooling(1)).toBe(true);
    advance(2_000);
    expect(pool.isCooling(1)).toBe(false);
  });

  it("429 with 'limit: 0' (model has no quota on this tier) cools the key for an hour", async () => {
    const body = { error: { code: 429, message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-pro", details: [{ retryDelay: "20s" }] } };
    const { p, pool, advance } = setup([() => err(429, body), () => ok(JSON.stringify(payload()))]);
    await p.extract([PAGE]);
    advance(30 * 60_000);
    expect(pool.isCooling(1)).toBe(true);
    advance(31 * 60_000);
    expect(pool.isCooling(1)).toBe(false);
  });

  it("403, 500, 503 and timeouts move on to the next key", async () => {
    const { p, calls } = setup([() => err(403), () => err(500), () => err(503)]);
    await expect(p.extract([PAGE])).rejects.toMatchObject({ kind: "server" });
    expect(calls.map((c) => c.key)).toEqual([KEYS.GEMINI_API_KEY_1, KEYS.GEMINI_API_KEY_2, KEYS.GEMINI_API_KEY_3]);

    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const t = setup([hang, () => ok(JSON.stringify(payload()))], KEYS, { timeoutMs: 20 });
    const r = await t.p.extract([PAGE]);
    expect(r.keySlot).toBe(2);
  });

  it("5xx is model-wide: one retry on another key, then give up (no burning every key)", async () => {
    const { p, calls } = setup([() => err(503), () => err(503), () => err(503)]);
    await expect(p.extract([PAGE])).rejects.toMatchObject({ kind: "server", status: 503 });
    expect(calls).toHaveLength(2);
  });

  it("all keys cooling -> rate_limited error without calling the API", async () => {
    const { p, calls } = setup([() => err(429), () => err(429), () => err(429)]);
    await expect(p.extract([PAGE])).rejects.toMatchObject({ kind: "rate_limited" });
    expect(calls).toHaveLength(3);
    await expect(p.extract([PAGE])).rejects.toThrow(/cooling down/);
    expect(calls).toHaveLength(3);
  });

  it("400 (bad request / unknown model) stops: another key would not help", async () => {
    const { p, calls } = setup([() => err(400, { error: { message: "Invalid JSON payload" } })]);
    await expect(p.extract([PAGE])).rejects.toMatchObject({ kind: "config" });
    expect(calls).toHaveLength(1);
  });

  it("400 'API key not valid' is treated as a bad key", async () => {
    const { p, pool } = setup([() => err(400, { error: { message: "API key not valid. Please pass a valid API key." } }), () => ok(JSON.stringify(payload()))]);
    const r = await p.extract([PAGE]);
    expect(r.keySlot).toBe(2);
    expect(pool.isCooling(1)).toBe(true);
  });

  it("never puts keys in logs or errors", async () => {
    const leaky = { error: { message: `API key ${KEYS.GEMINI_API_KEY_1} quota exceeded` } };
    const { p, logs } = setup([() => err(429, leaky), () => err(429, leaky), () => err(429, leaky)]);
    const e = await p.extract([PAGE]).catch((x: unknown) => x as ProviderError);
    const all = JSON.stringify(logs) + String((e as Error).message);
    for (const k of Object.values(KEYS)) expect(all).not.toContain(k);
    expect(JSON.stringify(logs)).toMatch(/keySlot/);
  });
});

describe("response parsing", () => {
  it("strict JSON parses without repair", () => {
    const r = parseModelJson('{"a":1}');
    expect(r).toEqual({ ok: true, value: { a: 1 }, repaired: false, truncated: false });
  });

  it("repairs fences, prose, trailing commas and NaN", () => {
    const r = parseModelJson('Here you go:\n```json\n{"a": [1, 2,], "b": NaN, "c": "x",}\n```');
    expect(r.ok && r.value).toEqual({ a: [1, 2], b: null, c: "x" });
  });

  it("truncated output drops the incomplete last value instead of keeping half a number", () => {
    const r = repairJson('{"lines":[{"d":"salt","amount":1333.5},{"d":"oil","amount":13');
    expect(JSON.parse(r.text)).toEqual({ lines: [{ d: "salt", amount: 1333.5 }, { d: "oil" }] });
    expect(r.truncated).toBe(true);
  });

  it("raw newlines inside strings are escaped", () => {
    const r = parseModelJson('{"d":"two\nlines"}');
    expect(r.ok && r.value).toEqual({ d: "two\nlines" });
  });

  it("maps payload to RawExtraction, nulls dropped, totals confidence keys prefixed", () => {
    const { raw, notes } = parseGeminiPayload({ ...payload(), notes: ["handwritten correction on line 2"] });
    expect(raw.header.irn).toBeUndefined();
    expect(raw.totals.igst).toBeUndefined();
    expect(raw.confidence).toMatchObject({ vendorName: 0.9, "totals.grandTotal": 0.97, "totals.taxable": 0.9 });
    expect((raw.lines[0] as unknown as Record<string, unknown>).mrp).toBeUndefined();
    expect(notes).toEqual(["handwritten correction on line 2"]);
  });

  it("locally repairable output is used without a second call", async () => {
    const text = `\`\`\`json\n${JSON.stringify(payload()).replace(/}$/, ",}")}\n\`\`\``;
    const { p, calls } = setup([() => ok(text)]);
    const r = await p.extract([PAGE]);
    expect(calls).toHaveLength(1);
    expect(r.notes!.join(" ")).toMatch(/repaired locally/);
  });

  it("unrepairable output -> one model repair request, then success", async () => {
    const { p, calls } = setup([() => ok('{"header": {"vendorName": "X"}, "lines": [ {"description": "a" "qty": 1}]}'), () => ok(JSON.stringify(payload()))]);
    const r = await p.extract([PAGE]);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.body)).toMatch(/meant to be JSON/);
    expect(r.raw.lines).toHaveLength(4);
    expect(r.notes!.join(" ")).toMatch(/repaired by a second request/);
  });

  it("still invalid after the repair request -> bad_response", async () => {
    const { p } = setup([() => ok('{"a": 1 "b": 2}'), () => ok('{"a": 1 "b": 2}')]);
    await expect(p.extract([PAGE])).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("blocked prompt and empty candidates are bad responses", async () => {
    const blocked = setup([() => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })]);
    await expect(blocked.p.extract([PAGE])).rejects.toThrow(/SAFETY/);
    const empty = setup([() => new Response(JSON.stringify({ candidates: [] }), { status: 200 })]);
    await expect(empty.p.extract([PAGE])).rejects.toMatchObject({ kind: "bad_response" });
  });
});
