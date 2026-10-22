# Apna Rashan Payables

Paper vendor invoice → verified digital bill → one HDFC bulk payment file.
An installable phone app (iPhone + Android, no app store) for a 6-store supermarket chain in Ranchi.

**Try it locally**

```bash
pnpm install
cp .env.example .env              # fill SESSION_SECRET, DATA_ENCRYPTION_KEY, GEMINI_API_KEY_1..3
pnpm db && pnpm seed              # local Postgres + demo data
pnpm --filter @arad/web build && pnpm --filter @arad/api build
node services/api/dist/server.js  # open http://localhost:8080
```

Demo logins: owner `9000000001` / PIN `1234`, staff `9000000011` / PIN `1111`.

| Part | Folder |
|---|---|
| Phone app (PWA) | `apps/web` |
| API + background worker | `services/api` |
| AI extraction (Gemini, Textract) | `packages/extraction` |
| Shared maths, checks, API contract | `packages/core` |
| HDFC ENet bulk file | `packages/hdfc-bulk-file` |
| Synthetic invoices, accuracy eval | `tools/` |
| AWS (Terraform), Docker, CI | `infra/`, `Dockerfile`, `.github/` |

Start with `docs/PLAN.md`, `DECISIONS.md` and `docs/deploy.md`.
