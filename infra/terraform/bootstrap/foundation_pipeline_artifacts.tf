data "aws_iam_policy_document" "foundation_artifact_kms_key" {
  count = local.foundation_pipeline_enabled ? 1 : 0

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
    sid    = "AllowFoundationPipelineArtifactKeyUse"
    effect = "Allow"

    principals {
      type = "AWS"
      identifiers = [
        aws_iam_role.foundation_pipeline[0].arn,
        aws_iam_role.foundation_image_signing_authority_resolver_build[0].arn,
        aws_iam_role.foundation_prover_release_toolchain_resolver_build[0].arn,
        aws_iam_role.foundation_prover_release_candidate_build[0].arn,
        aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].arn,
        aws_iam_role.foundation_toolchain_release_candidate_build[0].arn,
        aws_iam_role.foundation_toolchain_release_update_accepted_pointer_build[0].arn,
        aws_iam_role.foundation_terraform_plan[0].arn,
        aws_iam_role.foundation_terraform_apply[0].arn,
        aws_iam_role.foundation_terraform_smoke[0].arn,
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

resource "aws_kms_key" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    terraform_data.bootstrap_apply_authorization_propagation,
    aws_iam_role_policy_attachment.terraform_apply_artifact_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  description             = "STARK Ballot Simulator foundation pipeline artifact key for ${var.account_alias}/${var.deployment_environment}/foundation"
  deletion_window_in_days = 30
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.foundation_artifact_kms_key[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_artifact_kms_alias
  target_key_id = aws_kms_key.foundation_pipeline_artifacts[0].key_id
}

resource "aws_s3_bucket" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    terraform_data.bootstrap_apply_authorization_propagation,
    aws_iam_role_policy_attachment.terraform_apply_artifact_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  bucket = local.foundation_pipeline_artifact_bucket_name
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.foundation_pipeline_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.foundation_pipeline_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.foundation_pipeline_artifacts[0].id

  dynamic "rule" {
    # CodePipeline truncates the pipeline directory to 20 characters. These
    # lanes share that directory; deduplicate it without expiring retained keys.
    for_each = toset([
      "${substr(local.foundation_pipeline_name, 0, 20)}/",
      "${substr(local.prover_release_pipeline_name, 0, 20)}/",
      "${substr(local.toolchain_release_pipeline_name, 0, 20)}/",
    ])

    content {
      id     = "expire-${trimsuffix(rule.value, "/")}-execution-artifacts"
      status = "Enabled"

      filter {
        prefix = rule.value
      }

      expiration {
        days = local.storage_retention.foundation_pipeline_artifact_days
      }

      noncurrent_version_expiration {
        noncurrent_days = local.storage_retention.foundation_pipeline_artifact_days
      }

      abort_incomplete_multipart_upload {
        days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
      }
    }
  }

  rule {
    id     = "expire-non-authoritative-foundation-artifacts"
    status = "Enabled"

    filter {
      prefix = "transient/"
    }

    expiration {
      days = local.storage_retention.foundation_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.foundation_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.foundation_pipeline_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_alias.foundation_pipeline_artifacts[0].name
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "foundation_pipeline_artifacts_bucket" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.foundation_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.foundation_pipeline_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "foundation_pipeline_artifacts" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.foundation_pipeline_artifacts[0].id
  policy = data.aws_iam_policy_document.foundation_pipeline_artifacts_bucket[0].json
}
