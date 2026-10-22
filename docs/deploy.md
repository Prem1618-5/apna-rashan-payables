# Deploying the beta to AWS (Mumbai)

This guide is for the owner or whoever runs the beta. Follow it top to bottom
the first time. After that you only need **Deploy**, **Roll back** and the
other day-to-day sections.

## What gets built

```
 phones (PWA) ──HTTPS──> CloudFront ──HTTP + secret header──> Load balancer ──> App container (ECS Fargate, ARM)
                         (*.cloudfront.net                    (only accepts       API + PWA + worker
                          or your domain)                      CloudFront)          │        │
                                                                                    │        └──> Gemini / Textract
                                                                          Postgres (RDS) ◄──┘──> S3 (invoice images)
```

- **One container** runs the API, serves the app files and runs the extraction worker.
- **Region** ap-south-1 (Mumbai). Data stays in India.
- **Database:** RDS PostgreSQL 16, encrypted, daily backups kept 7 days, not reachable from the internet.
- **Images:** private S3 bucket, versioned, encrypted, HTTPS only.
- **Secrets:** AWS Secrets Manager. You type them in once; they never go in git or Terraform state.
- **Alerts:** email when the app errors, goes down, or the database runs low on space or high on CPU; email when spend reaches 80% and 100% of the monthly budget.

All of it is in `infra/aws/` (Terraform). The image is built from the `Dockerfile`.

## 1. One-time setup

### 1.1 AWS account

1. Create an AWS account at <https://aws.amazon.com>. Turn on MFA for the root user, then stop using root.
2. In the console top-right, pick **Asia Pacific (Mumbai) ap-south-1**.
3. Billing → **Billing preferences**: turn on "Receive AWS Free Tier alerts" and "Receive CloudWatch billing alerts".
   (Terraform also creates a monthly budget with email alerts.)

### 1.2 A login for Terraform (pick one)

- **IAM Identity Center (recommended):** IAM Identity Center → enable → create a user for yourself with the
  `AdministratorAccess` permission set. On your computer: `aws configure sso`, then `aws sso login`.
- **IAM user (simpler):** IAM → Users → Create user → attach `AdministratorAccess` → Security credentials →
  create an access key → `aws configure` (region `ap-south-1`). Keep this key private; delete it when done.

### 1.3 Tools on your computer

- AWS CLI v2 — `aws --version`
- Terraform 1.10 or newer — `terraform version`
- Docker Desktop (with buildx; included) — `docker buildx version`
- git

An Apple Silicon Mac builds the ARM image natively and fast. On an Intel/AMD machine Docker uses emulation (slower, works).

## 2. Create the infrastructure

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars
#   edit terraform.tfvars: at least alert_email, seed_owner_phone, hdfc_client_code
terraform init
terraform apply          # review the plan, type "yes" (takes ~10-15 min, mostly the database)
```

Then:

- **Open your email** and click "Confirm subscription" from AWS Notifications. Without this you get no alarms.
- Optional: keep Terraform state in S3 instead of your laptop — see `infra/aws/backend.tf`.

`terraform output` shows the app URL, the ECR repository and the names you need below.

## 3. Put the secrets

The app will not start until every secret has a value.

```bash
infra/scripts/put-secrets.sh
```

It asks for each one (typing is hidden):

| Secret | What to enter |
|---|---|
| `SESSION_SECRET` | press Enter to generate |
| `DATA_ENCRYPTION_KEY` | press Enter to generate. **Never change it later**: data encrypted with it can't be read with a new key |
| `SEED_OWNER_PIN` | the owner's first login PIN (digits) |
| `GEMINI_API_KEY_1` | key from Google AI Studio (`_2`, `_3` only if `gemini_api_key_count` is 2 or 3) |

Without the script (same effect):

```bash
aws secretsmanager put-secret-value --secret-id apna-rashan/beta/GEMINI_API_KEY_1 --secret-string 'the-key'
```

(Typing a value on the command line leaves it in your shell history; the script avoids that.)

> **Real invoices and free AI tiers.** The beta runs with `data_class = "real"`. Free Gemini tiers may train on
> what is sent to them, so the app blocks real invoices from them. Once billing is enabled on the Gemini key, set
> `gemini_tier = "paid"` in `terraform.tfvars` and `terraform apply`. Textract (`textract_enabled = true`) is the
> other option but costs about $0.01 per page.

## 4. First deploy

From the repo root, on a clean commit:

```bash
infra/scripts/deploy.sh
```

It builds the ARM64 image, pushes it to ECR tagged with the git commit, moves the `latest` tag to it, starts a
rolling deployment and waits until the service is healthy (about 5 minutes). If the new version fails its health
checks, ECS rolls back automatically and the script says so.

### Deploy from GitHub instead (optional)

Terraform created a role GitHub Actions can use (no AWS keys stored in GitHub).

1. GitHub → repo → Settings → Environments → **New environment** `beta`. Optionally add yourself as a required reviewer.
2. In that environment add **Variables** (from `terraform output`): `AWS_DEPLOY_ROLE_ARN` (= `github_deploy_role_arn`),
   `ECR_REPOSITORY_URL`, `ECS_CLUSTER`, `ECS_SERVICE`.
3. Actions → **Deploy (beta)** → Run workflow.

## 5. Open the app

```bash
terraform -chdir=infra/aws output app_url      # e.g. https://d1234abcd.cloudfront.net
curl "$(terraform -chdir=infra/aws output -raw app_url)/api/health"
```

Log in with `seed_owner_phone` and the `SEED_OWNER_PIN`, then change the PIN and add staff.

## 6. Install on phones

Send the `app_url` link to each phone (WhatsApp is fine).

- **Android (Chrome):** open the link → menu ⋮ → **Install app** (or "Add to Home screen").
- **iPhone (Safari only):** open the link in **Safari** → Share button → **Add to Home Screen** → Add.
  Open it from the home-screen icon, not from Safari, so it runs as an app.

## Day to day

### Deploy a new version

```bash
git pull && infra/scripts/deploy.sh
```

### See logs

```bash
aws logs tail /ecs/apna-rashan-beta --follow --since 15m
```

### Roll back

- **Automatic:** a deployment that fails health checks is rolled back by ECS on its own.
- **By hand**, to any earlier build (ECR keeps the last 10):

  ```bash
  aws ecr describe-images --repository-name apna-rashan-beta \
    --query 'sort_by(imageDetails,&imagePushedAt)[].[imagePushedAt,join(`,`,imageTags||[])]' --output table
  infra/scripts/deploy.sh --tag <git-sha-from-the-list>
  ```

  or from GitHub: Actions → Deploy (beta) → Run workflow → enter the tag.

  Database migrations are not undone by a rollback. Migrations should only add things, so the older version still works.

### Restore the database

Backups: automatic daily snapshots + point-in-time restore for the last 7 days. A restore always creates a
**new** database; you then swap it in. Plan for 30-60 minutes of downtime.

```bash
# 0. Names (from terraform output)
CLUSTER=apna-rashan-beta; SERVICE=apna-rashan-beta; DB=apna-rashan-beta

# 1. Stop the app so nothing writes during the swap (min 0 so autoscaling doesn't restart it)
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount --resource-id service/$CLUSTER/$SERVICE \
  --min-capacity 0 --max-capacity 3
aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 0

# 2. Restore to a new instance, to a time just before the problem (UTC)
SG=$(aws rds describe-db-instances --db-instance-identifier $DB \
  --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier $DB --target-db-instance-identifier $DB-restore \
  --restore-time 2026-01-31T09:00:00Z \
  --db-instance-class db.t4g.micro --db-subnet-group-name $DB --vpc-security-group-ids $SG \
  --no-publicly-accessible --manage-master-user-password --deletion-protection
#    (to restore a snapshot instead: aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier ...)
aws rds wait db-instance-available --db-instance-identifier $DB-restore

# 3. Swap names. The address the app uses follows the name, so the app config stays the same.
aws rds modify-db-instance --db-instance-identifier $DB --new-db-instance-identifier $DB-old --apply-immediately
aws rds wait db-instance-available --db-instance-identifier $DB-old
aws rds modify-db-instance --db-instance-identifier $DB-restore --new-db-instance-identifier $DB --apply-immediately
aws rds wait db-instance-available --db-instance-identifier $DB

# 4. Point Terraform at the restored database and apply. This updates the password
#    secret reference and resets the autoscaling minimum to 1.
cd infra/aws
terraform state rm aws_db_instance.this
terraform import aws_db_instance.this $DB
terraform apply

# 5. Start the app again
aws ecs update-service --cluster $CLUSTER --service $SERVICE --desired-count 1 --force-new-deployment
```

When everything checks out, delete `$DB-old` (turn off its deletion protection first). Invoice images in S3 are
not affected by a database restore; S3 versioning keeps overwritten or deleted images.

### Rotate a Gemini key

1. Create a new key in Google AI Studio (keep the old one for now).
2. `infra/scripts/put-secrets.sh GEMINI_API_KEY_1`
3. Restart the app so it reads the new value:
   `aws ecs update-service --cluster apna-rashan-beta --service apna-rashan-beta --force-new-deployment`
4. Check the app extracts a test invoice, then delete the old key in Google AI Studio.

Same for any other secret, except `DATA_ENCRYPTION_KEY` (see section 3).

### Database password

RDS owns the database password and rotates it once a month, in the night after the first Sunday
(Monday 01:30-03:30 IST). The service is redeployed automatically at 04:00 IST to pick up the new password;
in between, new database connections may fail, so the worker may retry a few jobs. If you see database login errors
outside that window, run the `--force-new-deployment` command above.

### One-off admin tasks

Run any command in the same image, e.g. a script from the API (subnet and security group from
`terraform output app_subnet_ids ecs_security_group_id`):

```bash
aws ecs run-task --cluster apna-rashan-beta --launch-type FARGATE --task-definition apna-rashan-beta \
  --network-configuration "awsvpcConfiguration={subnets=[<subnet>],securityGroups=[<ecs-sg>],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","dist/<script>.js"]}]}'
```

## Monthly cost (estimate)

**Estimates only**, ap-south-1, on-demand, low beta traffic (~20 phones, ~200 invoices/day). Prices change;
check with the [AWS Pricing Calculator](https://calculator.aws/) before relying on them. Credits, if you have
them, apply to all of this.

| Item | Size | ~USD / month |
|---|---|---:|
| ECS Fargate (ARM) | 0.25 vCPU / 0.5 GB, 1 task, 24×7 | 8 |
| Application Load Balancer | 1 ALB, very low LCU use | 18-22 |
| Public IPv4 addresses | 2 for the ALB + 1 per running task, $0.005/h each | 11 |
| RDS PostgreSQL | db.t4g.micro single-AZ | 12-15 |
| RDS storage | 20 GB gp3 (backups up to DB size are free) | 2.5-3 |
| CloudFront | first 1 TB/month and 10 M requests are free | 0-1 |
| S3 | ~3 GB new images per month at ~500 KB each | < 1 (grows ~1/yr) |
| Secrets Manager | 5 secrets × $0.40 (7 with three Gemini keys) | 2-3 |
| CloudWatch logs + 6 alarms, ECR, SNS | | 1-3 |
| **Total** | | **≈ 55-65** |

Not included: Gemini (billed by Google), Textract if enabled (~$0.01/page, ≈ $60/month at 200 pages/day),
backup copies to Hyderabad if enabled, extra tasks when autoscaling adds them (~$4 each incl. IPv4).

The default budget is $60, so the 80% email will likely arrive every month. Raise `monthly_budget_usd` to 75 once
the first bill confirms the numbers.

## Add later (and when)

| Add | When | Change | Extra cost |
|---|---|---|---|
| **Multi-AZ database** | Before the app is the only record of what is owed, or when an hour of downtime would hurt (prod) | `db_multi_az = true` | ~+$15 |
| **Backup copy to Hyderabad** | Moving from beta to prod (platform.md: region outage plan) | `enable_backup_replication = true` | ~$1-3 |
| **Custom domain** | Staff need a memorable link, or before the HTTPS-to-origin step | ACM cert in **us-east-1**, then `domain_names` + `acm_certificate_arn`, CNAME to `cloudfront_domain_name` | ~$0 (+ domain) |
| **HTTPS between CloudFront and ALB** | Once there is a custom domain | ACM cert in ap-south-1 on an HTTPS listener, origin `https-only` | $0 |
| **AWS WAF** | Link shared beyond staff, many failed logins, or bot traffic in logs | WAF web ACL on CloudFront with AWS managed rules + rate limit | ~$8-10 |
| **Separate worker service** | Extraction slows the app (p95 latency up, CPU alarm), queue waits > 5 min, or > ~2,000 invoices/day | second ECS service from the same image with `RUN_WORKER=true`, API with `RUN_WORKER=false` | ~$8+ |
| **Bigger task** | CPU above ~70% most of the day or memory errors | `task_cpu = 512`, `task_memory = 1024` | ~+$8 |
| **S3 Object Lock** | Before invoices must be provably unaltered (audit/GST retention) | Object Lock in governance mode on the bucket | $0 |
| **Private subnets + NAT** | A security review requires tasks without public IPs | VPC with private subnets and a NAT gateway (or VPC endpoints) | ~+$35-45 |

## Notes for developers

The infrastructure assumes these things about the app:

- **Config only from env.** Every variable in `.env.example` is set by Terraform (`infra/aws/ecs.tf`) or as a secret.
- **`DATABASE_URL`** is built by `infra/docker/entrypoint.sh` from `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
  `DB_PASSWORD` and `DB_SSLMODE=verify-full`. The image trusts the Amazon RDS CA (`NODE_EXTRA_CA_CERTS`). Pass the
  URL to `pg` as `connectionString` and don't override `ssl`.
- **S3-compatible storage.** Two extra env vars for MinIO/local use, used by `docker-compose.yml`:
  `S3_ENDPOINT` (e.g. `http://minio:9000`; empty = AWS) and `S3_FORCE_PATH_STYLE` (`true` for MinIO).
  On AWS, credentials come from the task role, so the SDK's default credential chain must be used.
- **Behind CloudFront + ALB.** The ALB hop is plain HTTP, so `X-Forwarded-Proto` is `http`. Use
  `CloudFront-Forwarded-Proto` (forwarded to the app) or treat production as HTTPS when setting secure cookies.
  Trust proxy headers for the client IP (`X-Forwarded-For`). The viewer `Host` header is forwarded.
- **Caching.** `/assets/*` is cached by CloudFront using the app's `Cache-Control`: send
  `public, max-age=31536000, immutable` for hashed assets; `no-cache` for `index.html`, `sw.js` and the manifest.
  `/api/*` is never cached.
- **Health:** `GET /api/health` returns 200 quickly with no auth. It is used by the ALB, ECS and Docker.
- **Shutdown:** on `SIGTERM` finish in-flight work and exit within 30 s.
- **Migrations on startup** must be safe when two tasks start at once during a rolling deploy (take a Postgres
  advisory lock).
- **Build output:** `pnpm --filter @arad/api build` → `services/api/dist/server.js`, runnable with plain `node`
  (bundle or compile workspace packages; Node won't strip TypeScript inside `node_modules`). The whole
  `services/api` folder (e.g. `migrations/`) is copied into the image next to `dist/`.
