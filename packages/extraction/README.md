# @arad/extraction

Invoice photos → `MergedExtraction` (the draft the verify screen starts from). Implements `Extractor` from `@arad/core`.

```ts
import { createExtractor } from "@arad/extraction";
const extractor = createExtractor(process.env);
const draft = await extractor.extract(pages, { dataClass: "real", storeGstins, invoiceId });
// optional (proposed for core): pass the phone-decoded e-invoice QR as ctx.qr or ctx.qrRaw: string[]
extractor.providers(); // status for Admin → AI providers (key counts only, never keys)
```

`extract` never throws for business reasons. If no reader is usable it returns an empty draft whose `runs` say why.

## Pieces

| File | What |
|---|---|
| `gemini/provider.ts`, `gemini/prompt.ts` | Gemini REST reader (`x-goog-api-key` header, inline images, JSON `responseSchema`, temperature 0, 60 s timeout, one JSON repair). |
| `keypool.ts` | `GEMINI_API_KEY` + `GEMINI_API_KEY_1..9`. Round-robin start. 429 cools a key for `retryDelay` or 60 s, and for 1 h on "limit: 0". 403 cools it for 5 min. 5xx/timeout get one retry on another key. Logs show `keySlot` only. |
| `textract.ts` | AWS Textract AnalyzeExpense (`TEXTRACT_ENABLED=true`). `mapTextractExpense` is pure and tested with a recorded fixture. |
| `router.ts` | Data policy (`real` invoices never go to `trainsOnInput` providers unless `AI_ALLOW_TRAINING_PROVIDERS_FOR_REAL_DATA=true`), picks two readers (different vendors first, else `GEMINI_MODEL` + `GEMINI_SECOND_MODEL`, marked not independent), runs them in parallel, falls back to the next candidate, and keeps a circuit breaker per provider (5 failures in 60 s open it for 5 min; a 404 model opens it at once). |
| `normalise.ts` | Format clean-up only: GSTIN (with checksum-confirmed O/0-style fixes), invoice number, dates (day first), HSN digits, units, B/F and sub-total rows dropped. |
| `convert.ts` | Rupees → paise, qty → milli, % → bp. Works out whether amounts include GST (totals > line maths > what the reader said), handles GST-inclusive retail rates, discount %, and the vendor's CGST/SGST rounding. |
| `merge.ts` | **The merger.** Agreement → confidence ≥ 0.95 (0.9 for same-vendor readers). Disagreement → `flagged` with `sources`, settled by QR > GSTIN checksum > line maths / totals > confidence. Lines are aligned in order by description, amount and qty, and missing or extra lines are flagged. Finally `runChecks` runs, and every field in a failing check drops below 0.6. A lone reader is capped at 0.79. |
| `mock.ts` | `MockProvider` + `DEMO_RAW` (`EXTRACTOR=mock`). |

`extractWithProviders(pages, ctx, providers, opts)` is the same pipeline with your own providers (tests, eval) and returns per-reader drafts too.

## Env

`GEMINI_API_KEY[_1..9]`, `GEMINI_MODEL` (default `gemini-flash-latest`), `GEMINI_SECOND_MODEL` (default `gemini-3.5-flash`), `GEMINI_TIER` (`paid` = no training), `GEMINI_TIMEOUT_MS` (60000), `TEXTRACT_ENABLED`, `AWS_REGION`, `AI_ALLOW_TRAINING_PROVIDERS_FOR_REAL_DATA`, `EXTRACTOR` (`auto`/`mock`), `LOG_LEVEL`.

On Node 22 behind a proxy, built-in `fetch` needs `NODE_USE_ENV_PROXY=1`.

## Tests

`pnpm --filter @arad/extraction test`: no network. Covers the merger, alignment, paise conversion, key failover and cool-down, data policy, the breaker, Textract mapping and JSON repair.
