locals {
  expected_state_backend_key = "${var.project_name}/${var.account_alias}/${var.deployment_environment}/${var.state_scope}/terraform.tfstate"
  state_backend_prefix       = "${var.project_name}/${var.account_alias}/${var.deployment_environment}/${var.state_scope}/"
  state_lockfile_key         = "${var.state_backend_key}.tflock"
  app_state_backend_key      = "stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate"
  app_state_backend_prefix   = "stark-ballot-simulator/stark-dev/develop/app/"
  app_state_lockfile_key     = "${local.app_state_backend_key}.tflock"
  pipeline_role_arns = var.enable_development_pipeline ? [
    aws_iam_role.terraform_plan[0].arn,
    aws_iam_role.terraform_apply[0].arn,
  ] : []
  pipeline_state_write_role_arns = var.enable_development_pipeline ? [
    aws_iam_role.terraform_apply[0].arn,
  ] : []
  app_pipeline_role_arns = var.enable_development_app_pipeline ? [
    aws_iam_role.app_terraform_plan[0].arn,
    aws_iam_role.app_terraform_apply[0].arn,
  ] : []
  app_pipeline_state_write_role_arns = var.enable_development_app_pipeline ? [
    aws_iam_role.app_terraform_apply[0].arn,
  ] : []
  bootstrap_backend_key_administration_principal_arns = var.backend_principal_arns
  bootstrap_backend_key_use_principal_arns            = distinct(concat(var.backend_principal_arns, local.pipeline_role_arns, local.app_pipeline_role_arns))
  bootstrap_backend_state_read_principal_arns         = distinct(concat(var.backend_principal_arns, local.pipeline_role_arns))
  bootstrap_backend_state_write_principal_arns        = distinct(concat(var.backend_principal_arns, local.pipeline_state_write_role_arns))
  app_backend_state_read_principal_arns               = local.app_pipeline_role_arns
  app_backend_state_write_principal_arns              = local.app_pipeline_state_write_role_arns

  common_tags = {
    Project      = var.project_name
    AccountAlias = var.account_alias
    Environment  = var.deployment_environment
    ManagedBy    = "Terraform"
    StateScope   = var.state_scope
  }
}

check "state_identity" {
  assert {
    condition     = var.state_backend_key == local.expected_state_backend_key
    error_message = "state_backend_key must match project/account alias/deployment environment/state scope."
  }
}

data "aws_iam_policy_document" "state_kms_key" {
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
    sid    = "AllowBootstrapBackendKeyAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.bootstrap_backend_key_administration_principal_arns
    }

    actions = [
      "kms:CreateAlias",
      "kms:CreateGrant",
      "kms:DeleteAlias",
      "kms:DescribeKey",
      "kms:DisableKey",
      "kms:DisableKeyRotation",
      "kms:EnableKey",
      "kms:EnableKeyRotation",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListAliases",
      "kms:ListGrants",
      "kms:ListKeyPolicies",
      "kms:PutKeyPolicy",
      "kms:RetireGrant",
      "kms:RevokeGrant",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
      "kms:UpdateKeyDescription",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "AllowBootstrapBackendStateKeyUse"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.bootstrap_backend_key_use_principal_arns
    }

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
    ]
    resources = ["*"]
  }
}

resource "aws_kms_key" "state" {
  description             = "STARK Ballot Simulator Terraform state key for ${var.account_alias}/${var.deployment_environment}/${var.state_scope}"
  deletion_window_in_days = 30
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.state_kms_key.json
  tags                    = local.common_tags

  lifecycle {
    # Adopted pre-bootstrap backend tags are intentionally not converged here;
    # live tag repair requires a separately approved AWS-side cleanup.
    ignore_changes = [
      bypass_policy_lockout_safety_check,
      deletion_window_in_days,
      tags,
      tags_all,
    ]
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "state" {
  name          = var.state_kms_alias
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
  tags   = local.common_tags

  lifecycle {
    # Adopted pre-bootstrap backend tags are intentionally not converged here;
    # live tag repair requires a separately approved AWS-side cleanup.
    ignore_changes  = [tags, tags_all]
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = var.state_kms_alias
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "AllowBootstrapBackendListStatePrefix"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.bootstrap_backend_state_read_principal_arns
    }

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        local.state_backend_prefix,
        "${local.state_backend_prefix}*",
      ]
    }
  }

  statement {
    sid    = "AllowBootstrapBackendStateObjectReadAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.bootstrap_backend_state_read_principal_arns
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.state_backend_key}"]
  }

  statement {
    sid    = "AllowBootstrapBackendStateObjectWriteAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.bootstrap_backend_state_write_principal_arns
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.state_backend_key}"]
  }

  statement {
    sid    = "AllowBootstrapBackendLockfileObjectAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.bootstrap_backend_state_read_principal_arns
    }

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.state.arn}/${local.state_lockfile_key}"]
  }

  dynamic "statement" {
    for_each = var.enable_development_app_pipeline ? [1] : []

    content {
      sid    = "AllowAppBackendListStatePrefix"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = local.app_backend_state_read_principal_arns
      }

      actions   = ["s3:ListBucket"]
      resources = [aws_s3_bucket.state.arn]

      condition {
        test     = "StringLike"
        variable = "s3:prefix"
        values = [
          local.app_state_backend_prefix,
          "${local.app_state_backend_prefix}*",
        ]
      }
    }
  }

  dynamic "statement" {
    for_each = var.enable_development_app_pipeline ? [1] : []

    content {
      sid    = "AllowAppBackendStateObjectReadAccess"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = local.app_backend_state_read_principal_arns
      }

      actions   = ["s3:GetObject"]
      resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_development_app_pipeline ? [1] : []

    content {
      sid    = "AllowAppBackendStateObjectWriteAccess"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = local.app_backend_state_write_principal_arns
      }

      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
    }
  }

  dynamic "statement" {
    for_each = var.enable_development_app_pipeline ? [1] : []

    content {
      sid    = "AllowAppBackendLockfileObjectAccess"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = local.app_backend_state_read_principal_arns
      }

      actions = [
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject",
      ]
      resources = ["${aws_s3_bucket.state.arn}/${local.app_state_lockfile_key}"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
}
