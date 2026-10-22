# Plan: Apna Rashan Payables

Source brief: `docs/brief.md` · Assumptions and defaults: `DECISIONS.md`

## 1. Focus

Two things done **correctly**, everything else kept simple:

1. **Paper bill → correct digital bill.** Capture, extract, check, human verify.
2. **Correct HDFC bulk payment file.** One payment per vendor, every field valid.
   The payment itself is done by the owner in HDFC ENet (`docs/design/hdfc-bulk-file.md`).

## 2. What we build

- **One installable web app (PWA)** for iPhone and Android, installed from a
  link, no app store (`docs/research/mobile-platform.md`).
  - Staff: photograph invoice → swipe to verify → done.
  - Owner: vendors, payables, approve run → download HDFC file.
- **One small server:** API, Postgres, invoice images, extraction worker.
- **Shared code** (`packages/*`) so the phone and server compute totals the same way.

```
apps/web                 the PWA (staff + owner screens)
services/api             API (Fastify, TypeScript)
services/extract         extraction worker (Python OCR + AI providers)
packages/core            money (integer paise), GST maths, GSTIN check, bill states
packages/hdfc-bulk-file  HDFC ENet bulk file generator   ← built
tools/synth-invoices     synthetic invoices for tests
tools/eval               extraction accuracy evaluation
```

## 3. Accuracy: how a paper bill becomes a correct digital bill

1. **Good photo:** edge detection, perspective fix, blur/glare warning, retake prompt.
2. **QR first:** a GST e-invoice QR gives trusted header data (GSTINs, invoice
   number, date, total, line count).
3. **Two extractors** (local OCR + one AI provider, see `docs/design/ai-providers.md`);
   any field where they disagree is flagged.
4. **Maths checks:** qty × rate − discount + GST = line total; lines add up to the
   total; CGST+SGST vs IGST fits the states; GSTIN checksum; date sanity;
   line count = QR item count; round-off within ₹1.
5. **Human verification:** staff type the printed grand total first (without
   seeing the machine's), then swipe through lines; the bill seals only when the
   balance reaches ₹0.00.
6. **Measure:** evaluation harness on synthetic invoices now, real ones (kept
   off git) later. No accuracy claims without numbers.

## 4. Milestones

| # | Milestone | Output |
|---|---|---|
| M0 | Scaffold | Monorepo, CI (lint, types, tests), Docker Compose, PWA shell, Hindi/English |
| M1 | Capture + QR | Camera/gallery/PDF, edge + blur checks, QR decode, duplicate check, offline queue. **Test on a real iPhone and a low-end Android** |
| M2 | Extraction + checks | Two extractors, maths checks, synthetic invoices, accuracy report |
| M3 | Verify | Blind total, swipe line cards, balance-to-zero, seal with audit trail |
| M4 | Vendors | Vendor master, bank details once (typed twice), IFSC check, ENet beneficiary code, owner approval for changes |
| M5 | Payables + HDFC file | Due list, one payment per vendor, review screen, approve, download file + control totals, mark uploaded/paid. **File generator: done** |
| M6 | Owner dashboard | Today by store, what's owed to whom, search bills with image, CSV export |

## 5. Hosting

Beta on AWS Mumbai, kept simple: one ECS Fargate container (API + PWA + worker)
behind CloudFront for HTTPS, RDS Postgres with automatic backups, S3 for
images, secrets in AWS Secrets Manager (`docs/deploy.md`, `infra/aws`). Twelve-factor config so it can move anywhere
(`docs/design/platform.md`).

## 6. Risks

| Risk | Mitigation |
|---|---|
| HDFC file layout differs from our version | Layout in one file (`spec.ts`); owner gets the official template; ₹1 test run before real use |
| Bank rejects whole file for one bad row | Generator refuses to build until every row is valid |
| Wrong payment total uploaded | Control totals must match what ENet shows before authorising |
| OCR misreads | QR + two extractors + maths checks + blind total + human swipe |
| iPhone camera/storage quirks | Real-device test in M1; Capacitor wrapper as fallback |
| Bank-detail fraud | Entered once, owner-approved changes, never from invoice text |

## 7. Left out on purpose (maybe later)

Gamification, leaderboards, calibration cards, second reviewer, HDFC API,
payout platforms, penny-drop, automatic bank reconciliation, Marg/Tally
adapters (a generic CSV export is kept), microservices, auto-scaling clusters.
