# Public ALB, HTTP only. Its security group admits only CloudFront, and the
# listener forwards only requests that carry the secret X-Origin-Verify
# header CloudFront adds. Anything else gets 403. HTTPS for users is
# terminated at CloudFront.

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.app_subnet_ids

  # Invoice photo uploads on slow mobile links can take a while.
  idle_timeout               = 120
  drop_invalid_header_fields = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "app" {
  name                 = local.name
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = data.aws_vpc.default.id
  deregistration_delay = 30

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 1

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
