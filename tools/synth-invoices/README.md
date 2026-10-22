# @arad/synth-invoices

Synthetic Indian GST invoices as JPEG photos plus ground-truth JSON, for tests, demos and `tools/eval`.

```bash
pnpm --filter @arad/synth-invoices gen --count 20 --seed 42          # → tools/synth-invoices/out/ (gitignored)
pnpm --filter @arad/synth-invoices gen --count 5 --layout thermal,hindi --clean --out /tmp/x
pnpm --filter @arad/synth-invoices samples                           # rewrites samples/ (6 invoices, ≤ 300 KB each)
```

- **Layouts:** `a4-table` (distributor invoice with CGST/SGST or IGST columns, sometimes 2 pages with C/F and B/F rows), `thermal` (80 mm receipt with GST-inclusive rates and a GST summary), `hindi` (Devanagari labels and item names, amounts before tax), `igst` (out-of-state vendor, boxed serif style), `credit-note`.
- **Content:** fictional vendors with valid GSTINs (`gstinCheckChar`) and a grocery catalogue (English + Hindi). GST slabs 0/5/18/40, with legacy 12/28 on pre-22-Sep-2025 bills. Line discounts (amount or %), freight, scheme discount, round-off, amount in words, and handwritten-style scribbles to ignore.
- **E-invoice QR:** a JWT signed with a per-run test RSA key (`node:crypto`), with payload `data` holding SellerGstin, BuyerGstin, DocNo, DocTyp, DocDt (dd/mm/yyyy), TotInvVal, ItemCnt, MainHsnCode, Irn and IrnDt. It is rendered with `qrcode`, and `parseEInvoiceQr` in core reads it.
- **Distortions:** none, mild, moderate or harsh. These are rotation, skew, blur, low contrast, a shadow gradient and paper tint, applied by re-rendering the screenshot.
- **Truth (`<id>.json`):** `raw` (RawExtraction as printed, in rupees), `expected` (paise form: header, totals, lines), `qr.raw`, `printedRates`, `pages` and `distortions`. Every truth passes `runChecks` (tested).
- **Rendering:** Playwright (`playwright-core` 1.56) with the Chromium in `/opt/pw-browsers`, found automatically (or set `CHROMIUM_PATH`). Never run `playwright install`.
