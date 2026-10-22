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
- **Also:** several keys per provider are supported (`GEMINI_API_KEY_1..N`) and
  tried in order when one hits a limit. Keys from separate accounts used only to
  get around free limits can break provider terms; prefer one paid key for real data.

## D-013 to D-015 · Superseded by D-021

- HDFC API Banking, payout platforms and penny-drop verification are out of
  scope. The app stops at the bank file.

## D-016 · Beta cloud: AWS Mumbai (ap-south-1), backups to Hyderabad

- **Why:** credits, managed Postgres/S3/secrets, AI services in the same account,
  data in India. Portable to Azure through Terraform and twelve-factor config.

## D-017 · Beta compute: one ECS Fargate service behind ALB + CloudFront

- **Choice:** one ARM64 Fargate task (0.25 vCPU / 0.5 GB) running API + PWA +
  worker, default VPC public subnets (no NAT), ALB reachable only from
  CloudFront, CloudFront gives HTTPS without buying a domain. RDS PostgreSQL
  db.t4g.micro single-AZ, S3, Secrets Manager. Terraform in `infra/aws`.
- **Why (AWS startup guidance, pre-revenue stage):** no servers to patch, git-push
  deploys, rolling deploy with auto-rollback, roughly $45/month. Plain RDS is 4x
  cheaper than Aurora Serverless at this size.
- **Add later, with triggers:** Multi-AZ RDS (paying users/SLA), separate worker
  service (extraction backlog > 5 min), custom domain + WAF (abuse or many stores).

## D-018 · Twelve-factor as a hard rule

- Config only from env; one image promoted through dev → beta → prod; stateless
  processes; logs to stdout. Details: `docs/design/platform.md`.

## D-019, D-020 · Withdrawn

- They covered bank API timeouts and separate payment workers, which no longer exist.

## D-021 · The app makes the HDFC file; HDFC makes the payment

- **Choice:** the app's payment work ends at generating the ENet bulk upload file
  and its control totals. The owner uploads and authorises in HDFC ENet.
- **Why:** simplest correct solution; no bank integration to approve or maintain;
  HDFC's own OTP is the final lock; our app can never move money.
- Details: `docs/design/payments.md`, `docs/design/hdfc-bulk-file.md`.

## D-022 · File layout `hdfc-enet-vendor-payment-v1`, kept in one file

- **Choice:** the widely used 28-column ENet vendor-payment layout: bare CSV, no
  header, CRLF, ASCII, 2 MB limit, file name `{CLIENT}{DD}{MM}.{SEQ}`.
- **Why:** HDFC does not publish the layout publicly; this matches every public fact found.
- **Must do before real use:** compare with the official template from ENet or the
  RM, then do a ₹1 test run. Any difference is fixed in `spec.ts` only.

## D-023 · Scope cut: accuracy first, extras later

- **Kept:** capture, QR, two extractors, maths checks, blind total, swipe
  verify, vendor master, payables, HDFC file, simple owner dashboard.
- **Later:** gamification, calibration cards, second reviewer, auto bank
  reconciliation, Marg/Tally adapters (generic CSV export stays).

## Open questions for the owner (not blocking)

1. Which phone models and iOS/Android versions do staff and the owner use?
2. Is AWS fine for the beta, or is there a reason to prefer Azure (existing credits, account)?
3. Is the ERP really Marg, and which version?
4. Is ENet bulk upload enabled on the HDFC account? Please get the current bulk
   vendor-payment template + a sample file and the client code from the RM.
   Do beneficiaries need to be registered in ENet before a bulk upload?
5. Which AI provider accounts already exist?
