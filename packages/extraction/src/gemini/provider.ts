/** Gemini vision reader over the REST API (no SDK). */

import type { PageImage, ProviderInfo, RawExtraction } from "@arad/core";
import { parseModelJson } from "../json.js";
import { KeyPool, retryDelayMs } from "../keypool.js";
import { ProviderError, silentLogger, type Logger, type Provider, type ProviderResult } from "../types.js";
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, TOTALS_KEYS } from "./prompt.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  model: string;
  pool: KeyPool;
  /** "paid" tiers do not train on input; anything else is treated as free (may train). */
  tier?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  logger?: Logger;
  baseUrl?: string;
  /** Cool-down after 429 when the error has no retryDelay. */
  rateLimitCoolMs?: number;
  /** Cool-down after 403 (key disabled / not allowed). */
  forbiddenCoolMs?: number;
  maxOutputTokens?: number;
}

/** Never let anything that looks like a Google API key into logs or errors. */
export const scrubKeys = (s: string) => s.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]");

function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

export function buildGeminiRequest(pages: PageImage[], maxOutputTokens = 32768) {
  const parts: Record<string, unknown>[] = [];
  pages.forEach((p, i) => {
    parts.push({ text: `Image index ${i} (page ${i + 1} of ${pages.length}):` });
    parts.push({ inlineData: { mimeType: p.mime, data: toBase64(p.data) } });
  });
  parts.push({ text: "Extract this invoice into JSON following the rules. Transcribe exactly; null for anything you cannot read." });
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens,
    },
  };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number };
}

/** Text of the first candidate (thought parts skipped) + why it stopped. */
export function responseText(body: GeminiResponse): { text: string; finishReason?: string } {
  if (body.promptFeedback?.blockReason) throw new ProviderError(`blocked by provider: ${body.promptFeedback.blockReason}`, "bad_response");
  const c = body.candidates?.[0];
  if (!c) throw new ProviderError("no candidates in response", "bad_response");
  const text = (c.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) throw new ProviderError(`empty response (finishReason ${c.finishReason ?? "?"})`, "bad_response");
  return { text, finishReason: c.finishReason };
}

const nn = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

/** Map the schema-shaped JSON to RawExtraction. Unknown/null values become undefined; nothing is invented. */
export function parseGeminiPayload(value: unknown): { raw: RawExtraction; notes: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError("response is not a JSON object", "bad_response");
  const v = value as Record<string, unknown>;
  const h = (v.header ?? {}) as Record<string, unknown>;
  const header: Record<string, unknown> = {};
  for (const k of ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "irn", "docType"]) {
    const x = nn(h[k]);
    if (x !== undefined && x !== "") header[k] = x;
  }
  const t = (v.totals ?? {}) as Record<string, unknown>;
  const totals: Record<string, unknown> = {};
  for (const k of TOTALS_KEYS) if (nn(t[k]) !== undefined) totals[k] = t[k];
  const lines = (Array.isArray(v.lines) ? v.lines : []).map((l) => {
    const o = { ...(l as Record<string, unknown>) };
    for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
    return o;
  });
  const conf: Record<string, number> = {};
  const c = (v.confidence ?? {}) as Record<string, unknown>;
  for (const [k, x] of Object.entries(c)) {
    if (typeof x !== "number") continue;
    conf[TOTALS_KEYS.includes(k) ? `totals.${k}` : k] = x;
  }
  const raw = { header, totals, lines, confidence: conf } as unknown as RawExtraction;
  if (typeof v.amountIncludesTax === "boolean") raw.amountIncludesTax = v.amountIncludesTax;
  const notes = Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === "string") : [];
  return { raw, notes };
}

export class GeminiProvider implements Provider {
  readonly id: string;
  readonly vendor = "google";
  readonly info: ProviderInfo;
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;

  constructor(private readonly opts: GeminiOptions) {
    this.id = `gemini:${opts.model}`;
    this.info = { id: this.id, trainsOnInput: opts.tier !== "paid", model: opts.model };
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = opts.logger ?? silentLogger;
  }

  available() {
    return this.opts.pool.size > 0;
  }

  keyCount() {
    return this.opts.pool.size;
  }

  private async call(key: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
    const ctrl = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const timer = setTimeout(() => ctrl.abort(new ProviderError(`timeout after ${timeoutMs} ms`, "timeout")), timeoutMs);
    const onAbort = () => ctrl.abort(new ProviderError("aborted by caller", "aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchFn(`${this.opts.baseUrl ?? GEMINI_BASE_URL}/models/${encodeURIComponent(this.opts.model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: { message: text.slice(0, 300) } };
      }
      return { status: res.status, json };
    } catch (e) {
      if (signal?.aborted) throw new ProviderError("aborted by caller", "aborted");
      if (ctrl.signal.aborted) throw new ProviderError(`timeout after ${timeoutMs} ms`, "timeout");
      throw new ProviderError(`network error: ${scrubKeys(e instanceof Error ? e.message : String(e))}`, "server");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** One request, failing over across keys. Returns the parsed JSON body of the first 200. */
  private async request(body: unknown, signal?: AbortSignal): Promise<{ json: GeminiResponse; slot: number }> {
    const keys = this.opts.pool.order();
    if (!keys.length) {
      const wait = Math.ceil(this.opts.pool.nextAvailableIn() / 1000);
      throw new ProviderError(this.opts.pool.size ? `all keys are cooling down after rate limits (next in ${wait}s)` : "no API keys configured", this.opts.pool.size ? "rate_limited" : "config");
    }
    let last: ProviderError | undefined;
    for (const { slot, key } of keys) {
      const t0 = Date.now();
      let r: { status: number; json: unknown };
      try {
        r = await this.call(key, body, signal);
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), "other");
        if (err.kind === "aborted") throw err;
        this.log.warn("gemini call failed", { provider: this.id, keySlot: slot, kind: err.kind, ms: Date.now() - t0 });
        last = err;
        continue;
      }
      const msg = scrubKeys(String((r.json as { error?: { message?: string } })?.error?.message ?? "")).slice(0, 200);
      this.log.info("gemini call", { provider: this.id, keySlot: slot, status: r.status, ms: Date.now() - t0 });
      if (r.status === 200) return { json: r.json as GeminiResponse, slot };
      if (r.status === 429) {
        this.opts.pool.coolDown(slot, retryDelayMs(r.json) ?? this.opts.rateLimitCoolMs ?? 60_000);
        last = new ProviderError(`rate limited (429) on key slot ${slot}: ${msg}`, "rate_limited", 429);
      } else if (r.status === 403 || r.status === 401) {
        this.opts.pool.coolDown(slot, this.opts.forbiddenCoolMs ?? 5 * 60_000);
        last = new ProviderError(`forbidden (${r.status}) on key slot ${slot}: ${msg}`, "forbidden", r.status);
      } else if (r.status >= 500) {
        last = new ProviderError(`server error (${r.status}): ${msg}`, "server", r.status);
      } else if (r.status === 400 && /api key/i.test(msg)) {
        // Google answers 400 "API key not valid" for a bad key: treat like 403 for that key.
        this.opts.pool.coolDown(slot, this.opts.forbiddenCoolMs ?? 5 * 60_000);
        last = new ProviderError(`invalid key on slot ${slot}`, "forbidden", 400);
      } else {
        // 400 / 404: our request or the model name is wrong; another key will not help.
        throw new ProviderError(`request rejected (${r.status}): ${msg}`, "config", r.status);
      }
    }
    throw last ?? new ProviderError("no key succeeded", "other");
  }

  async extract(pages: PageImage[], signal?: AbortSignal): Promise<ProviderResult> {
    if (!pages.length) throw new ProviderError("no pages", "config");
    const { json, slot } = await this.request(buildGeminiRequest(pages, this.opts.maxOutputTokens), signal);
    const { text, finishReason } = responseText(json);
    const notes: string[] = [];
    let parsed = parseModelJson(text);
    if (!parsed.ok) {
      // One repair attempt by the model itself (text only, cheap).
      this.log.warn("gemini returned invalid JSON; asking for a repair", { provider: this.id, keySlot: slot, finishReason });
      const fix = await this.request(
        {
          contents: [{ role: "user", parts: [{ text: `This was meant to be JSON matching the response schema but it is invalid. Return the same data as valid JSON. Do not change any value; drop a value only if it is cut off.\n\n${text.slice(0, 200_000)}` }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, maxOutputTokens: this.opts.maxOutputTokens ?? 32768 },
        },
        signal,
      );
      parsed = parseModelJson(responseText(fix.json).text);
      notes.push("output was repaired by a second request");
      if (!parsed.ok) throw new ProviderError(`invalid JSON after repair: ${parsed.error}`, "bad_response");
    } else if (parsed.repaired) notes.push(parsed.truncated ? "output was cut off; last value dropped" : "output JSON was repaired locally");
    if (finishReason && finishReason !== "STOP") notes.push(`finishReason ${finishReason}`);
    const { raw, notes: modelNotes } = parseGeminiPayload(parsed.value);
    return { raw, keySlot: slot, model: this.opts.model, notes: [...notes, ...modelNotes] };
  }
}
