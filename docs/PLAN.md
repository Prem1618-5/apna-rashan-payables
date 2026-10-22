# Plan: Apna Rashan Payables

Source brief: `docs/brief.md` · Platform research: `docs/research/mobile-platform.md`
Assumptions and defaults: `DECISIONS.md`

## 1. What we are building

One installable web app (PWA) that runs on **both iPhone and Android**, installed
from a link and **not** from any app store, plus one small server owned by the
business.

- **Staff** (Android or iPhone): photograph invoices, swipe to verify, propose vendors.
- **Owner** (phone or laptop): dashboard, vendor bank approvals, Pay All approval.
- **Server**: database, invoice images, OCR/AI extraction, payables, bank file
  export, ERP export.

## 2. Architecture

```
┌───────────────────────── Phone (iOS Safari / Android Chrome) ─────────────────────────┐
│ apps/web  (React + TS + Vite + Tailwind, installable PWA, Hindi + English)            │
│  ├─ Staff shell: Capture → Verify (swipe cards) → My stats                            │
│  ├─ Owner shell: Dashboard → Vendors → Payables → Pay All → Reports                   │
│  ├─ Service worker: app works offline, caches the app shell                           │
│  ├─ IndexedDB outbox: captured photos + swipe events wait here until uploaded          │
│  └─ Web Worker: edge detection, perspective fix, blur check, QR decode (zxing-wasm)   │
└──────────────────────────────────────────┬────────────────────────────────────────────┘
                                           │ HTTPS (REST + OpenAPI), resumable uploads
┌──────────────────────────────────────────▼────────────────────────────────────────────┐
│ services/api      Fastify + TypeScript: auth, roles, store scoping, invoices,          │
│                   vendors, payables, payment runs, audit log                          │
│ services/extract  Python worker: Tesseract/PaddleOCR (Hindi + English) + optional     │
│                   cloud vision model behind a provider interface                      │
│ PostgreSQL        all business data; pg-boss job queue (no Redis needed)              │
│ MinIO / S3        original invoice images (immutable, hashed)                          │
│ mock-bank         simulated bank for tests and demos                                  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Monorepo layout

```
apps/web                 the PWA (staff + owner shells, role-based routes)
services/api             core API (Fastify, TypeScript)
services/extract         extraction worker (Python)
services/mock-bank       mock bank server
packages/core            shared TS: money (integer paise), GSTIN checksum, line maths,
                         tax split rules, invoice state machine. Used by phone AND server.
packages/bank-adapters   MockBank, HdfcBulkFileExport, HdfcApiBanking (stub)
packages/erp-exporters   Generic CSV/Excel, Tally, Marg (stub)
packages/einvoice        e-invoice QR (JWT) parsing + signature check
tools/synth-invoices     synthetic invoice generator for tests and evaluation
tools/eval               accuracy evaluation harness
docs/                    plan, research, threat model, bank readiness
```

Why `packages/core` matters: the balance-to-zero meter on the phone and the
server's validation use the **same** code, so the phone and server can never
disagree about a total.

## 3. How iOS and Android compatibility is guaranteed

| Area | Approach that works on both |
|---|---|
| Install | Android: Chrome "Install app" prompt. iPhone: Safari → Share → Add to Home Screen. In-app illustrated guide in Hindi + English. |
| Camera | Live camera via `getUserMedia` (rear camera). Fallback: `<input type="file" accept="image/*" capture="environment">`, which always works. Gallery and PDF upload too. |
| QR / barcode | zxing-wasm in a Web Worker on both (Safari has no `BarcodeDetector`). |
| Offline | Service worker caches the app. IndexedDB outbox holds captures. Call `navigator.storage.persist()`. |
| Upload | Compress on the phone (target ~300–600 KB per page), chunked + resumable. iOS has no background sync, so upload on open/foreground and show a pending badge. |
| Swipe | Pointer Events + a small gesture library; tick/cross buttons as equal alternatives; 48 px+ touch targets; works one-handed. |
| Owner second factor | WebAuthn passkeys (Face ID / fingerprint) on both, with TOTP as fallback. |
| Notifications | Web Push: Android always, iPhone only after Add to Home Screen (iOS 16.4+). Never the only channel for anything important. |
| Screens | Mobile-first layout, safe-area insets for iPhone notch, dark/light, tested at 360 px width. |
| Language | i18n from day one (English + Hindi), Devanagari font bundled. |

### Device test matrix (manual, every milestone from M1)

- Cheapest Android phone used by staff (Chrome, current version).
- One mid-range Android phone.
- One iPhone on the oldest iOS version in use, and one on the latest.
- Each run: install, capture offline, go online and upload, verify a 30-line bill, approve a mock payout.

Automated: Playwright with a fake camera, run in Chromium **and WebKit** (WebKit is
Safari's engine) at phone screen sizes.

## 4. Hosting, AI providers and payments

- **Cloud (beta):** AWS Mumbai (ECS Fargate, RDS Postgres, S3, Secrets Manager),
  portable to Azure via Terraform. Twelve-factor, resilience, security and scale:
  `docs/design/platform.md`.
- **AI providers:** several providers behind one router with fallback; keys only
  in the server's secrets store, never in the phone app: `docs/design/ai-providers.md`.
- **Payments:** HDFC bulk upload file for beta, HDFC API Banking for production,
  penny-drop API for vendor bank verification: `docs/design/payments.md`.
- HTTPS is required, not optional: iPhones block camera, offline caching and
  install on insecure sites.

## 5. Milestones

Each milestone ends with tests passing in CI and a run through the device test matrix.

| # | Milestone | Main output | Mobile-specific work |
|---|---|---|---|
| M0 | Scaffold and plan | Monorepo, CI (lint, types, unit), `docker compose up` with seed data (6 Ranchi stores, ~100 vendors) | PWA manifest, icons, service worker, install guide screen, Hindi/English switch |
| M1 | Capture and QR | Camera + gallery + PDF capture, edge detection, blur/glare warning, QR classify (e-invoice / UPI / other), duplicate check, offline outbox, resumable upload | **Platform gate:** confirm camera, storage and upload on real iPhone + low-end Android. If it fails, switch to Capacitor (see DECISIONS D-001) |
| M2 | Extraction + validation + evaluation | Two extractors behind one interface, grounding, deterministic checks, synthetic invoice generator, eval harness with CI thresholds | None on phone (server work); keep phone payload small |
| M3 | Swipe to verify | Header card, blind total lock, line cards, balance-to-zero meter, seal, gamification, calibration cards, second reviewer | Smooth 60 fps swiping on low-end Android, prefetch next card, haptics where supported |
| M4 | Vendor master + bank details | Vendor onboarding, encrypted bank details, IFSC check, owner approval, cooling-off, duplicate vendor check | Masked account numbers on screen, passkey for owner approvals |
| M5 | Payables + Pay All + reconciliation | Consolidation per vendor, maker-checker, MockBank, HDFC bulk file export, statement import, ledger, kill switch | Owner's Pay All review fits a phone screen; file download works on iOS and Android |
| M6 | Admin dashboard | Today by store, ageing, exceptions, staff accuracy, search, exports, audit viewer, settings | Responsive: phone for quick checks, laptop for deep work |

**Thin vertical slice first:** before deepening any module, one bill goes end to
end (capture → mock extract → verify → vendor → payable → mock Pay All) on both
an iPhone and an Android phone.

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| iOS clears offline data before upload | Lost capture | Persistent storage request, upload ASAP, pending badge, paper stays filed until bill is VERIFIED |
| iOS camera or storage quirks on staff's phones | Slow capture | M1 device gate; `<input capture>` fallback; Capacitor plan ready |
| Low-end Android too slow | Staff frustration | Image work in Web Worker, OCR on server, performance budget in CI |
| Staff can't install on iPhone | Adoption | Illustrated guide, store manager does first install, QR code poster in each store linking to the app |
| Server down | Nobody can sync | Phones keep working offline; health checks; backups; documented restore |
| OCR accuracy on real invoices | Wrong data | Layered checks + human verification; never claim 99.99% without eval data |
| HDFC API access not granted | "One tap" is file upload | Bulk file export is the MVP; API adapter is a documented stub |
| Payment fraud (bank-detail swap, insider) | Real money lost | Maker-checker, owner passkey, cooling-off, audit log, threat model (M4) |
| AI key leaked or free quota exhausted | Cost or outage | Keys only in secrets store; router falls back to next provider, then local OCR |
| Free-tier AI trains on real invoices | Business data exposure | Router blocks `real` data to providers with `trainsOnInput: true` |
| Cloud costs grow unnoticed | Budget overrun | Per-provider monthly caps, AWS budget alarms, cost per bill on dashboard |

## 7. Not in scope for now

- Publishing to Google Play or the Apple App Store.
- Native apps, unless the M1 device gate fails.
- Real HDFC API calls (stub until the bank grants access).
- Marg ERP import (stub until the route is confirmed with Marg support).
