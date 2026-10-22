# PostgreSQL 16, single-AZ, encrypted, not public. The master password is
# generated and stored by RDS in Secrets Manager (manage_master_user_password),
# so it never appears in Terraform state. The container gets it through ECS
# `secrets` (DB_PASSWORD) and builds DATABASE_URL at startup
# (infra/docker/entrypoint.sh).

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = data.aws_subnets.default.ids
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name                     = var.db_name
  username                    = var.db_username
  manage_master_user_password = true
  port                        = 5432

  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_encrypted     = true

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # Times in UTC: backups 01:30-02:00 IST, maintenance Mon 02:15-02:45 IST.
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "20:00-20:30"
  maintenance_window      = "sun:20:45-sun:21:15"
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade   = true
  allow_major_version_upgrade  = false
  apply_immediately            = false
  performance_insights_enabled = false

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"
}

# --- Master password rotation -------------------------------------------------
# RDS rotates its managed secret every 7 days by default. A running task keeps
# the password it was started with, so new DB connections would fail after a
# rotation until the next deploy. We therefore rotate on a fixed monthly night
# window and redeploy the service right after it (scheduler below), so tasks
# pick up the new password. Long term the API could re-read the secret on
# auth failure (see docs/deploy.md).

resource "aws_secretsmanager_secret_rotation" "db_master" {
  secret_id          = aws_db_instance.this.master_user_secret[0].secret_arn
  rotate_immediately = false

  rotation_rules {
    schedule_expression = var.db_password_rotation_schedule
    duration            = "2h"
  }
}

resource "aws_scheduler_schedule" "redeploy_after_db_rotation" {
  name                         = "${local.name}-redeploy-after-db-rotation"
  description                  = "Force a new ECS deployment after the monthly DB password rotation window"
  schedule_expression          = var.db_password_redeploy_schedule
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:${data.aws_partition.current.partition}:scheduler:::aws-sdk:ecs:updateService"
    role_arn = aws_iam_role.scheduler_redeploy.arn
    input = jsonencode({
      Cluster            = aws_ecs_cluster.this.name
      Service            = aws_ecs_service.app.name
      ForceNewDeployment = true
    })

    retry_policy {
      maximum_retry_attempts = 3
    }
  }
}

# --- Optional: copy automated backups to Hyderabad ------------------------------

resource "aws_kms_key" "backup_replica" {
  count                   = var.enable_backup_replication ? 1 : 0
  provider                = aws.backup
  description             = "${local.name} RDS backup replicas"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_db_instance_automated_backups_replication" "this" {
  count                  = var.enable_backup_replication ? 1 : 0
  provider               = aws.backup
  source_db_instance_arn = aws_db_instance.this.arn
  retention_period       = var.db_backup_retention_days
  kms_key_id             = aws_kms_key.backup_replica[0].arn
}
