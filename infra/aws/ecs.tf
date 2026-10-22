# One Fargate service (ARM64/Graviton): API + PWA + in-process worker.

# --- Image registry ----------------------------------------------------------

resource "aws_ecr_repository" "app" {
  name = local.name
  # Mutable: deploy.sh moves var.image_tag ("latest") to each new build; every
  # build is also pushed under its git SHA so any release can be redeployed.
  image_tag_mutability = "MUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# --- Cluster -----------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled" # saves cost; turn on when debugging performance
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# --- Task definition ---------------------------------------------------------

locals {
  container_name = "app"

  # Plain settings. Anything in var.extra_environment overrides these.
  app_environment = merge(
    {
      NODE_ENV                                  = "production"
      PORT                                      = tostring(var.container_port)
      LOG_LEVEL                                 = var.log_level
      WEB_DIST                                  = "/app/web"
      RUN_WORKER                                = tostring(var.run_worker)
      NODE_OPTIONS                              = "--max-old-space-size=${floor(var.task_memory * 0.75)}"
      AWS_REGION                                = var.aws_region
      STORAGE_DRIVER                            = "s3"
      S3_BUCKET                                 = aws_s3_bucket.invoices.bucket
      DB_HOST                                   = aws_db_instance.this.address
      DB_PORT                                   = tostring(aws_db_instance.this.port)
      DB_NAME                                   = var.db_name
      DB_USER                                   = var.db_username
      DB_SSLMODE                                = "verify-full"
      GEMINI_MODEL                              = var.gemini_model
      GEMINI_SECOND_MODEL                       = var.gemini_second_model
      GEMINI_TIER                               = var.gemini_tier
      TEXTRACT_ENABLED                          = tostring(var.textract_enabled)
      DATA_CLASS                                = var.data_class
      AI_ALLOW_TRAINING_PROVIDERS_FOR_REAL_DATA = tostring(var.ai_allow_training_providers_for_real_data)
      EXTRACTOR                                 = var.extractor
      HDFC_CLIENT_CODE                          = var.hdfc_client_code
      RTGS_FROM_PAISE                           = tostring(var.rtgs_from_paise)
      COOLING_OFF_HOURS                         = tostring(var.cooling_off_hours)
      REQUIRE_DIFFERENT_APPROVER                = tostring(var.require_different_approver)
      SEED_OWNER_NAME                           = var.seed_owner_name
      SEED_OWNER_PHONE                          = var.seed_owner_phone
    },
    var.extra_environment,
  )

  app_secrets = merge(
    { for name, s in aws_secretsmanager_secret.app : name => s.arn },
    # Only the password field of the RDS-managed JSON secret.
    { DB_PASSWORD = "${aws_db_instance.this.master_user_secret[0].secret_arn}:password::" },
  )
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = local.container_name
    image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    environment = [for k in sort(keys(local.app_environment)) : { name = k, value = local.app_environment[k] }]
    secrets     = [for k in sort(keys(local.app_secrets)) : { name = k, valueFrom = local.app_secrets[k] }]

    healthCheck = {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    # SIGTERM first; the app has this long to finish in-flight requests/jobs.
    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "app"
        mode                  = "non-blocking"
        max-buffer-size       = "4m"
      }
    }
  }])
}

# --- Service -----------------------------------------------------------------

resource "aws_ecs_service" "app" {
  name             = local.name
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.app.arn
  desired_count    = var.desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  # Rolling deploy: start the new task before stopping the old one.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 90
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.app_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true # no NAT gateway; inbound is still ALB-only
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  lifecycle {
    # Autoscaling owns the running count after creation.
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.from_cloudfront]
}

# --- Autoscaling (CPU target tracking, 1..max_count) -------------------------

resource "aws_appautoscaling_target" "app" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.desired_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.app.service_namespace
  resource_id        = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
