# Extraction evaluation — SYNTHETIC invoices, live Gemini, 2026-10-22

> **SYNTHETIC DATA: generated invoices (tools/synth-invoices), not real vendor bills. Real-world accuracy will be lower; do not quote these numbers as production accuracy.**

- Date: 2026-10-22
- Mode: `replay` · readers: `replay of tools/eval/recorded/2026-10-22`
- Invoices: 5 (5 with ground truth) · pages: 6
- E-invoice QR given to the extractor (as the phone would decode it): yes, when the invoice has one
- Folder: `../synth-invoices/samples`

## Read this first: what this run is and is not

- **Synthetic data only.** 5 of the 6 committed samples in `tools/synth-invoices/samples/` (clean-to-harsh photo distortions, English/Hindi, thermal, credit note, a 2-page invoice with B/F rows). Real vendor bills will be harder (handwriting, folds, faded thermal paper, odd layouts).
- **One reader only.** `gemini-flash-latest` read every invoice correctly (435/435 fields). The planned second reader could not run on these free-tier keys: `gemini-3.5-flash` answered 429 with quota limit 0, and `gemini-2.5-flash` answered 404 ("no longer available to new users"). With one reader the merger caps every confidence at 0.79, so every field is highlighted ("false alarms" 86%) — that is intended: no cross-check, no trust.
- `synth-7-003-igst` is left out: `gemini-flash-latest` answered 503 "high demand" on both attempts.
- About 22 Gemini calls were made in total (including the failures above). Raw outputs are in `tools/eval/recorded/2026-10-22/`; this report was made with `--replay` (no extra calls).
- Two-reader merger behaviour was measured offline with simulated readers (OCR-like mistakes, see below).

## Two simulated readers on 40 synthetic invoices (offline, `tools/eval` default mode)

Each simulated reader reads the truth with independent mistakes (2% digit misreads per number, 2% dropped lines, 4% confusable characters in GSTIN/invoice no., 3% day/month swaps, 2% missing values). These rates are guesses, not measurements; this tests the merger, not a model.

### Merged + flags: caught vs silent

| Group | Fields | Correct | Wrong | Caught (flagged) | Silent | Silent rate | False alarms |
|---|---:|---:|---:|---:|---:|---:|---:|
| header | 254 | 99.6% | 1 | 1 | **0** | 0.0% | 14 |
| totals | 320 | 100.0% | 0 | 0 | **0** | 0.0% | 20 |
| lines | 2860 | 99.3% | 21 | 19 | **2** | 0.1% | 235 |
| **all** | 3434 | 99.4% | 22 | 20 | **2** | 0.1% | 269 |


Residual silent errors: 2 line totals off by 1 paisa where line GST is not printed and the vendor rounding method could not be inferred.

## Live run (gemini-flash-latest, single reader)

## Headline

- Merged draft: **100.0%** of 435 fields correct.
- Of the 0 wrong fields, **0 were flagged** for review and **0 were silent** (wrong but looked fine) — silent error rate **0.0%**.
- False alarms (correct but flagged): 374 (86.0% of fields) — extra review work, not errors.
- Invoices fully correct: 5/5. Invoices with at least one silent error: **0/5**.

A field is *flagged* when the merger marks it `flagged` or gives it confidence below 0.8 (the verify screen highlights it). A missing line counts as caught when the totals no longer add up (the balance-to-zero meter shows it).

### Accuracy by reader

| Variant | Fields | Correct | Wrong |
|---|---:|---:|---:|
| Reader 1 alone (gemini:gemini-flash-latest) | 435 | 100.0% | 0 |
| Merged | 435 | 100.0% | 0 |

### Merged + flags: caught vs silent

| Group | Fields | Correct | Wrong | Caught (flagged) | Silent | Silent rate | False alarms |
|---|---:|---:|---:|---:|---:|---:|---:|
| header | 32 | 100.0% | 0 | 0 | **0** | 0.0% | 21 |
| totals | 40 | 100.0% | 0 | 0 | **0** | 0.0% | 23 |
| lines | 363 | 100.0% | 0 | 0 | **0** | 0.0% | 330 |
| **all** | 435 | 100.0% | 0 | 0 | **0** | 0.0% | 374 |

### By field (merged)

| Field | Fields | Correct | Wrong | Caught | Silent | Silent rate | False alarms |
|---|---:|---:|---:|---:|---:|---:|---:|
| `header.buyerGstin` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 3 |
| `header.docType` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 3 |
| `header.invoiceDate` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 4 |
| `header.invoiceNo` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 3 |
| `header.irn` | 2 | 100.0% | 0 | 0 | **0** | 0.0% | 0 |
| `header.sellerGstin` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 3 |
| `header.vendorName` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 5 |
| `lines.description` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.discountPaise` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 4 |
| `lines.gstRateBp` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.hsn` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.qtyMilli` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.ratePaise` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.taxPaise` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.taxablePaise` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.totalPaise` | 37 | 100.0% | 0 | 0 | **0** | 0.0% | 37 |
| `lines.unit` | 30 | 100.0% | 0 | 0 | **0** | 0.0% | 30 |
| `totals.cgstPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 4 |
| `totals.discountPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 0 |
| `totals.grandTotalPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 3 |
| `totals.igstPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 1 |
| `totals.otherChargesPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 1 |
| `totals.roundOffPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 5 |
| `totals.sgstPaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 4 |
| `totals.taxablePaise` | 5 | 100.0% | 0 | 0 | **0** | 0.0% | 5 |

### By field (each reader alone)

| Field | Reader 1 | Merged |
|---|---:|---:|
| `header.buyerGstin` | 100.0% | 100.0% |
| `header.docType` | 100.0% | 100.0% |
| `header.invoiceDate` | 100.0% | 100.0% |
| `header.invoiceNo` | 100.0% | 100.0% |
| `header.irn` | 100.0% | 100.0% |
| `header.sellerGstin` | 100.0% | 100.0% |
| `header.vendorName` | 100.0% | 100.0% |
| `lines.description` | 100.0% | 100.0% |
| `lines.discountPaise` | 100.0% | 100.0% |
| `lines.gstRateBp` | 100.0% | 100.0% |
| `lines.hsn` | 100.0% | 100.0% |
| `lines.qtyMilli` | 100.0% | 100.0% |
| `lines.ratePaise` | 100.0% | 100.0% |
| `lines.taxPaise` | 100.0% | 100.0% |
| `lines.taxablePaise` | 100.0% | 100.0% |
| `lines.totalPaise` | 100.0% | 100.0% |
| `lines.unit` | 100.0% | 100.0% |
| `totals.cgstPaise` | 100.0% | 100.0% |
| `totals.discountPaise` | 100.0% | 100.0% |
| `totals.grandTotalPaise` | 100.0% | 100.0% |
| `totals.igstPaise` | 100.0% | 100.0% |
| `totals.otherChargesPaise` | 100.0% | 100.0% |
| `totals.roundOffPaise` | 100.0% | 100.0% |
| `totals.sgstPaise` | 100.0% | 100.0% |
| `totals.taxablePaise` | 100.0% | 100.0% |

### By layout (merged)

| Layout | Invoices | Fields | Correct | Wrong | Caught | Silent | Silent rate | False alarms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| a4-table | 2 | 240 | 100.0% | 0 | 0 | **0** | 0.0% | 204 |
| credit-note | 1 | 44 | 100.0% | 0 | 0 | **0** | 0.0% | 38 |
| hindi | 1 | 74 | 100.0% | 0 | 0 | **0** | 0.0% | 65 |
| thermal | 1 | 77 | 100.0% | 0 | 0 | **0** | 0.0% | 67 |

### Silent errors (the ones that matter)

None.

### Per invoice

| Invoice | Layout | Distortion | Readers | Correct | Silent | Flagged fields | Failed checks |
|---|---|---|---|---:|---:|---:|---|
| synth-7-000-a4-table | a4-table | harsh | gemini:gemini-flash-latest (0.0s) | 100.0% | 0 | 46/56 | none |
| synth-7-001-thermal | thermal | moderate | gemini:gemini-flash-latest (0.0s) | 100.0% | 0 | 73/76 | none |
| synth-7-002-hindi | hindi | mild | gemini:gemini-flash-latest (0.0s) | 100.0% | 0 | 65/68 | none |
| synth-7-004-credit-note | credit-note | none | gemini:gemini-flash-latest (0.0s) | 100.0% | 0 | 38/41 | none |
| synth-7-005-a4-table | a4-table | moderate | gemini:gemini-flash-latest (0.0s) | 100.0% | 0 | 176/185 | none |

### Provider calls

| Provider | Calls | OK | Failed | Median latency |
|---|---:|---:|---:|---:|
| gemini:gemini-flash-latest | 5 | 5 | 0 | 0.0 s |

