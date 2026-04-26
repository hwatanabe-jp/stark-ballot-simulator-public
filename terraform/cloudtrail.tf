locals {
  cloudtrail_bucket_name    = "${var.project_name}-cloudtrail-${var.environment}-${data.aws_caller_identity.current.account_id}"
  cloudtrail_log_group_name = "/aws/cloudtrail/${var.project_name}-${var.environment}"
  cloudtrail_trail_name     = "${var.project_name}-trail-${var.environment}"
  cloudtrail_trail_arn      = "arn:${data.aws_partition.current.partition}:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/${local.cloudtrail_trail_name}"
}

resource "aws_s3_bucket" "cloudtrail" {
  count  = local.enable_cloudtrail ? 1 : 0
  bucket = local.cloudtrail_bucket_name

  tags = {
    Name = local.cloudtrail_bucket_name
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  count                   = local.enable_cloudtrail ? 1 : 0
  bucket                  = aws_s3_bucket.cloudtrail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  count  = local.enable_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.cloudtrail[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  count  = local.enable_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.cloudtrail[0].id

  rule {
    blocked_encryption_types = ["NONE"]
    bucket_key_enabled       = false

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  count  = local.enable_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.cloudtrail[0].id

  rule {
    id     = "expire-cloudtrail-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = local.cloudtrail_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.cloudtrail_retention_days
    }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket_policy" {
  count = local.enable_cloudtrail ? 1 : 0

  statement {
    sid    = "AWSCloudTrailAclCheck"
    effect = "Allow"
    actions = [
      "s3:GetBucketAcl"
    ]
    resources = [aws_s3_bucket.cloudtrail[0].arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_trail_arn]
    }
  }

  statement {
    sid    = "AWSCloudTrailWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject"
    ]
    resources = [
      "${aws_s3_bucket.cloudtrail[0].arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
    ]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.cloudtrail_trail_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  count  = local.enable_cloudtrail ? 1 : 0
  bucket = aws_s3_bucket.cloudtrail[0].id
  policy = data.aws_iam_policy_document.cloudtrail_bucket_policy[0].json
}

data "aws_iam_policy_document" "cloudtrail_assume_role" {
  count = local.enable_cloudtrail ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_logs" {
  count              = local.enable_cloudtrail ? 1 : 0
  name               = "${var.project_name}-cloudtrail-logs-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_assume_role[0].json

  tags = {
    Name = "${var.project_name}-cloudtrail-logs-${var.environment}"
  }
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  count             = local.enable_cloudtrail ? 1 : 0
  name              = local.cloudtrail_log_group_name
  retention_in_days = local.cloudtrail_retention_days

  tags = {
    Name = local.cloudtrail_log_group_name
  }
}

data "aws_iam_policy_document" "cloudtrail_logs_policy" {
  count = local.enable_cloudtrail ? 1 : 0

  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams"
    ]
    resources = [
      aws_cloudwatch_log_group.cloudtrail[0].arn,
      "${aws_cloudwatch_log_group.cloudtrail[0].arn}:*"
    ]
  }
}

resource "aws_iam_role_policy" "cloudtrail_logs" {
  count  = local.enable_cloudtrail ? 1 : 0
  name   = "${var.project_name}-cloudtrail-logs-policy-${var.environment}"
  role   = aws_iam_role.cloudtrail_logs[0].id
  policy = data.aws_iam_policy_document.cloudtrail_logs_policy[0].json
}

resource "aws_cloudtrail" "main" {
  count                         = local.enable_cloudtrail ? 1 : 0
  name                          = local.cloudtrail_trail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail[0].bucket
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail[0].arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_logs[0].arn

  tags = {
    Name = local.cloudtrail_trail_name
  }
}
