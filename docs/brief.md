# Apna Rashan Apni Dukan: Invoice-to-Payment App

**Problem statement and build brief for Claude Code (Opus)**
Draft v1 · 22 October 2026

---

## 1. Your mission

You are the lead engineer and product architect for a new internal app for Apna Rashan Apni Dukan, a six-outlet supermarket chain in Ranchi, Jharkhand. Read this whole brief, plan, then build and test a working system.

The app does two things:

- **Step 1** turns paper vendor invoices into verified digital bills with near-zero errors.
- **Step 2** lets the owner pay all vendors from one place in a few taps.

The chain must be able to grow from 6 to 100 stores without the clerical workload growing with it.

---

## 2. Problem statement

### Context

Apna Rashan Apni Dukan is a very busy supermarket business in the style of DMart or Reliance Smart, with 6 outlets in Ranchi. The owner is the admin and the store staff are the workers. All day, distributors and wholesalers (FMCG, staples, dairy, beverages and more) deliver stock and hand over a paper tax invoice with each delivery.

### How it works today

1. A distributor's salesman delivers goods, for example 50 packets of ketchup, and hands over a printed invoice.
2. The store files the paper invoices in a physical folder.
3. Staff read each invoice and re-key every line item into the store's software (believed to be Marg ERP).
4. At payment time, staff look up the distributor's bank details and enter them with the amount, once per invoice.

### Why it hurts

Distributors do not bill the chain as one customer. Each outlet sells a different mix, so a distributor issues a separate invoice per outlet, each with different items and quantities. The same distributor therefore appears six times in the folder, six times in data entry and six times in the payment run, and its bank account number is written six times. With 100 distributors that is about 600 payments. At 100 stores the same vendors could mean up to 10,000.

**Consequences:**

- Hours of repetitive typing every day, growing in direct proportion to the number of outlets.
- Typing errors in quantities, rates, totals and account numbers, leading to wrong stock and accounts, wrong or duplicate payments and missed payments.
- Late payments strain vendor relationships and lose credit and discount opportunities. The owner cannot see in real time what is owed to whom, and by when, across all stores.
- Paper invoices are hard to search, audit and protect from loss.
- Crores of rupees move through the owner's HDFC Bank current account every month, so every error or fraud attempt has a real cost.

### The core need

Two linked problems:

1. **A data problem:** turn a paper invoice into a trusted digital bill, quickly, by non-technical staff, with effectively no errors.
2. **A money problem:** collapse many small per-invoice payments into one payment per vendor, and let the owner approve and release a whole payout run in a few taps, with strong controls.

### Success looks like

- A typical 30-line invoice is captured and verified in about 2 minutes or less (target; measure a manual-keying baseline).
- At least 99.99% of saved field values are correct (defined in section 8).
- Vendor bank details are entered once per vendor, never once per invoice.
- One review screen and one approval cover a full payout run for every due vendor across all stores.
- Adding outlet number 7, or number 100, is a configuration task, not a hiring task.

---

## 3. Users and roles

- **Owner / Admin (all stores):** sees everything, approves vendor bank details and payout runs, configures stores, staff and policies, reviews exceptions and staff accuracy.
- **Worker / Staff (one or more stores):** captures and verifies invoices, can propose a new vendor with its bank details once, cannot approve payments or see full account numbers after entry.
- Use role-based access with store scoping so Store Manager or Accountant roles can be added later.
- Staff are non-technical, use low-to-mid-range Android phones, may prefer Hindi, and sometimes have weak connectivity. Design for one-handed use, large touch targets and minimal typing.

---

## 4. Desired end-to-end flow

1. **Capture.** Worker photographs the invoice (multi-page allowed). The app finds page edges, corrects perspective, warns about blur or glare, and decodes QR codes on the device.
2. **Read.** QR data plus OCR/AI extraction produce a draft bill (header, lines, taxes, total). Each field has a confidence score and a pointer to its place in the image.
3. **Verify (gamified).** Total lock first, then one card per line. Swipe right if it matches the paper, left to enter it manually. The bill seals when the running balance reaches zero.
4. **Link.** The bill is matched to the vendor master and the outlet. New vendors get one-time onboarding with bank details and owner approval.
5. **Payables.** Verified bills become payables, grouped per vendor across all stores.
6. **Pay All.** The owner reviews one consolidated payout run, approves it, and it executes through the bank channel. Statuses and UTRs flow back and bills close automatically.
7. **Hand-off.** Verified bills reach the ERP (Marg or other) by export or import, so nobody retypes them.

---

## 5. Module requirements

### 5.1 Capture and QR

- Mobile-first camera capture; also accept gallery images and PDFs.
- Detect and classify every code on the page:
  - **(a) GST e-invoice QR:** a signed JWT whose payload holds header-level data only (seller and buyer GSTIN, document number, type and date, total value, item count, main HSN code, IRN), no line items. Verify the signature when the issuer's certificate is available, never block on it.
  - **(b) UPI payment QR:** a hint about the payee only, never authoritative bank details.
  - **(c) Other QR codes and EAN/UPC barcodes.**
  - Store raw payloads.
- E-invoicing applies only above a turnover threshold, so many vendors will print no e-invoice QR. Everything must work without one.
- **Duplicate detection at capture:** same seller GSTIN, invoice number and financial year; same IRN; or a near-identical image hash.
- **Offline-first:** queue captures locally, upload when connected. Keep each original image immutable (store its hash) as the source of truth.

### 5.2 Extraction and validation (how we reach 99.99%)

No OCR reaches 99.99% alone. We get there in layers:

1. Pre-process images (deskew, perspective, denoise, contrast).
2. Run at least two independent extractors behind a provider interface, for example a vision-language model returning schema-constrained JSON plus a dedicated invoice parser or local OCR. Compare field by field; any disagreement flags the field.
3. Ground every extracted value in OCR tokens or pixels. A value that cannot be located on the page is suspect (a guard against hallucination).
4. Use the QR as ground truth for header fields, total and line count whenever it exists.
5. Run deterministic checks:
   - qty × rate − discount + GST = line total
   - lines sum to taxable value
   - tax split fits seller and buyer states (CGST+SGST vs IGST)
   - GSTIN format and checksum
   - HSN-to-GST-rate plausibility
   - date sanity
   - line count equals QR item count
   - round-off tolerance (default Rs 1, configurable)
6. Human verification (5.3) is the final gate. Nothing amount-bearing reaches payables unverified.
7. Learn from corrections: vendor layouts, aliases and item mappings.

**Measure it.** Build an evaluation harness with labelled invoices and report field-level accuracy after raw extraction, after validation and after human verification; enforce thresholds in CI. There are no real invoices in your sandbox, so generate synthetic ones (varied layouts, Hindi and English, thermal prints, skew, blur, shadows, handwritten corrections) and make it easy for the owner to drop in 100 to 200 real invoices locally and re-run the evaluation without committing them. Never claim 99.99% unless the evaluation supports it, and say when numbers come from synthetic data.

### 5.3 Swipe-to-verify (gamified)

Goal: make careful checking fast and satisfying, and show that staff took it seriously.

- **Header card:** vendor, GSTIN, invoice number, date, outlet. Confirm or fix.
- **Total lock:** staff type the grand total printed on the paper *before* seeing the extracted one (blind entry, so they do not anchor on the machine's answer). The app compares it with the QR/OCR total. Match: locked and shown as the target. Mismatch: guided recheck.
- **Line cards, one at a time:** item, HSN, quantity and unit, MRP, rate, discount, GST %, line amount, and the cropped image of that line.
  - Swipe right = matches the paper, saved.
  - Swipe left = manual entry form prefilled with the extracted values.
  - Also provide tick and cross buttons and undo.
  - Highlight low-confidence fields.
- **Balance-to-zero meter:** remaining = locked total minus accepted lines (with tax and round-off). The goal is Rs 0.00 and a "bill balanced" moment. If lines run out and the balance is not zero, help find the cause (missing line, wrong quantity or rate, duplicate line).
- **Seal:** show the checks (line count vs QR, totals, tax) and set VERIFIED with verifier, duration and number of edits.
- **Gamification,** weighted to accuracy over speed: points, streaks, daily goals, store leaderboards (admin can switch off), badges.
- **Attention checks:**
  - Occasionally insert calibration cards with deliberately wrong values. They are never saved to real data, admins can toggle them, and staff are told about them in onboarding.
  - Approving a planted error lowers an attention score and shows friendly feedback.
  - Enforce a minimum dwell time per card scaled to its complexity.
  - Flag suspicious patterns (never flagging an error across many bills, uniform swipe rhythm).
- **Second reviewer:** configurable rules (invoice above a value, new vendor, low attention score) require a second staff member.
- Log every swipe, edit and timing for audit. Scores are for coaching, not punishment.

### 5.4 Vendor master and bank details

- One organisation-wide vendor master shared by all stores: legal and trade name, GSTIN(s), PAN, contacts, payment terms, category, optional Udyam/MSME flag, status.
- Bank details are entered once, versioned, encrypted at rest, and masked in the UI and logs.
- Validate IFSC (format and bank/branch lookup) and account number plausibility, then run a penny-drop or name-verification check through the bank adapter and fuzzy-match the returned name to the vendor's legal name.
- **Changing bank details is high risk:** owner approval, a configurable cooling-off period, a notification and a full audit trail. Never update bank details from invoice text or a UPI QR.
- Detect duplicate vendors (same GSTIN, PAN or account).

### 5.5 Payables and Pay All

- **Payable** = verified bills minus credit notes, returns and other adjustments (scheme or cash discount; TDS if applicable). Keep these configurable and marked "confirm with the owner's CA".
- Due dates come from vendor terms. Support holds and disputes.
- Make statutory deadline flags (for example MSME payment-time rules) configurable policy, not hard-coded law.
- **Consolidation:** one payment per vendor per run, summing selected bills across all stores, with drill-down by store and bill. Generate a remittance advice listing the bills each payment covers, and put bill numbers in the bank narration where length allows.
- **Pay All flow:**
  1. Filter (due today, this week, overdue).
  2. The system pre-selects eligible payables.
  3. One review screen shows vendors, bills, total and warnings (unverified bank account, new vendor, amount far from the vendor's norm, possible duplicate, insufficient balance).
  4. The owner approves with a second factor.
  5. The run executes; statuses stream in; reconcile.
- **Maker-checker:** staff or admin can prepare a run, only the owner approves, and nobody approves a run they prepared. Thresholds are configurable.
- **Safety:** idempotency keys on every payment; a bill can be in only one active payment; an append-only payment ledger; safe retries; per-payment status for partial failures; a kill switch that pauses all payments.
- **Rails:** choose IMPS, NEFT, RTGS or UPI by amount and urgency from a config file. Limits and cut-offs vary, so never hard-code them.
- **Bank adapter interface:**
  - `MockBank`: simulates delays, failures, returns.
  - `HdfcBulkFileExport` (MVP): generate the corporate net banking bulk-upload file, show a guided download-and-upload screen, then import the bank's response or statement to reconcile.
  - `HdfcApiBanking` (production target, behind a feature flag). HDFC publishes corporate payment APIs with OpenAPI specs on its developer portal, but access is normally granted after onboarding with the bank. If you can read those specs, generate the adapter from them; if not, leave a documented stub. Do not invent endpoints, fields or auth flows.
- Write `docs/bank-integration-readiness.md`: what the owner should request from the HDFC relationship manager (API onboarding, credentials and keys, IP allow-listing, sandbox, limits, beneficiary handling, statement API).
- **Reconciliation:** match bank statement entries (UTR, amount, beneficiary) to payments, handle returns and reversals, close bills automatically.
- **Be honest about "one tap":** until HDFC API access exists, one tap means a prepared, approved batch file plus a guided upload at the bank.

### 5.6 Admin dashboard and reports

- Today by store: bills captured, verified, pending, flagged; payables due; amount paid; failures needing attention.
- Vendor ledger and ageing, with a consolidated statement per vendor across stores.
- Exceptions queue: duplicates, mismatches, bank-change requests, failed payments.
- Staff accuracy and throughput (visible to staff too) and store comparison.
- Search any invoice with its image; CSV/Excel export; audit log viewer; settings for stores, roles, policies, rails and thresholds.

### 5.7 ERP hand-off

- The owner believes the store uses Marg ERP, unconfirmed. A quick search found no public Marg import or API specification (Marg exports to Excel, PDF and Tally).
- Build an `ErpExporter` interface with:
  - a generic purchase-bill CSV/Excel export that always works,
  - a Tally-compatible export,
  - a Marg adapter that stays a documented stub until the owner confirms the import route with Marg support.
- Add item mapping from vendor item descriptions to the store's item master (fuzzy match on name, HSN, MRP and pack size), learning from confirmations.
- Keep IRN, GSTINs, HSN and tax splits so GSTR-2B reconciliation can be added later.

---

## 6. Edge cases to handle

- Multi-page invoices and several invoices in one photo.
- Continued item tables with brought-forward and carried-forward subtotals.
- Credit and debit notes, returns, damaged or short deliveries.
- Cancelled IRN.
- Invoice addressed to the wrong outlet, or a buyer GSTIN not in the system.
- Scheme discounts, freight, round-off, part and advance payments.
- The same item under different names across vendors.
- Folded, stamped, blurry or handwritten-over invoices.
- Hindi text.

---

## 7. Starter data model and states

**Entities:** Organization, Store, User and Role, Vendor, VendorBankAccount (versioned), Document and Page (images, QR payloads, raw extractor outputs), Invoice, InvoiceLine, VerificationEvent, Adjustment, PaymentBatch, Payment, PaymentAllocation, StatementEntry, ItemMapping, ExportJob, AuditLog (append-only).

**Invoice states:** `CAPTURED`, `EXTRACTING`, `NEEDS_VERIFICATION`, `VERIFIED`, `APPROVED_FOR_PAYMENT`, `IN_PAYMENT_RUN`, `PAID`.
**Side states:** `ON_HOLD`, `DISPUTED`, `DUPLICATE`, `REJECTED`, `PAYMENT_FAILED`.

**Payment states:** `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `SUBMITTED`, `SETTLED`, `FAILED`, `RETURNED`.

Refine freely, but keep these invariants:

- Money is stored as integer paise or exact decimals, never floats.
- A bill has at most one active payment allocation.
- Verified data changes only through an audited correction.
- Every state change records who, when and why.

---

## 8. Non-functional requirements

- **Accuracy:** at least 99.99% of saved values (amounts, quantities, rates, GSTIN, invoice number, date, bank details) are correct, measured by audit sampling. Document how it is measured.
- **Security:** field-level encryption for bank data; secrets from environment or a KMS; owner MFA; short-lived sessions; staff device binding; store-scoped access control; rate limiting; no bank numbers or personal data in logs.
  - Write a threat model focused on payment fraud: vendor impersonation, bank-detail swaps, insider collusion, replayed requests, duplicate payments.
- **Scale assumptions (confirm with the owner):** up to 100 stores, about 10,000 bills a day, about 5,000 vendors, about 30 lines per bill. Extraction runs asynchronously through a queue, the schema is partition-ready, images live in object storage.
- **Offline and low bandwidth:** capture offline; compress and resume uploads.
- **Languages:** English and Hindi UI from day one; OCR handles Devanagari and English.
- **Speed:** prefetch the next card so swiping never waits; smooth on a low-end Android phone.
- **Operations:** structured logs, metrics, health checks and an admin view of job status. Treat staff and vendor personal data carefully under India's DPDP Act and collect only what is needed.

---

## 9. Suggested architecture (defaults; deviate only with a written reason)

- **Worker app:** installable mobile-first PWA (React, TypeScript, Vite, Tailwind, service worker, IndexedDB queue, a gesture library for swipes).
- **Admin:** responsive web dashboard in the same monorepo.
- Keep logic portable so an Android wrapper is possible later.
- **Backend:** TypeScript (NestJS or Fastify) or Python (FastAPI); pick one for the core API; extraction workers may be Python. REST with OpenAPI. PostgreSQL; Redis or a Postgres-based queue; S3-compatible storage (MinIO in dev).
- **Extraction:** provider interface with at least two engines and a local baseline (for example Tesseract or PaddleOCR with Hindi and English) so the system runs offline; cloud engines turn on through environment keys.
- **Bank and ERP adapters** live in separate packages with contract tests. Include a mock bank server in the repo.
- `docker compose up` starts a full demo with seed data: 6 Ranchi outlets, about 100 synthetic vendors, sample invoices.
- **CI:** lint, type-check, unit, integration and end-to-end tests (Playwright with a fake camera), coverage report.

---

## 10. Facts to verify rather than trust

- **GST e-invoice QR:** a signed JWT with header-level fields only. E-invoicing is mandatory above a Rs 5 crore turnover threshold (unchanged as of 2026 per recent sources; check the current notification and the official e-invoice specification).
- **HDFC:** the owner's account may support corporate net banking bulk upload, API banking, or both; unknown until confirmed. Third-party payout platforms exist but may need a pre-funded payout account, so treat them as a fallback.
- **Marg:** import and export routes are unconfirmed.
- **Statutory items** (TDS, MSME deadlines, GST treatment) are configurable policy with a "confirm with CA" note.

---

## 11. Environment constraints and test strategy

You are in a cloud sandbox: no real bank access, no real invoices, no physical camera. So:

- Use a mock bank and a synthetic invoice generator that renders realistic invoices, including e-invoice-style QR codes signed with a test key.
- Test capture with Playwright and a fake video device fed from sample images.
- Mock extraction providers with recorded fixtures in CI; real providers run only when environment keys exist.
- Never commit secrets or real data; provide `.env.example`.
- In your final report, separate what is **verified**, what is **mocked** and what is **unverified**.

---

## 12. How to work

1. **Plan first.** Before coding, write `CLAUDE.md` (project context, commands, conventions), `docs/PLAN.md` (architecture, milestones, risks) and `DECISIONS.md` (assumptions and defaults you chose).
2. **Do not stop to ask questions** unless truly blocked. Take the stated default, log it in `DECISIONS.md` and move on.
3. **Build a thin vertical slice first** (capture, extract, verify, vendor, payable, mock Pay All), then deepen each module.
4. **Milestones:**
   - M0: scaffold and plan
   - M1: capture and QR
   - M2: extraction, validation, evaluation harness
   - M3: swipe verification
   - M4: vendor master and bank workflow
   - M5: payables, Pay All (mock bank and HDFC file export), reconciliation
   - M6: admin dashboard
