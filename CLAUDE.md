# Apna Rashan Payables

Invoice-to-payment app for a 6-outlet supermarket chain in Ranchi. Staff capture
paper vendor invoices and verify them by swiping; the owner pays all vendors in
one approved run.

## Read first

- `docs/brief.md` — full requirements
- `docs/PLAN.md` — architecture, milestones, risks
- `DECISIONS.md` — chosen defaults and assumptions
- `docs/research/mobile-platform.md` — why a PWA for iOS + Android

## Key facts

- Not published on any app store. One PWA for iPhone and Android, installed from a link.
- A shared server (API + Postgres + images + OCR) is still required.
- Status: planning (M0 not started). Commands will be added here at M0.

## Conventions

- Money is integer paise, never floats.
- Shared domain logic goes in `packages/core` and is used by both phone and server.
- Every UI string goes through i18n (English + Hindi).
- Test UI in both Chromium and WebKit at phone sizes.
- Never log bank account numbers or personal data. Never commit secrets or real invoices.
