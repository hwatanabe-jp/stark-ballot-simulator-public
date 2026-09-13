locals {
  saved_plan_approval_authority_enabled = local.terraform_baseline_authority_enabled
  saved_plan_approval_prefix = (
    "${local.deployment_shared_names.approvalEvidencePrefix}/saved-plans/${local.deployment_target.targetKey}"
  )
  saved_plan_approval_gate_authority = {
    bootstrap_terraform = {
      path         = "bootstrap/terraform"
      role_name    = local.bootstrap_lane_authority.names.terraformApplyRole
      pipeline_arn = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.bootstrap_lane_authority.names.pipeline}"
      sid          = "BootstrapTerraform"
    }
    foundation_terraform = {
      path         = "foundation/terraform"
      role_name    = local.foundation_lane_authority.names.terraformApplyRole
      pipeline_arn = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.foundation_lane_authority.names.pipeline}"
      sid          = "FoundationTerraform"
    }
    app_verifier_preflight = {
      path         = "app/verifier-preflight"
      role_name    = local.deployment_shared_names.appSignaturePreflightApplyRole
      pipeline_arn = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.app_lane_authority.names.pipeline}"
      sid          = "AppVerifierPreflight"
    }
    app_terraform = {
      path         = "app/terraform"
      role_name    = local.app_lane_authority.names.terraformApplyRole
      pipeline_arn = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.app_lane_authority.names.pipeline}"
      sid          = "AppTerraform"
    }
  }
  saved_plan_approval_consumers = {
    for key, gate in local.saved_plan_approval_gate_authority : key => merge(gate, {
      object_arn = (
        "${local.terraform_authority_bucket_arn}/${local.saved_plan_approval_prefix}/${gate.path}/*"
      )
      role_arn = "arn:aws:iam::${var.aws_account_id}:role/${gate.role_name}"
    })
  }
  saved_plan_approval_object_arn_patterns = [
    for gate in values(local.saved_plan_approval_consumers) : gate.object_arn
  ]
  saved_plan_approval_apply_role_arns = [
    for gate in values(local.saved_plan_approval_consumers) : gate.role_arn
  ]
  saved_plan_approval_administrator_access_role_candidates = [
    for arn in var.backend_principal_arns : arn
    if can(regex(
      "^arn:${local.deployment_target.partition}:iam::${var.aws_account_id}:role/aws-reserved/sso.amazonaws.com/${var.aws_region}/AWSReservedSSO_AdministratorAccess_[0-9a-f]{16}$",
      arn,
    ))
  ]
  saved_plan_approval_administrator_access_role_arn = (
    local.saved_plan_approval_authority_enabled
    ? one(local.saved_plan_approval_administrator_access_role_candidates)
    : null
  )
}

check "saved_plan_approval_administrator_access_is_exact" {
  assert {
    condition = (
      !local.saved_plan_approval_authority_enabled
      || length(local.saved_plan_approval_administrator_access_role_candidates) == 1
    )
    error_message = "Saved-plan approval authority requires exactly one regional AdministratorAccess SSO role among the governed backend principals."
  }
}

data "aws_iam_policy_document" "saved_plan_approval_apply_read" {
  for_each = local.saved_plan_approval_authority_enabled ? {
    for key, consumer in local.saved_plan_approval_consumers : key => consumer
    if key != "bootstrap_terraform"
  } : {}

  statement {
    sid       = "ReadExact${each.value.sid}ApprovalEvidenceVersion"
    effect    = "Allow"
    actions   = ["s3:GetObjectVersion"]
    resources = [each.value.object_arn]
  }

  statement {
    sid       = "DescribeSavedPlanApprovalKeyFor${each.value.sid}"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

  statement {
    sid       = "DecryptSavedPlanApprovalFor${each.value.sid}"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
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

data "aws_iam_policy_document" "saved_plan_approval_bootstrap_apply_read" {
  count = local.saved_plan_approval_authority_enabled ? 1 : 0

  statement {
    sid       = "ReadExactBootstrapTerraformApprovalEvidenceVersion"
    effect    = "Allow"
    actions   = ["s3:GetObjectVersion"]
    resources = [local.saved_plan_approval_consumers.bootstrap_terraform.object_arn]
  }

  statement {
    sid       = "ObserveExactBootstrapTerraformApprovalAction"
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = [local.saved_plan_approval_consumers.bootstrap_terraform.pipeline_arn]
  }

  statement {
    sid       = "DescribeSavedPlanApprovalKeyForBootstrapTerraform"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.terraform_authority_kms_alias]
    }
  }

  statement {
    sid       = "DecryptSavedPlanApprovalForBootstrapTerraform"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.terraform_authority_kms_alias]
    }

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

data "aws_iam_policy_document" "saved_plan_approval_key_use" {
  count = local.saved_plan_approval_authority_enabled ? 1 : 0

  statement {
    sid    = "AllowSavedPlanApprovalAdministratorKeyDescription"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:DescribeKey"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.saved_plan_approval_administrator_access_role_arn]
    }
  }

  statement {
    sid    = "AllowSavedPlanApprovalAdministratorKeyUseThroughAuthorityBucket"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.saved_plan_approval_administrator_access_role_arn]
    }

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

  statement {
    sid    = "AllowSavedPlanApprovalApplyKeyDescription"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:DescribeKey"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = local.saved_plan_approval_apply_role_arns
    }
  }

  statement {
    sid    = "AllowSavedPlanApprovalApplyKeyUseThroughAuthorityBucket"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = local.saved_plan_approval_apply_role_arns
    }

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

data "aws_iam_policy_document" "saved_plan_approval_bucket_guardrail" {
  count = local.saved_plan_approval_authority_enabled ? 1 : 0

  statement {
    sid    = "DenySavedPlanApprovalEvidenceDeletion"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = local.saved_plan_approval_object_arn_patterns
  }

  statement {
    sid    = "DenyUnconditionalSavedPlanApprovalEvidenceWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "DenySavedPlanApprovalEvidenceIfMatch"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyMissingSavedPlanApprovalEvidenceSse"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyNonKmsSavedPlanApprovalEvidenceWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid    = "DenyMissingSavedPlanApprovalEvidenceKmsKey"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyWrongSavedPlanApprovalEvidenceKmsKey"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_alias.terraform_authority[0].target_key_arn]
    }
  }

  statement {
    sid    = "DenySavedPlanApprovalWritesOutsideAdministrator"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.saved_plan_approval_object_arn_patterns

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.saved_plan_approval_administrator_access_role_arn]
    }
  }

  statement {
    sid    = "AllowSavedPlanApprovalAdministratorEvidenceAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [local.saved_plan_approval_administrator_access_role_arn]
    }

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = local.saved_plan_approval_object_arn_patterns
  }

  dynamic "statement" {
    for_each = local.saved_plan_approval_consumers

    content {
      sid    = "AllowExact${statement.value.sid}ApprovalEvidenceRead"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = [statement.value.role_arn]
      }

      actions   = ["s3:GetObjectVersion"]
      resources = [statement.value.object_arn]
    }
  }
}

resource "terraform_data" "saved_plan_approval_authorization_propagation" {
  count = local.saved_plan_approval_authority_enabled ? 1 : 0

  triggers_replace = {
    authorization_sha256 = sha256(jsonencode({
      administratorRoleArn = local.saved_plan_approval_administrator_access_role_arn
      boundaries = {
        bootstrap = jsondecode(data.aws_iam_policy_document.bootstrap_deploy_permissions_boundary[0].json)
        foundation = jsondecode(
          data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json
        )
        app = jsondecode(data.aws_iam_policy_document.app_apply_deploy_permissions_boundary[0].json)
      }
      identities = {
        bootstrap  = jsondecode(data.aws_iam_policy_document.terraform_apply[0].json)
        foundation = jsondecode(data.aws_iam_policy_document.foundation_terraform_apply[0].json)
        appVerifierPreflight = jsondecode(
          data.aws_iam_policy_document.app_signature_preflight_apply[0].json
        )
        app = jsondecode(data.aws_iam_policy_document.app_terraform_apply[0].json)
        appVerifierPreflightCommon = {
          roleArn   = local.saved_plan_approval_consumers.app_verifier_preflight.role_arn
          policyArn = local.app_codebuild_common_policy_arn
          policy    = jsondecode(data.aws_iam_policy_document.app_codebuild_common[0].json)
        }
        appTerraformAuthority = {
          roleArn = local.saved_plan_approval_consumers.app_terraform.role_arn
          policyArn = (
            "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_state_backend_policy_name}"
          )
          policy = jsondecode(data.aws_iam_policy_document.app_terraform_apply_state_backend[0].json)
        }
      }
      keyPolicy    = jsondecode(data.aws_iam_policy_document.terraform_authority_key[0].json)
      bucketPolicy = jsondecode(data.aws_iam_policy_document.terraform_authority_bucket[0].json)
    }))
  }

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.foundation_apply_deploy_permissions_boundary,
    aws_iam_policy.app_apply_deploy_permissions_boundary,
    aws_iam_role_policy.terraform_apply,
    aws_iam_role_policy.foundation_terraform_apply,
    aws_iam_role_policy.app_signature_preflight_apply,
    aws_iam_role_policy.app_terraform_apply,
    aws_iam_policy.app_codebuild_common,
    aws_iam_role_policy_attachment.app_codebuild_common_preflight_apply,
    aws_iam_policy.app_terraform_apply_state_backend,
    aws_iam_role_policy_attachment.app_terraform_apply_state_backend,
    aws_kms_key.terraform_authority,
    aws_s3_bucket_policy.terraform_authority,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.bootstrap_deploy_permissions_boundary,
      aws_iam_policy.foundation_apply_deploy_permissions_boundary,
      aws_iam_policy.app_apply_deploy_permissions_boundary,
      aws_iam_role_policy.terraform_apply,
      aws_iam_role_policy.foundation_terraform_apply,
      aws_iam_role_policy.app_signature_preflight_apply,
      aws_iam_role_policy.app_terraform_apply,
      aws_iam_policy.app_codebuild_common,
      aws_iam_role_policy_attachment.app_codebuild_common_preflight_apply,
      aws_iam_policy.app_terraform_apply_state_backend,
      aws_iam_role_policy_attachment.app_terraform_apply_state_backend,
      aws_kms_key.terraform_authority,
      aws_s3_bucket_policy.terraform_authority,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}
