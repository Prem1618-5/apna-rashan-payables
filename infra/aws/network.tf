# Default VPC, public subnets, no NAT gateway (cost). Tasks get a public IP
# for outbound calls (ECR, Secrets Manager, S3, Gemini), but their security
# group only accepts traffic from the ALB, and the ALB only from CloudFront.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# ALB and tasks use two AZs (the ALB minimum). Every ALB node holds a public
# IPv4 address billed hourly, so a third AZ adds cost but little for a beta.
# (Each default subnet is in a different AZ.) RDS's subnet group uses all.
locals {
  app_subnet_ids = slice(sort(data.aws_subnets.default.ids), 0, 2)
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# --- ALB: inbound HTTP only from CloudFront origin-facing IPs ---------------
# Note: this prefix list counts as ~55 rules against the default limit of 60
# rules per security group, so keep this group to this one ingress rule.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTP from CloudFront only"
  vpc_id      = data.aws_vpc.default.id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from CloudFront origin-facing servers"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ecs" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To app tasks"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = aws_security_group.ecs.id
}

# --- ECS tasks: inbound only from the ALB ------------------------------------

resource "aws_security_group" "ecs" {
  name        = "${local.name}-ecs"
  description = "App tasks: inbound from ALB only"
  vpc_id      = data.aws_vpc.default.id

  tags = { Name = "${local.name}-ecs" }
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = aws_security_group.ecs.id
  description                  = "App port from ALB"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "ecs_all" {
  security_group_id = aws_security_group.ecs.id
  description       = "Outbound HTTPS to AWS APIs and AI providers, Postgres to RDS"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- RDS: inbound only from the app tasks ------------------------------------

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "Postgres from app tasks only"
  vpc_id      = data.aws_vpc.default.id

  tags = { Name = "${local.name}-rds" }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_ecs" {
  security_group_id            = aws_security_group.rds.id
  description                  = "Postgres from app tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.ecs.id
}
