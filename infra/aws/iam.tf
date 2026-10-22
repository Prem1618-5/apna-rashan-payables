# Least-privilege roles.
#   execution role  - used by ECS to pull the image, write logs, read secrets
#   task role       - used by the app: invoice bucket + Textract AnalyzeExpense
#   scheduler role  - monthly redeploy after DB password rotation

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# --- Execution role ----------------------------------------------------------

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  statement {
    sid     = "ReadAppSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [for s in aws_secretsmanager_secret.app : s.arn],
      [aws_db_instance.this.master_user_secret[0].secret_arn],
    )
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "pull-logs-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# --- Task role (what the app itself may do) ----------------------------------

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "InvoiceBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.invoices.arn]
  }

  statement {
    sid       = "InvoiceObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.invoices.arn}/*"]
  }

  statement {
    sid = "TextractExpense"
    # Textract has no resource-level permissions.
    actions   = ["textract:AnalyzeExpense"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "invoices-textract"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# --- Scheduler role (redeploy after DB password rotation) --------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler_redeploy" {
  name               = "${local.name}-scheduler-redeploy"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_redeploy" {
  statement {
    actions   = ["ecs:UpdateService"]
    resources = [aws_ecs_service.app.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_redeploy" {
  name   = "update-service"
  role   = aws_iam_role.scheduler_redeploy.id
  policy = data.aws_iam_policy_document.scheduler_redeploy.json
}
