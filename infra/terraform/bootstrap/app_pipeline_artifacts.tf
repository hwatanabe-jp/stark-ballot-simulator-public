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
        aws_iam_role.app_static_fast_static_deploy[0].arn,
        aws_iam_role.app_terraform_smoke[0].arn,
        aws_iam_role.app_static_fast_pipeline[0].arn,
        aws_iam_role.app_static_fast_gate_and_build[0].arn,
        aws_iam_role.app_static_fast_smoke_lite[0].arn,
        aws_iam_role.app_signature_preflight_plan[0].arn,
        aws_iam_role.app_signature_preflight_apply[0].arn,
        aws_iam_role.app_signature_state_refresh_apply[0].arn,
        aws_iam_role.app_signature_preflight_invoker[0].arn,
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
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  bucket = local.app_retained_artifact_bucket_name
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
    id     = "expire-legacy-codepipeline-execution-artifacts"
    status = "Enabled"

    # CodePipeline shortened both former shared-bucket pipeline prefixes to
    # the same first 20 characters. New executions use dedicated buckets;
    # retained legacy objects are allowed to expire without copying or a reader.
    filter {
      prefix = "${substr(local.app_pipeline_name, 0, 20)}/"
    }

    expiration {
      days = local.storage_retention.app_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.app_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }

  rule {
    id     = "expire-non-authoritative-app-artifacts"
    status = "Enabled"

    filter {
      prefix = "transient/"
    }

    expiration {
      days = local.storage_retention.app_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.app_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }

  rule {
    id     = "expire-app-codebuild-cache"
    status = "Enabled"

    filter {
      prefix = "codebuild-cache/"
    }

    expiration {
      days = local.storage_retention.app_pipeline_cache_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.app_pipeline_cache_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
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

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/*"
    ]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.app_terraform_smoke[0].arn]
    }
  }

  statement {
    sid    = "DenyRetainedDeploymentEvidenceDeletion"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.staticFrontendArtifactPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.recoveryManifestPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.signaturePreflightPrefix}/*",
    ]
  }

  statement {
    sid    = "DenySignaturePreflightWritesOutsideInvokerRole"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.signaturePreflightPrefix}/*"
    ]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.app_signature_preflight_invoker[0].arn]
    }
  }

  statement {
    sid    = "DenyUnconditionalRetainedEvidenceWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_accepted_marker_path}/*/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.staticFrontendArtifactPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.recoveryManifestPrefix}/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.signaturePreflightPrefix}/*",
    ]

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyUnconditionalAcceptedDeploymentCurrentAuthorityWrites"
    effect = "Deny"

    # IAM combines these Null conditions with AND: first-create may use
    # If-None-Match, while later current-authority updates must use If-Match.

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_accepted_marker_path}/current.json"]

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyRetiredAcceptedDeploymentIndexWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:AbortMultipartUpload",
      "s3:BypassGovernanceRetention",
      "s3:DeleteObject",
      "s3:DeleteObjectAnnotation",
      "s3:DeleteObjectTagging",
      "s3:DeleteObjectVersion",
      "s3:DeleteObjectVersionAnnotation",
      "s3:DeleteObjectVersionTagging",
      "s3:ObjectOwnerOverrideToBucketOwner",
      "s3:PutObject",
      "s3:PutObjectAcl",
      "s3:PutObjectAnnotation",
      "s3:PutObjectLegalHold",
      "s3:PutObjectRetention",
      "s3:PutObjectTagging",
      "s3:PutObjectVersionAcl",
      "s3:PutObjectVersionAnnotation",
      "s3:PutObjectVersionTagging",
      "s3:ReplicateDelete",
      "s3:ReplicateObject",
      "s3:ReplicateObjectAnnotation",
      "s3:ReplicateTags",
      "s3:RestoreObject",
      "s3:UpdateObjectEncryption",
    ]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.app_accepted_marker_path}/index.json"]
  }

  statement {
    sid    = "DenyApprovalEvidenceWritesOutsideApplyRole"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.app_terraform_apply[0].arn]
    }
  }

  statement {
    sid    = "DenyLambdaArtifactWritesOutsidePlanRoles"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values = [
        aws_iam_role.app_terraform_plan[0].arn,
        aws_iam_role.app_signature_preflight_plan[0].arn,
      ]
    }
  }

  statement {
    sid    = "DenyStaticFrontendArtifactWritesOutsideStaticDeployRoles"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.staticFrontendArtifactPrefix}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values = [
        aws_iam_role.app_static_deploy[0].arn,
        aws_iam_role.app_static_fast_static_deploy[0].arn,
      ]
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

resource "aws_s3_bucket" "app_pipeline_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  bucket = local.app_pipeline_execution_artifact_bucket_name
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "app_pipeline_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.app_pipeline_execution_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "app_pipeline_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_execution_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "app_pipeline_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_execution_artifacts[0].id

  rule {
    id     = "expire-full-app-execution-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = local.storage_retention.app_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.app_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app_pipeline_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_execution_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_alias.app_pipeline_artifacts[0].name
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "app_pipeline_execution_artifacts_bucket" {
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
      aws_s3_bucket.app_pipeline_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_execution_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "app_pipeline_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_pipeline_execution_artifacts[0].id
  policy = data.aws_iam_policy_document.app_pipeline_execution_artifacts_bucket[0].json
}

resource "aws_s3_bucket" "app_static_fast_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  bucket = local.app_static_fast_execution_artifact_bucket_name
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "app_static_fast_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.app_static_fast_execution_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "app_static_fast_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_static_fast_execution_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "app_static_fast_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_static_fast_execution_artifacts[0].id

  rule {
    id     = "expire-static-fast-execution-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = local.storage_retention.app_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.app_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "app_static_fast_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_static_fast_execution_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_alias.app_pipeline_artifacts[0].name
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "app_static_fast_execution_artifacts_bucket" {
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
      aws_s3_bucket.app_static_fast_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "app_static_fast_execution_artifacts" {
  count = local.app_pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.app_static_fast_execution_artifacts[0].id
  policy = data.aws_iam_policy_document.app_static_fast_execution_artifacts_bucket[0].json
}

check "app_artifact_bucket_names_are_distinct" {
  assert {
    condition     = !local.app_pipeline_enabled || local.app_artifact_bucket_names_are_distinct
    error_message = "The retained App authority bucket and both CodePipeline execution buckets must be distinct."
  }
}
