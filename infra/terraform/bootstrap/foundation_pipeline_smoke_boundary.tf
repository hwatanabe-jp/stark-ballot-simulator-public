data "aws_iam_policy_document" "foundation_smoke_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  # Keep this ceiling independent of resources whose key policies trust the
  # smoke role. The attached identity policies narrow these guardrails to the
  # exact KMS keys and log streams after IAM intersects the two policy layers.
  statement {
    sid    = "FoundationSmokeBuildLogsGuardrail"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "FoundationSmokeCallerIdentityGuardrail"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationSmokePipelineArtifactsGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}/*",
    ]
  }

  statement {
    sid    = "FoundationSmokeKmsGuardrail"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationAcceptedBaselinePublisherGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.foundation_lane_authority.stateIdentity}/executions/*",
      "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.foundation_lane_authority.stateIdentity}/current.json",
    ]
  }

  statement {
    sid       = "FoundationSmokeSigningConfigurationReadGuardrail"
    effect    = "Allow"
    actions   = ["ecr:GetSigningConfiguration"]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationSmokeRetentionReadGuardrail"
    effect = "Allow"
    actions = [
      "ecr:GetLifecyclePolicy",
      "s3:GetBucketPolicy",
      "s3:GetLifecycleConfiguration",
    ]
    resources = concat(
      [local.foundation_release_manifest_bucket_arn],
      local.foundation_ecr_repository_arns,
    )
  }

  statement {
    sid    = "FoundationAppNetworkingHandoffGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_app_networking_object_arn]
  }

  statement {
    sid    = "FoundationImageSigningAuthorityGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_image_signing_authority_objects_arn]
  }

  statement {
    sid    = "FoundationSmokeApplyRetentionBoundaryReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:SimulatePrincipalPolicy",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}",
    ]
  }

  statement {
    sid    = "FoundationSmokeApplyRetentionBoundaryPolicyReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = [
      local.foundation_apply_deploy_permissions_boundary_policy_arn,
      local.foundation_terraform_apply_workload_policy_arn,
    ]
  }

  statement {
    sid    = "FoundationSmokeEcrRetentionRoleReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = [local.foundation_ecr_retention_role_arn]
  }

  statement {
    sid    = "FoundationSmokeEcrRetentionBoundaryReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.foundation_ecr_retention_boundary_policy_arn]
  }

  statement {
    sid    = "FoundationSmokeEcrRetentionLambdaReadGuardrail"
    effect = "Allow"
    actions = [
      "lambda:GetFunction",
      "lambda:GetFunctionConcurrency",
      "lambda:GetPolicy",
      "lambda:ListTags",
    ]
    resources = [local.foundation_ecr_retention_function_arn]
  }

  statement {
    sid    = "FoundationSmokeEcrRetentionScheduleReadGuardrail"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
    ]
    resources = [local.foundation_ecr_retention_schedule_arn]
  }
}

resource "aws_iam_policy" "foundation_smoke_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  name   = local.foundation_smoke_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_smoke_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_smoke_deploy_permissions_boundary[0].json))) <= 6144
      )
      error_message = "Foundation smoke permissions boundary exceeds the IAM managed-policy size quota."
    }
  }
}
