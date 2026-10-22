# App secrets. Terraform creates only the empty secret containers; values are
# put out-of-band (infra/scripts/put-secrets.sh, or
# `aws secretsmanager put-secret-value`) so they never land in Terraform state.
#
# Every secret listed here is injected into the container, and ECS refuses to
# start a task while any of them has no value. Put all values before the
# first deploy.

locals {
  app_secret_names = concat(
    ["SESSION_SECRET", "DATA_ENCRYPTION_KEY", "SEED_OWNER_PIN"],
    [for i in range(1, var.gemini_api_key_count + 1) : "GEMINI_API_KEY_${i}"],
  )

  secret_prefix = "${var.project}/${var.env}"
}

resource "aws_secretsmanager_secret" "app" {
  for_each = toset(local.app_secret_names)

  name                    = "${local.secret_prefix}/${each.key}"
  description             = "${each.key} for ${local.name} (value set out-of-band)"
  recovery_window_in_days = 7
}
