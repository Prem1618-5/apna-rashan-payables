# @arad/eval

Field-level accuracy of the extractor. It reports **raw reader 1**, **raw reader 2**, **merged**, and **merged + flags**. In the last one, every wrong field is either *caught* (flagged or confidence < 0.8, so the verify screen highlights it) or *silent*. **Silent errors are the key metric.**

```bash
# offline: two simulated readers with OCR-like mistakes (tests the merger, no network)
pnpm --filter @arad/eval run eval --dir tools/synth-invoices/out
# live: real providers from env; raw outputs cached for replay
NODE_USE_ENV_PROXY=1 pnpm --filter @arad/eval run eval --dir tools/synth-invoices/samples --live --cache tools/eval/recorded/<date>
# re-score cached outputs after changing the merger (no calls)
pnpm --filter @arad/eval run eval --dir tools/synth-invoices/samples --replay tools/eval/recorded/2026-10-22
```

Options: `--limit N`, `--only id1,id2`, `--no-qr`, `--real`, `--write-drafts`, `--report <file>`, `--title`, `--pace <ms>` (default 4000 between live invoices). Set `STORE_GSTINS=…` (comma list) for the buyer check on real invoices.

## Real invoices (owner, on your own computer — never in git)

1. Make a folder **outside the repo**, e.g. `~/arad-real-invoices/`. Put in one of:
   - one folder per invoice: `inv-0001/page-1.jpg`, `inv-0001/page-2.jpg`, …
   - or flat files: `inv-0001.jpg`, `inv-0002.pdf`, …
2. Run once to get drafts: `pnpm --filter @arad/eval run eval --dir ~/arad-real-invoices --real --live --write-drafts`. Real invoices are `dataClass: real`, so free Gemini tiers are **blocked** unless you use a paid tier (`GEMINI_TIER=paid`) or Textract.
3. Open each `*.draft.json`, correct every value against the paper, and save it as `inv-0001/truth.json` (folder layout) or `inv-0001.truth.json` (flat). Money is in paise, qty in thousandths and GST in basis points.
4. Re-run without `--write-drafts`. The report goes to `<folder>/eval-report.md`. 100–200 invoices give a usable picture. Use `--replay <folder>/.eval-cache` to re-score without new calls.

Without truth files the run still reports the readers used, flagged fields and failed checks for each invoice.

The latest synthetic report is in `docs/eval/synthetic-2026-10-22.md` (synthetic data, single live reader).
