data "aws_iam_policy_document" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}/*",
      "arn:aws:s3:::${var.state_bucket_name}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}.tflock",
      local.foundation_release_manifest_bucket_arn,
      local.foundation_release_manifest_objects_arn,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["logs:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = ["arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.foundation_pipeline_name}"]
  }

  statement {
    effect = "Allow"
    actions = [
      "acm:*",
      "ec2:*",
      "route53:*",
    ]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["ecr:*"]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:GetSigningConfiguration",
      "ecr:PutSigningConfiguration",
    ]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["signer:*"]
    resources = concat(local.foundation_ecr_signing_profile_arns, [local.foundation_signing_job_arn_pattern])
  }

  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:*",
      "ssm:*",
    ]
    resources = concat(local.foundation_runtime_secret_arns, local.foundation_runtime_ssm_parameter_arns)
  }

  statement {
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
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
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.foundation_ecr_retention_boundary_policy_arn]
  }

  statement {
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
    effect    = "Allow"
    actions   = ["lambda:*"]
    resources = [local.foundation_ecr_retention_function_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["events:*"]
    resources = [local.foundation_ecr_retention_schedule_arn]
  }

  statement {
    sid    = "DenyDeletingRetainedFoundationImages"
    effect = "Deny"
    actions = [
      "ecr:BatchDeleteImage",
      "ecr:DeleteRepository",
      "ecr:PutLifecyclePolicy",
    ]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    sid    = "DenyDeletingImmutableReleaseAuthority"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      "${local.foundation_release_manifest_bucket_arn}/artifacts/*",
      "${local.foundation_release_manifest_bucket_arn}/candidates/*",
      "${local.foundation_release_manifest_bucket_arn}/promotions/*",
      "${local.foundation_release_manifest_bucket_arn}/deployments/*",
      "${local.foundation_release_manifest_bucket_arn}/rollbacks/*",
      "${local.foundation_release_manifest_bucket_arn}/reissue/*",
      local.foundation_toolchain_accepted_pointer_object_arn,
      local.foundation_prover_accepted_pointer_object_arn,
    ]
  }

  statement {
    sid       = "DenyAddingReleaseAuthorityLifecycle"
    effect    = "Deny"
    actions   = ["s3:PutLifecycleConfiguration"]
    resources = [local.foundation_release_manifest_bucket_arn]
  }
}

resource "aws_iam_policy" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    terraform_data.bootstrap_apply_authorization_propagation,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  name   = local.foundation_apply_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json))) <= 6144
      )
      error_message = "Foundation Apply permissions boundary exceeds the IAM managed-policy size quota."
    }
  }
}
