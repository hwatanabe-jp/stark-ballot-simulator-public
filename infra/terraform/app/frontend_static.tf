resource "aws_s3_bucket" "frontend_static" {
  bucket = local.frontend_bucket_name

  tags = merge(local.common_tags, {
    Component = "static-frontend"
  })
}

resource "aws_s3_bucket_public_access_block" "frontend_static" {
  bucket                  = aws_s3_bucket.frontend_static.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend_static" {
  bucket = aws_s3_bucket.frontend_static.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend_static" {
  bucket = aws_s3_bucket.frontend_static.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend_static" {
  bucket = aws_s3_bucket.frontend_static.id

  rule {
    id     = "expire-noncurrent-static-frontend-versions"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.frontend_noncurrent_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }

  rule {
    id     = "remove-expired-static-frontend-delete-markers"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      expired_object_delete_marker = true
    }
  }
}

resource "aws_cloudfront_origin_access_control" "frontend_static" {
  name                              = "${local.name_prefix}-frontend-oac"
  description                       = "OAC for ${local.frontend_bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "frontend_static_assets" {
  name        = "${local.name_prefix}-frontend-static-assets"
  comment     = "Cache immutable Vite static assets for ${local.name_prefix}"
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_cache_policy" "frontend_app_shell" {
  name        = "${local.name_prefix}-frontend-app-shell"
  comment     = "Short cache for Vite app shell ${local.name_prefix}"
  default_ttl = 60
  max_ttl     = 300
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_cache_policy" "api_disabled" {
  name        = "${local.name_prefix}-api-disabled-cache"
  comment     = "Disable caching for session-owned API requests; origin request policy forwards API inputs"
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false
  }
}

resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${local.name_prefix}-api-origin-request"
  comment = "Forward API headers required for capability and range-bound bundle/report requests"

  cookies_config {
    cookie_behavior = "none"
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Content-Type", "Origin", "Range", "X-Session-Capability", "X-Session-ID"]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_response_headers_policy" "frontend_security" {
  name    = "${local.name_prefix}-frontend-security"
  comment = "Security headers for the static frontend"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://*.challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.amazonaws.com https://*.cloudflare.com https://cloudflareinsights.com https://static.cloudflareinsights.com; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      override = true
      value    = "accelerometer=(), autoplay=(), camera=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), usb=()"
    }
  }
}

resource "aws_cloudfront_function" "frontend_spa_fallback" {
  name    = "${local.name_prefix}-frontend-spa-fallback"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite extensionless browser routes to the Vite app shell"
  publish = true
  code    = <<-EOT
function handler(event) {
  var request = event.request;
  var uri = request.uri || "/";
  if (uri === "/api" || uri.indexOf("/api/") === 0 || uri.indexOf("/assets/") === 0) {
    return request;
  }
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (uri === "/" || uri.charAt(uri.length - 1) === "/" || lastSegment.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
EOT
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  comment             = local.frontend_distribution_comment
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  aliases             = local.cloudfront_aliases

  origin {
    domain_name              = aws_s3_bucket.frontend_static.bucket_regional_domain_name
    origin_id                = "static-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend_static.id
  }

  origin {
    domain_name = local.api_origin_domain_name
    origin_id   = "public-api"

    dynamic "custom_header" {
      for_each = local.api_origin_verify_header_configured ? [1] : []

      content {
        name  = local.api_origin_verify_header_name
        value = local.api_origin_verify_header_value
      }
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "static-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.frontend_app_shell.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security.id
    trusted_key_groups         = local.operator_gate_trusted_key_groups
    compress                   = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.frontend_spa_fallback.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    target_origin_id           = "static-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.frontend_static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security.id
    trusted_key_groups         = local.operator_gate_trusted_key_groups
    compress                   = true
  }

  ordered_cache_behavior {
    path_pattern               = "/patterns/*"
    target_origin_id           = "static-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.frontend_app_shell.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security.id
    trusted_key_groups         = local.operator_gate_trusted_key_groups
    compress                   = true
  }

  ordered_cache_behavior {
    path_pattern               = "/textures/*"
    target_origin_id           = "static-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.frontend_app_shell.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security.id
    trusted_key_groups         = local.operator_gate_trusted_key_groups
    compress                   = true
  }

  ordered_cache_behavior {
    path_pattern               = "/api"
    target_origin_id           = "public-api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = aws_cloudfront_cache_policy.api_disabled.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security.id
    trusted_key_groups         = local.operator_gate_trusted_key_groups
    compress                   = true
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "public-api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = aws_cloudfront_cache_policy.api_disabled.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security.id
    trusted_key_groups         = local.operator_gate_trusted_key_groups
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.cloudfront_custom_hostname_enabled
    acm_certificate_arn            = local.cloudfront_custom_hostname_enabled ? var.cloudfront_acm_certificate_arn : null
    ssl_support_method             = local.cloudfront_custom_hostname_enabled ? "sni-only" : null
    minimum_protocol_version       = local.cloudfront_custom_hostname_enabled ? "TLSv1.2_2021" : "TLSv1"
  }

  lifecycle {
    precondition {
      condition = (
        !local.cloudfront_custom_hostname_enabled
        || var.cloudfront_acm_certificate_arn != null
      )
      error_message = "cloudfront_acm_certificate_arn must be set from the Plan 02 DNS/ACM handoff when public_hostname_disposition selects a custom hostname."
    }

    precondition {
      condition = (
        !local.cloudfront_custom_hostname_enabled
        || local.target_public_origin == "https://${var.public_hostname}"
      )
      error_message = "verifier_public_base_url must be the HTTPS origin for public_hostname when public_hostname_disposition selects a custom hostname."
    }
  }

  tags = merge(local.common_tags, {
    Component = "static-frontend"
  })
}

data "aws_iam_policy_document" "frontend_static_bucket" {
  statement {
    sid    = "AllowCloudFrontRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend_static.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend_static" {
  bucket = aws_s3_bucket.frontend_static.id
  policy = data.aws_iam_policy_document.frontend_static_bucket.json
}
