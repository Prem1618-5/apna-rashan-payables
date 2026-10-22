# CloudFront gives HTTPS (required for an installable iPhone PWA) on the
# default *.cloudfront.net certificate, or on a custom domain with an ACM
# certificate from us-east-1.
#
# Behaviours:
#   /api/*     no caching, all viewer headers/cookies/query forwarded, all methods
#   /assets/*  cached (Vite's hashed files), compressed
#   default    no caching (index.html, sw.js, manifest must always be fresh)

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# All viewer headers (incl. Host, cookies, query strings) plus CloudFront
# headers such as CloudFront-Forwarded-Proto (the ALB hop is plain HTTP, so
# X-Forwarded-Proto reaching the app says "http").
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerAndCloudFrontHeaders-2022-06"
}

locals {
  origin_id         = "alb"
  use_custom_domain = length(var.domain_names) > 0
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "${local.name} PWA + API"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.cloudfront_price_class
  aliases         = var.domain_names

  origin {
    origin_id   = local.origin_id
    domain_name = aws_lb.this.dns_name

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id         = local.origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = local.origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.use_custom_domain ? null : true
    acm_certificate_arn            = local.use_custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  lifecycle {
    precondition {
      condition     = !local.use_custom_domain || var.acm_certificate_arn != ""
      error_message = "domain_names is set, so acm_certificate_arn (us-east-1) is required."
    }
  }
}
