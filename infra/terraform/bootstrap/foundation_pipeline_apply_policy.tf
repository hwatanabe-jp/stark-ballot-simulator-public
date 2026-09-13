data "aws_iam_policy_document" "foundation_initial_state_observation" {
  count = local.foundation_pipeline_enabled && local.deployment_target.environmentId == "main" ? 1 : 0

  statement {
    sid       = "ReadInitialFoundationBucketVersioning"
    effect    = "Allow"
    actions   = ["s3:GetBucketVersioning"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}", local.terraform_authority_bucket_arn]
  }

  dynamic "statement" {
    for_each = {
      State = {
        bucket_arn = "arn:aws:s3:::${var.state_bucket_name}"
        key        = local.foundation_state_backend_key
      }
      Acceptance = {
        bucket_arn = local.terraform_authority_bucket_arn
        key        = trimprefix(local.terraform_foundation_acceptance_pointer_object_arn, "${local.terraform_authority_bucket_arn}/")
      }
    }
    content {
      sid       = "InspectInitialFoundation${statement.key}Versions"
      effect    = "Allow"
      actions   = ["s3:ListBucketVersions"]
      resources = [statement.value.bucket_arn]

      condition {
        test     = "StringEquals"
        variable = "s3:prefix"
        values   = [statement.value.key]
      }

      condition {
        test     = "NumericEquals"
        variable = "s3:max-keys"
        values   = ["1"]
      }

      dynamic "condition" {
        for_each = statement.key == "State" ? [1] : []
        content {
          test     = "StringEquals"
          variable = "s3:delimiter"
          values   = ["."]
        }
      }
    }
  }
}

data "aws_iam_policy_document" "foundation_terraform_apply" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = concat([
    data.aws_iam_policy_document.foundation_terraform_plan[0].json,
    data.aws_iam_policy_document.saved_plan_approval_apply_read["foundation_terraform"].json,
  ], data.aws_iam_policy_document.foundation_initial_state_observation[*].json)

  statement {
    sid       = "WriteFoundationStateBackend"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.foundation_state_backend_key}"]
  }

  statement {
    sid       = "ReadFoundationApprovalActionExecution"
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = [local.foundation_pipeline_arn]
  }
}

data "aws_iam_policy_document" "foundation_terraform_apply_workload" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ManageFoundationEcr"
    effect = "Allow"
    actions = [
      "ecr:*",
    ]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    sid    = "ManageFoundationEcrSigningConfiguration"
    effect = "Allow"
    actions = [
      "ecr:GetSigningConfiguration",
      "ecr:PutSigningConfiguration",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManageFoundationImageSigningProfile"
    effect = "Allow"
    actions = [
      "signer:*",
    ]
    resources = local.foundation_ecr_signing_profile_arns
  }

  statement {
    sid    = "ManageFoundationSecretsAndConfig"
    effect = "Allow"
    actions = [
      "secretsmanager:*",
      "ssm:*",
    ]
    resources = concat(local.foundation_runtime_secret_arns, local.foundation_runtime_ssm_parameter_arns)
  }

  statement {
    sid    = "ManageFoundationNetworkingReadiness"
    effect = "Allow"
    actions = [
      "ec2:*",
      "acm:*",
      "route53:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManageFoundationManifestStorage"
    effect = "Allow"
    actions = [
      "s3:*",
    ]
    resources = [local.foundation_release_manifest_bucket_arn]
  }

  statement {
    sid    = "CreateFoundationEcrRetentionRole"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = [local.foundation_ecr_retention_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.foundation_ecr_retention_boundary_policy_arn]
    }
  }

  statement {
    sid    = "ManageFoundationEcrRetentionRole"
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = [local.foundation_ecr_retention_role_arn]
  }

  statement {
    sid       = "PassFoundationEcrRetentionRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.foundation_ecr_retention_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid    = "ManageFoundationEcrRetentionLambda"
    effect = "Allow"
    actions = [
      "lambda:AddPermission",
      "lambda:CreateFunction",
      "lambda:DeleteFunction",
      "lambda:DeleteFunctionConcurrency",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConcurrency",
      "lambda:GetPolicy",
      "lambda:GetRuntimeManagementConfig",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
      "lambda:PutFunctionConcurrency",
      "lambda:RemovePermission",
      "lambda:TagResource",
      "lambda:UntagResource",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
    ]
    resources = [local.foundation_ecr_retention_function_arn]
  }

  statement {
    sid    = "ManageFoundationEcrRetentionSchedule"
    effect = "Allow"
    actions = [
      "events:DeleteRule",
      "events:DescribeRule",
      "events:DisableRule",
      "events:EnableRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
      "events:PutRule",
      "events:PutTargets",
      "events:RemoveTargets",
      "events:TagResource",
      "events:UntagResource",
    ]
    resources = [local.foundation_ecr_retention_schedule_arn]
  }

  statement {
    sid    = "ManageFoundationEcrRetentionLogGroup"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DeleteRetentionPolicy",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = [
      local.foundation_ecr_retention_log_group_arn,
      "${local.foundation_ecr_retention_log_group_arn}:*",
    ]
  }

  statement {
    sid       = "ReadFoundationEcrRetentionLogGroup"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "foundation_terraform_apply_workload" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_apply_role_name}-workload"
  policy = data.aws_iam_policy_document.foundation_terraform_apply_workload[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_terraform_apply_workload[0].json))) <= 6144
      )
      error_message = "Foundation Terraform Apply workload policy exceeds the IAM managed-policy size quota."
    }
  }

  depends_on = [aws_iam_policy.terraform_apply_app_lane_policy_admin]
}

resource "aws_iam_role_policy_attachment" "foundation_terraform_apply_workload" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.foundation_terraform_apply[0].name
  policy_arn = aws_iam_policy.foundation_terraform_apply_workload[0].arn
}

resource "aws_iam_role_policy" "foundation_terraform_apply" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_apply_role_name}-policy"
  role   = aws_iam_role.foundation_terraform_apply[0].id
  policy = data.aws_iam_policy_document.foundation_terraform_apply[0].json

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_terraform_apply[0].json))) <= 10240
      error_message = "The Foundation Terraform Apply inline policy must remain within IAM's 10,240-character role-policy quota."
    }
  }
}
