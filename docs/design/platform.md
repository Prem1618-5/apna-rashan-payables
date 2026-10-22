# Design: cloud, twelve-factor, resilience, security, scale

Status: design · Related: `DECISIONS.md` D-016 to D-020

## 1. Cloud for the beta: AWS Mumbai, kept portable to Azure

**Choice:** AWS, region `ap-south-1` (Mumbai), backups copied to `ap-south-2`
(Hyderabad). Data stays in India (DPDP).

**Why AWS for the beta:** new-account credits and startup programmes, mature
managed Postgres, S3 and secrets, and Textract/Bedrock are available as AI
providers in the same account. Azure Document Intelligence can still be used
as an AI provider from AWS, because providers are called over HTTPS with a key.

**Staying portable:** the app only talks to Postgres, an S3-compatible object
store, a secrets source and HTTPS. Moving to Azure is an infrastructure change
(Terraform), not a code change.

| Need | AWS (beta) | Azure equivalent | Local dev |
|---|---|---|---|
| PWA static files | S3 + CloudFront | Storage static site + Front Door | Vite dev server |
| API + worker (containers) | One EC2 server running Docker Compose (beta); ECS Fargate only if ever needed | Container Apps | Docker Compose |
| Database | RDS PostgreSQL (single-AZ beta → Multi-AZ prod) | Azure Database for PostgreSQL Flexible | Postgres container |
| Invoice images | S3 (versioning, SSE-KMS, Object Lock) | Blob Storage (immutability policy) | MinIO |
| Job queue | pg-boss on the same Postgres | same | same |
| Secrets + encryption keys | Secrets Manager + KMS | Key Vault | `.env` (gitignored) |
| Logs, metrics, alarms | CloudWatch | Azure Monitor | console |
| Edge protection | AWS WAF | Front Door WAF | none |
| Infrastructure as code | Terraform | Terraform | — |

## 2. Twelve-factor, applied to this app

| # | Factor | What we do here |
|---|---|---|
| I | One codebase, many deploys | One monorepo; `dev`, `beta`, `prod` are deploys of the same code |
| II | Declared dependencies | `pnpm-lock.yaml`, Python lock file, pinned Docker base images |
| III | Config in the environment | All config from env vars; secrets injected from Secrets Manager. Same image runs anywhere. `.env.example` documents every variable |
| IV | Backing services are attached resources | Postgres, S3 and AI providers are URLs + credentials in config. Swap MinIO ↔ S3 or one AI provider for another by changing config |
| V | Build, release, run kept separate | CI builds one image per commit (tagged with git SHA). Release = image + config. The **same image** goes dev → beta → prod. Rollback = previous release |
| VI | Stateless processes | No local disk state. Uploads go to S3, sessions to the DB. Any container can die anytime |
| VII | Port binding | Each service serves HTTP on `$PORT` |
| VIII | Scale with process types | `web` (API) and `worker` (extraction). Run more copies of either when needed |
| IX | Disposability | Fast start; on `SIGTERM` finish the current request or job, then exit. Jobs are idempotent so a killed job just re-runs |
| X | Dev/prod parity | Docker Compose runs the same Postgres, S3 API (MinIO) and worker as the cloud |
| XI | Logs as event streams | JSON lines to stdout → CloudWatch. Request IDs across services. Bank numbers and keys redacted at the logger |
| XII | Admin tasks as one-off processes | Migrations, seed, key rotation and re-extraction run as one-off tasks from the same image |

## 3. Resilience: what happens when things break

| Failure | Behaviour |
|---|---|
| Phone offline | Capture keeps working; outbox uploads later (see mobile research) |
| API container crashes | Docker restarts it automatically (`restart: always`); health check alarm |
| AI provider down or out of quota | Router falls back to the next provider, then to local OCR only (see `ai-providers.md`) |
| Worker killed mid-job | Job lease expires and the job re-runs. Idempotency keys stop double effects |
| Job keeps failing | After N retries it goes to a dead-letter list on the admin job screen |
| Database failure | Beta: automated backups + point-in-time restore. Prod: Multi-AZ failover |
| Region-wide outage | Restore from backups copied to Hyderabad. Targets: RPO ≤ 15 min, RTO ≤ 4 h (beta), to be tightened for prod |
| Bad deploy | Health checks block rollout; one-click rollback to the previous release |

Patterns used everywhere: timeouts on every network call, retries with
exponential backoff and jitter (only for safe/idempotent calls), circuit
breakers per external AI provider.

**Enqueue in the same transaction:** because the queue lives in Postgres, saving
"bill verified" and enqueueing "create payable" happen in one database
transaction. Either both happen or neither does. No lost or ghost jobs.

## 4. Security (summary; full threat model in M4)

- **Identity:** staff login bound to a device; owner uses a passkey for login
  and for every approval. Short sessions.
- **Access:** role + store scoping checked in the API on every request. Staff
  never see full account numbers.
- **Data:** TLS everywhere; bank fields encrypted with KMS envelope encryption;
  S3 and RDS encrypted at rest; invoice images write-once (Object Lock).
- **Secrets:** only in Secrets Manager; nothing secret in the repo, image, phone or logs.
- **Infrastructure:** least-privilege IAM role per process type; DB in private
  subnets; WAF and rate limiting at the edge; strict Content-Security-Policy for the PWA.
- **Audit:** append-only, hash-chained audit log for every state change.
- **Supply chain:** lock files, dependency and image scanning in CI, secret scanning.

## 5. Scale: 6 stores today, 100 tomorrow

Brief's target: ~10,000 bills/day, ~30 lines each, ~5,000 vendors.

- API and worker are stateless, so growing means running more copies or a
  bigger server. No code change.
- Postgres: tables keyed by organisation and store; invoice and line tables
  partitioned by month; a read replica for dashboards when needed.
- Images in S3 with lifecycle rules (move to cheaper storage after N months;
  keep as long as the retention policy requires).
- The PWA is served from a CDN, so 100 stores add no server load for app files.
- Adding a store = a row in config plus staff invites. No new infrastructure.

## 6. Environments

| Env | Where | Data | AI providers | Payments |
|---|---|---|---|---|
| dev | laptop, Docker Compose | synthetic | mocks + free tiers (synthetic only) | sample HDFC files only |
| beta | AWS Mumbai, small sizes | real invoices from 1–2 stores first | local OCR + no-training tiers | HDFC bulk file |
| prod | AWS Mumbai, Multi-AZ | all stores | by evaluation results | HDFC bulk file, uploaded by owner |
