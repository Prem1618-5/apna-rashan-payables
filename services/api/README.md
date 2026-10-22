# @arad/api

The Apna Rashan Payables server: Fastify 5 + Postgres. It implements the HTTP contract in
`packages/core/src/api.ts`, runs the extraction worker, and serves the built PWA.

## Run locally

```bash
pnpm install
scripts/dev-db.sh                         # Postgres 16 in ./data/pg on :5432 (arad/arad, db arad); `stop` to stop
cp .env.example .env                      # then set HDFC_CLIENT_CODE etc. as needed
pnpm --filter @arad/api seed              # demo data (dev only). Add `-- --reset` to wipe and reseed
pnpm --filter @arad/api dev               # http://localhost:8080 (migrations run on start)
curl localhost:8080/api/health
```

Demo logins after seeding: owner `9000000001` / PIN `1234`; staff `9000000011` … `9000000016` /
PIN `1111` (one per store, S01–S06).

Production: `pnpm --filter @arad/api build` bundles `src/` plus the `@arad/*` workspace packages
into `dist/` (esbuild; npm deps stay external), then `node services/api/dist/server.js`.
A separate worker process is `node services/api/dist/worker-main.js` (set `RUN_WORKER=false` on the API).

| Script | What it does |
|---|---|
| `dev` | `tsx watch` the server, loading `../../.env` if present |
| `build` | type-check, then bundle `dist/server.js`, `worker-main.js`, `migrate-cli.js`, `seed-cli.js` |
| `start` / `start:worker` | run the bundles with plain node |
| `migrate` | apply `migrations/NNN_*.sql` (also done on every start) |
| `seed` | development data; refuses `NODE_ENV=production` |
| `test` / `test:integration` | vitest: unit + integration tests against a real Postgres |
| `typecheck` | `tsc --noEmit` |

Tests start a throwaway Postgres cluster (from `/usr/lib/postgresql/16/bin`, as the `postgres` user
when run as root) and give every test file its own database cloned from a migrated template, so
files run in parallel. In CI, set `TEST_DATABASE_URL` to an admin URL of an existing server instead.
`TEST_LOG=error` prints server logs while debugging a test.

## Configuration

Everything comes from environment variables (see the repo's `.env.example`), parsed and validated
once in `src/config.ts`; the process exits with code 78 and a list of every problem if any is wrong.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | development | `production` makes cookies `Secure`, enables HSTS, requires real secrets |
| `PORT` | 8080 | |
| `LOG_LEVEL` | info | pino JSON to stdout |
| `WEB_DIST` | — | built PWA folder (absolute or repo-relative); served with SPA fallback if it has `index.html` |
| `RUN_WORKER` | true | run the extraction worker in the API process |
| `DATABASE_URL` | required | passed to `pg` as `connectionString` as-is (use `sslmode=` in the URL) |
| `DATABASE_POOL_MAX` | 10 | *new* |
| `STORAGE_DRIVER` | fs | `fs` (dev) or `s3` |
| `STORAGE_DIR` | data/uploads | for `fs`; repo-relative paths resolve from the workspace root |
| `S3_BUCKET`, `AWS_REGION` | —, ap-south-1 | for `s3`; credentials from the AWS SDK default chain (task role) |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | —, false | *new*, for MinIO / S3-compatible stores |
| `SESSION_SECRET` | required | ≥ 32 chars; session tokens are stored as HMAC(secret, token) |
| `DATA_ENCRYPTION_KEY` | required in prod | 32 bytes, base64 or hex. AES-256-GCM for account numbers and bank files. Dev derives one from `SESSION_SECRET` with a warning |
| `EXTRACTOR` | auto | `mock` = deterministic fixture; `auto` = `@arad/extraction` (`createExtractor(env)`), falling back to the mock outside production |
| `DATA_CLASS` | synthetic | passed to the extractor |
| `HDFC_CLIENT_CODE` | — | needed to approve a run |
| `RTGS_FROM_PAISE` | 20000000 | |
| `COOLING_OFF_HOURS` | 24 | new bank accounts are unpayable for this long after approval |
| `REQUIRE_DIFFERENT_APPROVER` | true | the preparer of a run cannot approve it |
| `LOGIN_RATE_LIMIT_PER_MIN` | 10 | *new*; per client IP (X-Forwarded-For is trusted) |
| `SEED_OWNER_NAME/PHONE/PIN` | — | first boot: creates the owner when there are no users |
| `APP_VERSION` / `GIT_SHA` | — | reported by `/api/health` |

## Routes

All under `/api`, JSON unless noted, session cookie `sid` (httpOnly, SameSite=Lax, Secure in
production, 12 h sliding). Errors are `{ error: { code, message, details? } }`.
Roles: **any** = logged-in user (staff limited to their stores), **owner** = owner only.

| Route | Who | Notes |
|---|---|---|
| `GET /health` | public | DB ping, 503 if down |
| `POST /auth/login`, `POST /auth/logout`, `GET /me`, `PUT /me/lang` | public / any | login is rate limited; 5 wrong PINs lock the account 15 min (423) |
| `GET /stores` · `POST /stores` | any · owner | staff see their stores |
| `GET /users` · `POST /users` | owner | |
| `POST /documents` | any | multipart: `storeId`, `clientId` (uuid), `qr` (JSON string[]), `page` × 1–10 (JPEG/PNG/WebP, or one PDF, ≤ 8 MB each). 201 new, 200 replay of the same `clientId` |
| `GET /documents/:id/pages/:n` | any | page bytes, `n` is 1-based |
| `GET /invoices` | any | `state` (comma list), `storeId`, `q`, `limit` ≤ 200, `cursor` |
| `GET /invoices/:id` | any | `InvoiceDetail` |
| `POST /invoices/:id/lock-total` | any | blind total entry |
| `PUT /invoices/:id/header`, `PUT /invoices/:id/lines/:lineId`, `POST /invoices/:id/lines` | any | |
| `POST /invoices/:id/seal` | any | 409 `TOTAL_NOT_LOCKED` / `NOT_BALANCED` / `CHECKS_FAILED` / `VENDOR_REQUIRED` / `DUPLICATE_INVOICE` |
| `POST /invoices/:id/reject` · `hold` · `unhold` · `re-extract` | any | rejecting/unholding a verified bill is owner-only |
| `GET /vendors`, `GET /vendors/:id`, `POST /vendors`, `PUT /vendors/:id` | any | staff-created vendors are PENDING; staff can edit only PENDING ones; 409 `DUPLICATE_VENDOR` on same GSTIN / PAN / account |
| `POST /vendors/:id/approve` | owner | |
| `POST /vendors/:id/bank` | any | new PENDING version; typed twice; IFSC checked |
| `POST /vendors/:id/bank/:versionId/approve` | owner | supersedes the old version, starts cooling-off |
| `GET /payables?due=overdue\|today\|week\|all` | any | staff: their stores only |
| `POST /payment-runs`, `GET /payment-runs`, `GET /payment-runs/:id` | any | staff see runs they prepared |
| `POST /payment-runs/:id/approve` | owner | generates the HDFC file (once) |
| `GET /payment-runs/:id/file`, `GET /payment-runs/:id/advice.csv` | owner | attachments |
| `POST /payment-runs/:id/mark-uploaded`, `mark-paid`, `items/:itemId/mark-failed` | owner | |
| `POST /payment-runs/:id/cancel` | owner, or preparer while DRAFT | only before UPLOADED |
| `GET /dashboard`, `GET /settings`, `GET /audit?entity=&id=` | owner | |

Behaviour notes for the web app:

- **Blind total:** until `lock-total` succeeds, `InvoiceDetail.totals.grandTotalPaise` (and
  `qr.totalPaise`) are `0` and `totalsMeta.grandTotalPaise.reason` is `"hidden_until_locked"`.
- `capturedBy`, `verifiedBy`, `preparedBy`, `approvedBy`, `createdBy` and `AuditEntry.actor` are
  display **names**, not user ids.
- A bill the machine could not read (`EXTRACTION_FAILED`) is verified by typing the header and
  adding lines; its typed total locks on the first try (flagged).

## Data model

```
stores ─┬─< user_stores >── users ──< sessions            (token stored as HMAC)
        │
        ├─< documents (client_id UNIQUE, page sha256[], qr payloads, replayed response)
        │       │ 1:1
        └─< invoices ── state, header columns, totals (bigint paise), *_meta jsonb, checks,
                │        locked_total, lock_attempts, due_date, duplicate_of → invoices
                ├─< invoice_lines (qty_milli, paise, gst_rate_bp, status, meta, box, original)
                ├─< verification_events (action, ms_since_prev)
                └── vendor_id → vendors (gstin UNIQUE, pan, terms, PENDING/ACTIVE/BLOCKED)
                                   └─< vendor_bank_accounts (version, account AES-GCM + HMAC index,
                                         last4, ifsc, bene_code, PENDING/APPROVED/SUPERSEDED/REJECTED,
                                         usable_from; ONE APPROVED per vendor — partial unique index)

payment_runs (ref UNIQUE, DRAFT→APPROVED→UPLOADED→PAID | CANCELLED, file name/encrypted content/
              sha256/control, UNIQUE(value_date, file_sequence))
   └─< payment_run_items (vendor, bank account version, amount > 0, customer_ref UNIQUE, txn_type,
              PENDING/PAID/FAILED, utr)
          └─< payment_run_bills (invoice, signed amount, active)
                 partial UNIQUE (invoice_id) WHERE active  → a bill is in at most one open run

jobs (type, payload, queued/running/done/dead, attempts, run_at, locked_until, dedupe_key)
audit_log (id, prev_hash, hash = sha256(prev_hash || row content); chained by trigger,
           UPDATE/DELETE/TRUNCATE rejected; audit_verify() checks the chain)
schema_migrations
```

## How it works

- **Capture** stores pages (content-hashed) through the `Storage` driver, parses QR codes with
  `classifyQr` (an e-invoice QR pre-fills the header; a UPI QR is never used as bank details),
  checks for duplicates (same image hash, same IRN), and creates the invoice plus its `extract`
  job in one transaction. Duplicates are kept as `DUPLICATE` with `duplicateOf`.
- **Worker** claims jobs with `FOR UPDATE SKIP LOCKED`, renews its lease while running, retries
  with exponential backoff, and marks a job `dead` after its max attempts (extract: 3 → bill
  `EXTRACTION_FAILED`). On SIGTERM it stops claiming, waits for the running job, and releases
  leases. The extract job merges the result (QR header wins), links or auto-creates a PENDING
  vendor by seller GSTIN, sets the due date from the vendor's terms, detects same
  seller + number + financial year duplicates, and runs `runChecks`.
- **Payment runs** use `consolidate` + `generateBulkFile` from `@arad/hdfc-bulk-file`. The file is
  generated once at approval, stored encrypted with its SHA-256, and re-downloads are verified
  against that hash. Warnings: new vendor, recent bank change, amount > 3× the vendor's median,
  possible duplicate bill numbers, bank not ready (blocks approval), same preparer.
- **Security:** scrypt PINs, rate-limited login with lockout, role + store scope on every route,
  helmet CSP (`script-src 'self' 'wasm-unsafe-eval'`, images `self blob: data:`, no inline
  scripts), `Permissions-Policy: camera=(self)`, logs redact cookies, PINs, phone and account
  numbers. Every state change writes an audit row in the same transaction.
