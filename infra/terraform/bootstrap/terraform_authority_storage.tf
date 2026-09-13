data "aws_iam_policy_document" "terraform_authority_key" {
  count                   = local.terraform_baseline_authority_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.saved_plan_approval_key_use[0].json]

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
    sid    = "AllowTerraformAuthorityPublisherKeyDescription"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.terraform_baseline_publisher_role_arns
    }

    actions   = ["kms:DescribeKey"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowTerraformAuthorityPublisherKeyUseThroughAuthorityBucket"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.terraform_baseline_publisher_role_arns
    }

    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.terraform_authority_bucket_arn]
    }
  }
}

resource "aws_kms_key" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.terraform_baseline_authority_management,
    aws_iam_role.bootstrap_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_smoke,
    terraform_data.terraform_baseline_authority_storage_authorization_propagation,
  ]

  description             = "Durable accepted Terraform baselines and report-only drift evidence"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.terraform_authority_key[0].json
  tags = merge(local.common_tags, {
    AuthorityType = "terraform-baseline"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  name          = local.terraform_authority_kms_alias
  target_key_id = aws_kms_key.terraform_authority[0].key_id
}

resource "aws_s3_bucket" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  bucket = local.terraform_authority_bucket_name
  tags = merge(local.common_tags, {
    AuthorityType = "terraform-baseline"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.terraform_authority[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket = aws_s3_bucket.terraform_authority[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket = aws_s3_bucket.terraform_authority[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_authority[0].arn
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [aws_s3_bucket_versioning.terraform_authority]
  bucket     = aws_s3_bucket.terraform_authority[0].id

  rule {
    id     = "expire-terraform-drift-reports"
    status = "Enabled"

    filter {
      prefix = "${local.terraform_drift_report_prefix}/"
    }

    expiration {
      days = local.storage_retention.terraform_drift_report_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.terraform_drift_report_days
    }
  }

  rule {
    id     = "abort-incomplete-terraform-authority-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

data "aws_iam_policy_document" "terraform_authority_bucket" {
  count                   = local.terraform_baseline_authority_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.saved_plan_approval_bucket_guardrail[0].json]

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      local.terraform_authority_bucket_arn,
      "${local.terraform_authority_bucket_arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyDeleteTerraformAuthority"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = concat(
      local.terraform_current_immutable_object_arn_patterns,
      [
        local.terraform_bootstrap_baseline_history_object_arn_pattern,
        local.terraform_foundation_baseline_history_object_arn_pattern,
        local.terraform_app_baseline_history_object_arn_pattern,
      ],
      local.terraform_baseline_pointer_object_arns,
    )
  }

  statement {
    sid    = "DenyUnconditionalTerraformAuthorityRecordWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.terraform_current_immutable_object_arn_patterns

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "DenyUnconditionalCurrentTerraformAuthorityWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.terraform_baseline_pointer_object_arns

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyAmbiguousCurrentTerraformAuthorityWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.terraform_baseline_pointer_object_arns

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = local.terraform_baseline_publishers

    content {
      sid    = "DenyTerraformWritesOutsideExactRootPublisher${title(statement.key)}"
      effect = "Deny"

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      actions   = ["s3:PutObject"]
      resources = statement.value.object_arns

      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = [statement.value.role_arn]
      }
    }
  }

  statement {
    sid    = "DenyRetiredBootstrapTerraformBaselineWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.terraform_bootstrap_baseline_history_object_arn_pattern]
  }

  statement {
    sid    = "DenyRetiredFoundationTerraformBaselineWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.terraform_foundation_baseline_history_object_arn_pattern]
  }

  statement {
    sid    = "DenyRetiredAppTerraformBaselineWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.terraform_app_baseline_history_object_arn_pattern]
  }

  statement {
    sid    = "DenyUnconditionalTerraformDriftReportWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.terraform_drift_report_object_arn_pattern]

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "AllowTerraformAuthorityPublishers"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.terraform_baseline_publisher_role_arns
    }

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = concat(
      local.terraform_current_immutable_object_arn_patterns,
      local.terraform_baseline_pointer_object_arns,
    )
  }

  statement {
    sid    = "DenyTerraformApplyRoleObjectAccess"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = local.terraform_apply_role_arns
    }

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = concat(
      local.terraform_current_immutable_object_arn_patterns,
      [
        local.terraform_bootstrap_baseline_history_object_arn_pattern,
        local.terraform_foundation_baseline_history_object_arn_pattern,
        local.terraform_app_baseline_history_object_arn_pattern,
        local.terraform_drift_report_object_arn_pattern,
      ],
      local.terraform_baseline_pointer_object_arns,
    )
  }
}

resource "aws_s3_bucket_policy" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_role.bootstrap_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_smoke,
    aws_iam_role.terraform_apply,
    aws_iam_role.foundation_terraform_apply,
    aws_iam_role.app_signature_preflight_apply,
    aws_iam_role.app_terraform_apply,
  ]

  bucket = aws_s3_bucket.terraform_authority[0].id
  policy = data.aws_iam_policy_document.terraform_authority_bucket[0].json
}

check "terraform_authority_key_policy_size" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_authority_key[0].json))) <= 32768, false)
    )
    error_message = "The Terraform authority KMS key policy must remain within KMS's 32,768-character quota."
  }
}

check "terraform_authority_bucket_policy_size" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_authority_bucket[0].json))) <= 20480, false)
    )
    error_message = "The Terraform authority bucket policy must remain within S3's 20,480-character quota."
  }
}

data "aws_iam_policy_document" "terraform_baseline_publisher" {
  for_each = local.terraform_baseline_publishers

  statement {
    sid    = "PublishRootTerraformAuthority"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    # Bootstrap and Foundation each publish one self-contained acceptance and
    # move the existing root pointer. App owns its separate permanent ledger.
    resources = each.value.object_arns
  }

  statement {
    sid       = "DescribeTerraformAuthorityKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

  statement {
    sid       = "UseTerraformAuthorityKeyThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.terraform_authority_bucket_arn]
    }
  }
}

resource "aws_iam_role_policy" "terraform_baseline_publisher" {
  for_each = local.terraform_baseline_publishers

  depends_on = [
    aws_s3_bucket_policy.terraform_authority,
    aws_iam_role.bootstrap_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_smoke,
  ]

  name   = each.value.role
  role   = each.value.role
  policy = data.aws_iam_policy_document.terraform_baseline_publisher[each.key].json
}

check "terraform_baseline_publisher_role_inline_policy_quotas" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_smoke[0].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_publisher["bootstrap"].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_publisher["foundation"].json))) <= 10240,
        false,
      )
    )
    error_message = "Each Terraform publication role must remain within IAM's aggregate 10,240-character inline-policy quota."
  }
}
