# GitHub Actions deploy role via OIDC (no long-lived AWS keys in GitHub).
# Only the "beta" environment of var.github_repo can assume it, and it can
# only push to this ECR repository and redeploy this one ECS service.

locals {
  github_enabled  = var.github_repo != ""
  github_oidc_url = "token.actions.githubusercontent.com"
  github_oidc_provider_arn = local.github_enabled ? (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/${local.github_oidc_url}"
  ) : ""
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = local.github_enabled && var.create_github_oidc_provider ? 1 : 0
  url            = "https://${local.github_oidc_url}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  count = local.github_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values   = ["repo:${var.github_repo}:environment:${var.github_deploy_environment}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count                = local.github_enabled ? 1 : 0
  name                 = "${local.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_assume[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushThisRepo"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "DeployThisService"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.app.arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count  = local.github_enabled ? 1 : 0
  name   = "ecr-push-ecs-deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy.json
}
