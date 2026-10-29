locals {
  pipeline_artifact_bucket_name = local.bootstrap_lane_authority.names.artifactBucket
  artifact_kms_alias            = local.bootstrap_lane_authority.names.artifactKmsAlias
}

resource "terraform_data" "development_pipeline_identity_guard" {
  input = "${local.bootstrap_lane_authority.stateIdentity}:${local.deployment_target.sourceBranch}"

  lifecycle {
    precondition {
      condition     = local.deployment_target_inputs_exact
      error_message = "Bootstrap inputs must match the exact reviewed caller target and lane configuration."
    }


    precondition {
      condition     = !local.pipeline_enabled || local.terraform_baseline_authority_enabled
      error_message = "The reviewed deployment authority composition requires the Bootstrap, Foundation, and App deployment lanes to be enabled together."
    }
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.pipeline_enabled ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = merge(local.common_tags, {
    Name = "token.actions.githubusercontent.com"
  })
}

data "aws_iam_policy_document" "artifact_kms_key" {
  count = local.pipeline_enabled ? 1 : 0

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

}

resource "aws_kms_key" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  description             = "STARK Ballot Simulator pipeline artifact key for ${local.bootstrap_lane_authority.stateIdentity}"
  deletion_window_in_days = 30
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.artifact_kms_key[0].json
  tags                    = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.artifact_kms_alias
  target_key_id = aws_kms_key.pipeline_artifacts[0].key_id
}

resource "aws_s3_bucket" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = local.pipeline_artifact_bucket_name
  tags   = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.pipeline_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id

  rule {
    id     = "expire-pipeline-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = local.storage_retention.bootstrap_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.bootstrap_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_alias.pipeline_artifacts[0].name
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "pipeline_artifacts_bucket" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.pipeline_artifacts[0].arn,
      "${aws_s3_bucket.pipeline_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id
  policy = data.aws_iam_policy_document.pipeline_artifacts_bucket[0].json
}
