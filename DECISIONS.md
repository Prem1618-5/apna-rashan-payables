# Decisions and assumptions

Each entry: what we chose, why, and what would make us change it.

## D-001 · Platform: one installable PWA for iOS and Android

- **Choice:** React + TypeScript + Vite PWA, installed from a link (Android:
  "Install app"; iPhone: Add to Home Screen). No app store.
- **Why:** the only no-store route on iPhone that needs no Apple developer account,
  no device registration and no yearly renewal; avoids Android sideload
  verification friction; instant updates; matches brief §9.
- **Revisit if:** the M1 device gate shows camera, storage or upload failing on
  staff phones, or background upload becomes essential.
- **Fallback:** wrap the same code with Capacitor. Android: sideload APK.
  iPhone: Apple Developer Program ad hoc ($99/yr, up to 100 devices/yr).
- Details: `docs/research/mobile-platform.md`.

## D-002 · "Local on the phone" means offline-capable app + one shared server

- **Assumption:** the owner wants the app on phones without any store, not a
  system with no server. A shared server is required so 6+ stores and the owner
  see the same data and the owner can approve payments for all stores.
- **Revisit if:** the owner actually wants a single-phone, single-store tool.

## D-003 · Hosting: superseded by D-016 (AWS Mumbai for beta)

- Originally a VPS in India. Still valid as a low-cost fallback because the app
  is twelve-factor and runs anywhere Docker runs.

## D-004 · Backend language: TypeScript (Fastify); extraction worker in Python

- **Why:** shared `packages/core` (money, GST maths, state machine) runs on phone
  and server; Python has the best OCR libraries (PaddleOCR, Tesseract bindings).

## D-005 · Queue: Postgres-based (pg-boss), no Redis

- **Why:** one less service to run and back up at this scale (~10k bills/day).

## D-006 · One web app for staff and owner

- **Choice:** single PWA with role-based shells instead of separate apps.
- **Why:** the owner approves payouts from their phone too; one install, one codebase.

## D-007 · QR decoding with zxing-wasm on both platforms

- **Why:** Safari does not support the `BarcodeDetector` API, so one library
  everywhere gives identical behaviour.

## D-008 · Owner second factor: passkeys (WebAuthn), TOTP fallback

- **Why:** Face ID / fingerprint works in the browser on both iOS and Android.

## D-009 · Money as integer paise

- From brief §7. Never floats.

## D-010 · AI keys live only on the server

- **Choice:** keys stored in the cloud secrets store, added via admin Settings,
  shown masked. Never in the PWA, the repo, the database in plain text or logs.
- **Why:** anything on a phone can be extracted and abused.

## D-011 · Multi-provider router with fallback to local OCR

- **Choice:** providers behind one interface; two independent extractors per
  invoice plus local OCR; fallback on quota or errors; circuit breakers; budget caps.
- **Why:** free tiers run out and providers go down; the system must slow down, not stop.
- Details: `docs/design/ai-providers.md`.

## D-012 · No real invoices to AI tiers that train on input

- **Choice:** each provider declares `trainsOnInput`; real data is blocked from
  such providers unless the owner explicitly allows it (audit-logged).
- **Also:** one account per provider; no multiple free accounts to dodge limits.

## D-013 · Beta payments: HDFC bulk upload file

- **Why:** no integration approval needed; HDFC's own OTP is a second lock.
- **Revisit when:** HDFC API Banking access is granted (D-014).

## D-014 · Production payments: HDFC API Banking behind `BankAdapter`

- Payout platforms (RazorpayX, Cashfree, others) are a fallback only; HDFC is
  not confirmed as their partner bank and they add a counterparty and fees.

## D-015 · Penny-drop verification API from day one

- Used to verify vendor bank accounts even while payments go by file.
- Provider picked at M4 after checking current price and terms.

## D-016 · Beta cloud: AWS Mumbai (ap-south-1), backups to Hyderabad

- **Why:** credits, managed Postgres/S3/secrets, AI services in the same account,
  data in India. Portable to Azure through Terraform and twelve-factor config.

## D-017 · Containers on ECS Fargate; Terraform for infrastructure

- **Why:** no servers to patch, per-process-type scaling, same images as local
  Docker Compose. Terraform keeps the Azure option open.

## D-018 · Twelve-factor as a hard rule

- Config only from env; one image promoted through dev → beta → prod; stateless
  processes; logs to stdout. Details: `docs/design/platform.md`.

## D-019 · Payment timeouts are never blindly retried

- After a timeout, query status by idempotency key before any resend.

## D-020 · Separate worker pools for extraction and payments (bulkheads)

- A backlog of extraction jobs can never delay payment processing.

## Open questions for the owner (not blocking)

1. Which phone models and iOS/Android versions do staff and the owner use?
2. Is AWS fine for the beta, or is there a reason to prefer Azure (existing credits, account)?
3. Is the ERP really Marg, and which version?
4. Does the HDFC account have corporate net banking bulk upload? API banking?
   Please ask the relationship manager for the bulk-upload file format.
5. Which AI provider accounts already exist?
