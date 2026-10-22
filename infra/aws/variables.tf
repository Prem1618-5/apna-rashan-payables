# ---------------------------------------------------------------------------
# Naming, region, alerts
# ---------------------------------------------------------------------------

variable "project" {
  description = "Short project name, used in resource names and the Project tag."
  type        = string
  default     = "apna-rashan"
}

variable "env" {
  description = "Environment name, used in resource names and the Env tag."
  type        = string
  default     = "beta"
}

variable "aws_region" {
  description = "Main region. Mumbai keeps data in India."
  type        = string
  default     = "ap-south-1"
}

variable "backup_region" {
  description = "Region that RDS automated backups are copied to when enable_backup_replication is true."
  type        = string
  default     = "ap-south-2"
}

variable "extra_tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}

variable "alert_email" {
  description = "Email address for alarms and budget alerts. You must click the confirmation link AWS sends."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a valid email address."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly AWS budget in USD. Emails at 80% and 100% of actual spend, and at 100% forecast."
  type        = number
  default     = 60
}

# ---------------------------------------------------------------------------
# Container / ECS
# ---------------------------------------------------------------------------

variable "container_port" {
  description = "Port the app listens on inside the container ($PORT)."
  type        = number
  default     = 8080
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of tasks to start with. Autoscaling may raise it up to max_count."
  type        = number
  default     = 1
}

variable "max_count" {
  description = "Maximum number of tasks the CPU autoscaling policy may run."
  type        = number
  default     = 3
}

variable "autoscaling_cpu_target" {
  description = "Average CPU percentage the service autoscaling tries to hold."
  type        = number
  default     = 70
}

variable "image_tag" {
  description = "Mutable ECR tag the task definition runs. deploy.sh moves this tag to each new build and forces a new deployment."
  type        = string
  default     = "latest"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the app."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------
# App settings (plain env vars; see .env.example). Secrets are in secrets.tf.
# ---------------------------------------------------------------------------

variable "log_level" {
  type    = string
  default = "info"
}

variable "run_worker" {
  description = "Run the extraction worker inside the API process."
  type        = bool
  default     = true
}

variable "data_class" {
  description = "\"synthetic\" or \"real\". With \"real\", providers that train on input are blocked unless ai_allow_training_providers_for_real_data is true."
  type        = string
  default     = "real"

  validation {
    condition     = contains(["synthetic", "real"], var.data_class)
    error_message = "data_class must be \"synthetic\" or \"real\"."
  }
}

variable "extractor" {
  description = "\"auto\" (use configured providers) or \"mock\" (deterministic fake, demo only)."
  type        = string
  default     = "auto"
}

variable "gemini_model" {
  type    = string
  default = "gemini-flash-latest"
}

variable "gemini_second_model" {
  type    = string
  default = "gemini-pro-latest"
}

variable "gemini_tier" {
  description = "\"free\" tiers may train on input, so real invoices are blocked from them. Set \"paid\" once billing is on for the Gemini key."
  type        = string
  default     = "free"
}

variable "gemini_api_key_count" {
  description = "How many GEMINI_API_KEY_n secrets to create and inject (1-3). Each one must have a value before the service can start."
  type        = number
  default     = 1

  validation {
    condition     = var.gemini_api_key_count >= 1 && var.gemini_api_key_count <= 3
    error_message = "gemini_api_key_count must be 1, 2 or 3."
  }
}

variable "textract_enabled" {
  description = "Use Amazon Textract AnalyzeExpense as an extractor (the task role already allows it)."
  type        = bool
  default     = false
}

variable "ai_allow_training_providers_for_real_data" {
  type    = bool
  default = false
}

variable "hdfc_client_code" {
  type    = string
  default = "ARAD01"
}

variable "rtgs_from_paise" {
  description = "Payments at or above this amount (paise) go by RTGS."
  type        = number
  default     = 20000000
}

variable "cooling_off_hours" {
  type    = number
  default = 24
}

variable "require_different_approver" {
  type    = bool
  default = true
}

variable "seed_owner_name" {
  description = "First run only: name of the owner account created when no users exist."
  type        = string
  default     = "Owner"
}

variable "seed_owner_phone" {
  description = "First run only: phone number of the owner account. The PIN is a secret (SEED_OWNER_PIN)."
  type        = string
  default     = "9000000001"
}

variable "extra_environment" {
  description = "Extra or overriding plain env vars for the container (never put secrets here)."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_engine_version" {
  description = "PostgreSQL major version; AWS picks and auto-upgrades the minor version."
  type        = string
  default     = "16"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GB."
  type        = number
  default     = 100
}

variable "db_name" {
  type    = string
  default = "arad"
}

variable "db_username" {
  type    = string
  default = "arad"
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_deletion_protection" {
  description = "Keep true. Set false only right before you intend to destroy the database."
  type        = bool
  default     = true
}

variable "db_multi_az" {
  description = "Standby in a second AZ (roughly doubles DB cost). See docs/deploy.md 'Add later'."
  type        = bool
  default     = false
}

variable "db_password_rotation_schedule" {
  description = "When RDS rotates the master password (Secrets Manager schedule expression, UTC). Default: first Sunday of the month, 20:00 UTC (01:30 IST Monday)."
  type        = string
  default     = "cron(0 20 ? * SUN#1 *)"
}

variable "db_password_redeploy_schedule" {
  description = "When the service is redeployed to pick up the rotated password (EventBridge Scheduler cron, UTC). Must fall after the rotation window ends."
  type        = string
  default     = "cron(30 22 ? * SUN#1 *)"
}

variable "enable_backup_replication" {
  description = "Copy RDS automated backups to backup_region (adds snapshot storage + transfer cost)."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Edge (CloudFront)
# ---------------------------------------------------------------------------

variable "domain_names" {
  description = "Optional custom domain names (e.g. [\"pay.example.in\"]). Leave empty to use the *.cloudfront.net address."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering domain_names. Required when domain_names is not empty."
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:us-east-1:", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be an ACM certificate in us-east-1 (CloudFront requirement)."
  }
}

variable "cloudfront_price_class" {
  description = "PriceClass_200 includes India edge locations (PriceClass_100 does not)."
  type        = string
  default     = "PriceClass_200"
}

# ---------------------------------------------------------------------------
# GitHub Actions deploy (OIDC)
# ---------------------------------------------------------------------------

variable "github_repo" {
  description = "owner/repo allowed to assume the deploy role. Empty string disables the GitHub deploy role."
  type        = string
  default     = "Prem1618-5/apna-rashan-payables"
}

variable "github_deploy_environment" {
  description = "GitHub Actions environment the deploy job runs in; only that environment can assume the role."
  type        = string
  default     = "beta"
}

variable "create_github_oidc_provider" {
  description = "Create the account-wide GitHub OIDC provider. Set false if the account already has one."
  type        = bool
  default     = true
}
