# Design: multiple AI providers with free tiers at the start

Status: design · Related: `DECISIONS.md` D-010 to D-012, brief §5.2

## 1. Rule zero: keys live on the server, never in the phone app

Anything shipped to a phone (PWA JavaScript, or an APK/IPA) can be read by
anyone who has the phone. An AI key inside the app = a key anyone can copy and
spend on. So:

```
 Phone ──photo──► API ──job──► Extraction worker ──(key from secret store)──► AI provider
                                       ▲
                     Secrets store (AWS Secrets Manager / Azure Key Vault; .env in local dev)
```

- The owner adds or replaces a key in **Admin → Settings → AI providers**.
- The API writes it straight to the secrets store. The database keeps only
  metadata: provider, last 4 characters, who added it, when, last test result.
- The UI never shows a full key again. Logs never contain keys.
- Workers read keys from the secrets store and refresh every few minutes, so
  rotating a key needs no redeploy.

## 2. Providers (pluggable, all behind one interface)

| Provider | Kind | Cost at start | Data note | Role |
|---|---|---|---|---|
| Tesseract / PaddleOCR (local) | OCR with word boxes | Free, runs in our worker | Never leaves our server | **Always on.** Grounding + offline baseline |
| Azure AI Document Intelligence (prebuilt invoice) | Invoice parser | Free tier: 500 pages/month | Stays in our Azure resource | Extractor #1 candidate |
| AWS Textract (AnalyzeExpense) | Invoice/receipt parser | Pay per page (check if beta credits apply) | Stays in our AWS account | Extractor #1 candidate |
| Vision LLM (Claude via API or Bedrock, Gemini, GPT, others) | Schema-constrained JSON | Paid; some have free tiers | **Free tiers may train on our data** (see §4) | Extractor #2 |
| Mock / recorded fixtures | Test only | Free | Synthetic | CI |

Model names and endpoints come from config (environment), never from code.

## 3. The provider interface

```ts
interface ExtractionProvider {
  id: string;                         // "azure-di", "textract", "claude", "local-ocr"
  capabilities: ("ocr-boxes" | "invoice-fields" | "line-items" | "qr")[];
  dataPolicy: { trainsOnInput: boolean; region: string };
  extract(doc: PageImages, opts: { timeoutMs: number; idempotencyKey: string }): Promise<ExtractionResult>;
  healthCheck(): Promise<void>;
}
```

`ExtractionResult` uses one shared schema (header, lines, taxes, totals, a
confidence per field, a bounding box per field). That way every provider's
output can be compared field by field.

## 4. Free tiers and invoice privacy

Invoices hold vendor names, GSTINs, amounts and sometimes bank details. Some
free tiers allow the provider to use inputs to train models and to have humans
review them. For example, Google's Gemini API terms treat free-tier data
differently from paid-tier data (verify current terms before use).

Policy, set in config:

- Every provider declares `trainsOnInput`.
- Every document carries a `dataClass`: `synthetic` or `real`.
- **The router never sends a `real` invoice to a provider with `trainsOnInput: true`**,
  unless the owner explicitly turns that on in Settings. Turning it on is audit-logged.
- So free tiers that train on data are for development with synthetic invoices.
  Real invoices go to local OCR, Azure DI free tier, or paid, no-training tiers.

Also: **one account and one key per provider per business.** Opening several
free accounts to dodge limits usually breaks the provider's terms and can get
every key banned.

## 5. The router: choosing and falling back

For each invoice:

1. **Filter** providers: enabled, has the needed capability, data policy allows
   this `dataClass`, monthly quota and budget left, circuit breaker closed.
2. **Order** by priority. Priority comes from the evaluation harness (accuracy
   per rupee on our labelled set), not guesswork.
3. **Pick two independent extractors** from different vendors, plus local OCR for
   grounding (brief §5.2 step 2–3).
4. **On failure:**
   - `429` / quota exceeded → mark the provider exhausted until its reset time, use the next one.
   - `5xx` / timeout → one retry with backoff and jitter. Repeated failures open
     the circuit breaker for a cool-down.
   - Invalid JSON → one repair attempt, then the next provider.
5. **If every cloud provider is down or out of quota,** use local OCR alone and
   mark the fields low-confidence. Staff verify more carefully. **The system slows
   down but never stops.**

Every call is recorded with provider, model, latency, pages or tokens, cost
estimate and result hash. This feeds the cost dashboard and the evaluation harness.

## 6. Config example (non-secret part, in the repo)

```yaml
# config/providers.yaml — keys are NOT here; they come from the secrets store
providers:
  local-ocr:   { enabled: true,  priority: 100, trainsOnInput: false, languages: [eng, hin] }
  azure-di:    { enabled: true,  priority: 10,  trainsOnInput: false, monthlyPageCap: 500 }
  textract:    { enabled: false, priority: 20,  trainsOnInput: false, monthlyBudgetInr: 2000 }
  vision-llm-a:{ enabled: true,  priority: 15,  trainsOnInput: false, model: ${VLM_A_MODEL} }
  vision-llm-free:{ enabled: true, priority: 90, trainsOnInput: true, allowedDataClass: [synthetic] }
router:
  extractorsPerInvoice: 2
  timeoutMs: 30000
  breaker: { failures: 5, windowSec: 60, coolDownSec: 300 }
```

## 7. Still to verify

- Current free-tier limits and data terms of each provider on the day we enable it.
- Whether AWS beta credits cover Textract or Bedrock in the Mumbai region.
- How each engine actually does on Indian GST invoices and Hindi text. The
  evaluation harness (M2) answers this. Until then, priorities are placeholders.
