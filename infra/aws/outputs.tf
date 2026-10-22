output "app_url" {
  description = "Open this on the phones (HTTPS)."
  value       = local.use_custom_domain ? "https://${var.domain_names[0]}" : "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "cloudfront_domain_name" {
  description = "Point a custom domain's CNAME here."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.this.id
}

output "aws_region" {
  value = var.aws_region
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "image_tag" {
  description = "The mutable tag the service runs (deploy.sh moves it)."
  value       = var.image_tag
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "app_subnet_ids" {
  description = "Subnets the service runs in (for one-off `aws ecs run-task`)."
  value       = local.app_subnet_ids
}

output "ecs_security_group_id" {
  description = "Security group for app tasks (for one-off `aws ecs run-task`)."
  value       = aws_security_group.ecs.id
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.app.name
}

output "s3_bucket_name" {
  value = aws_s3_bucket.invoices.bucket
}

output "rds_endpoint" {
  value = aws_db_instance.this.address
}

output "rds_instance_id" {
  value = aws_db_instance.this.identifier
}

output "rds_master_secret_arn" {
  description = "RDS-managed secret holding the master username/password."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "app_secret_names" {
  description = "Secrets to fill with infra/scripts/put-secrets.sh before the first deploy."
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.name }
}

output "secret_prefix" {
  value = local.secret_prefix
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable in the GitHub 'beta' environment."
  value       = local.github_enabled ? aws_iam_role.github_deploy[0].arn : null
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
