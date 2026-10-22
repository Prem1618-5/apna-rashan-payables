# Apna Rashan Payables

Invoice-to-payment app for a 6-outlet supermarket chain in Ranchi. Staff capture
paper vendor invoices and verify them by swiping; the owner pays all vendors in
one approved run.

## Read first

- `docs/brief.md` — full requirements
- `docs/PLAN.md` — architecture, milestones, risks
- `DECISIONS.md` — chosen defaults and assumptions
- `docs/research/mobile-platform.md` — why a PWA for iOS + Android
- `docs/design/ai-providers.md` — multi-provider AI router, key handling
- `docs/design/payments.md` — app makes the HDFC file, owner pays in ENet
- `docs/design/hdfc-bulk-file.md` — exact file layout, rules, owner checklist
- `docs/design/platform.md` — AWS beta, twelve-factor, resilience, security, scale

## Key facts

- Not published on any app store. One PWA for iPhone and Android, installed from a link.
- A shared server (API + Postgres + images + OCR) is still required.
- Payment = HDFC ENet bulk upload file made by the app; the owner uploads and authorises in ENet.
- Status: `packages/hdfc-bulk-file` built and tested; the rest is planned (see PLAN.md).

## Commands

```bash
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm --filter @arad/hdfc-bulk-file sample   # sample bank file in packages/hdfc-bulk-file/out/
```

## Conventions

- Money is integer paise, never floats.
- Shared domain logic goes in `packages/core` and is used by both phone and server.
- Every UI string goes through i18n (English + Hindi).
- Test UI in both Chromium and WebKit at phone sizes.
- Never log bank account numbers or personal data. Never commit secrets or real invoices.
- Twelve-factor: all config from env; no local disk state; logs as JSON to stdout.
- AI keys only on the server (secrets store). Never in frontend code.
- The HDFC file layout lives only in `packages/hdfc-bulk-file/src/spec.ts`. Never write bank-file fields anywhere else.
