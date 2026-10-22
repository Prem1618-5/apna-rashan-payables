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

## D-003 · Hosting: VPS in India by default

- **Choice:** Docker Compose on a small Linux VPS in an Indian region, HTTPS via
  Let's Encrypt. Head-office PC + tunnel is the documented alternative.
- **Why:** HTTPS is mandatory for camera/offline/install on iPhone; always-on;
  keeps data in India (DPDP).

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

## Open questions for the owner (not blocking)

1. Which phone models and iOS/Android versions do staff and the owner use?
2. VPS or head-office PC for the server?
3. Is the ERP really Marg, and which version?
4. Does the HDFC account have corporate net banking bulk upload? API banking?
