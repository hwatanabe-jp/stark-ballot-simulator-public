data "aws_iam_policy_document" "app_artifact_kms_key" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "EnableAccountRootAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowAppPipelineArtifactKeyUse"
    effect = "Allow"

    principals {
      type = "AWS"
      identifiers = [
        aws_iam_role.app_pipeline[0].arn,
        aws_iam_role.app_deployment_record[0].arn,
        aws_iam_role.app_terraform_plan[0].arn,
        aws_iam_role.app_terraform_apply[0].arn,
        aws_iam_role.app_static_deploy[0].arn,
        aws_iam_role.app_terraform_smoke[0].arn,
        aws_iam_role.app_static_fast_pipeline[0].arn,
        aws_iam_role.app_static_fast_gate_and_build[0].arn,
        aws_iam_role.app_static_fast_smoke_lite[0].arn,
      ]
    }

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
  }
}

resource "aws_kms_key" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  description             = "STARK Ballot Simulator app pipeline artifact key for ${var.account_alias}/${var.deployment_environment}/app"
  deletion_window_in_days = 30
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.app_artifact_kms_key[0].json
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_artifact_kms_alias
  target_key_id = aws_kms_key.app_pipeline_artifacts[0].key_id
}

resource "aws_s3_bucket" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  bucket = local.app_pipeline_artifact_bucket_name
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.app_pipeline_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_artifacts[0].id

  rule {
    id     = "expire-non-authoritative-app-artifacts"
    status = "Enabled"

    filter {
      prefix = "transient/"
    }

    expiration {
      days = var.app_pipeline_artifact_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.app_pipeline_artifact_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-app-codebuild-cache"
    status = "Enabled"

    filter {
      prefix = "codebuild-cache/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_alias.app_pipeline_artifacts[0].name
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "app_pipeline_artifacts_bucket" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.app_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyAcceptedDeploymentMarkerWritesOutsideSmokeRole"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/accepted-deployments/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.app_terraform_smoke[0].arn]
    }
  }

  statement {
    sid    = "DenyCodeBuildCacheWritesOutsideValidatePlanRole"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/codebuild-cache/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.app_terraform_plan[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "app_pipeline_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_artifacts[0].id
  policy = data.aws_iam_policy_document.app_pipeline_artifacts_bucket[0].json
}
