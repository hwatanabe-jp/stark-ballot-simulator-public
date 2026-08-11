data "aws_iam_policy_document" "foundation_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid     = "FoundationArtifactAndStateGuardrail"
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}/*",
      "arn:aws:s3:::${var.state_bucket_name}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}.tflock",
    ]
  }

  statement {
    sid       = "FoundationKmsGuardrail"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationPipelineGuardrail"
    effect = "Allow"
    actions = [
      "codebuild:*",
      "codepipeline:*",
      "logs:*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationSourceConnectionGuardrail"
    effect = "Allow"
    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:PassConnection",
      "codeconnections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
      "codestar-connections:PassConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.foundation_source_connection_arns
  }

  statement {
    sid    = "FoundationNetworkingGuardrail"
    effect = "Allow"
    actions = [
      "acm:*",
      "ec2:*",
      "route53:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationWorkloadGuardrail"
    effect = "Allow"
    actions = [
      "ecr:*",
      "s3:*",
      "secretsmanager:*",
      "ssm:*",
    ]
    resources = concat(
      [
        local.foundation_release_manifest_bucket_arn,
        local.foundation_release_manifest_objects_arn,
      ],
      local.foundation_ecr_repository_arns,
      local.foundation_runtime_secret_arns,
      local.foundation_runtime_ssm_parameter_arns,
    )
  }

  statement {
    sid    = "FoundationEcrSigningConfigurationGuardrail"
    effect = "Allow"
    actions = [
      "ecr:GetSigningConfiguration",
      "ecr:PutSigningConfiguration",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationImageSigningProfileGuardrail"
    effect = "Allow"
    actions = [
      "signer:*",
    ]
    resources = local.foundation_ecr_signing_profile_arns
  }

  statement {
    sid       = "FoundationSigningJobRevocationReadGuardrail"
    effect    = "Allow"
    actions   = ["signer:GetRevocationStatus"]
    resources = [local.foundation_signing_job_arn_pattern]
  }

  statement {
    sid    = "FoundationEcrAuthGuardrail"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "FoundationWorkloadReadGuardrail"
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    sid       = "FoundationIamGuardrail"
    effect    = "Allow"
    actions   = ["iam:*"]
    resources = [local.foundation_pipeline_role_arn_pattern]
  }

  statement {
    sid    = "FoundationEcrRetentionRoleReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = [local.foundation_ecr_retention_role_arn]
  }

  statement {
    sid    = "FoundationEcrRetentionBoundaryReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetPolicy*",
      "iam:ListPolicyVersions",
    ]
    resources = [local.foundation_ecr_retention_boundary_policy_arn]
  }

  statement {
    sid    = "FoundationEcrRetentionLambdaReadGuardrail"
    effect = "Allow"
    actions = [
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConcurrency",
      "lambda:GetPolicy",
      "lambda:GetRuntimeManagementConfig",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
    ]
    resources = [local.foundation_ecr_retention_function_arn]
  }

  statement {
    sid    = "FoundationEcrRetentionScheduleReadGuardrail"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
    ]
    resources = [local.foundation_ecr_retention_schedule_arn]
  }
}

resource "aws_iam_policy" "foundation_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  name   = local.foundation_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_deploy_permissions_boundary[0].json))) <= 6144
      )
      error_message = "Foundation deploy permissions boundary exceeds the IAM managed-policy size quota."
    }
  }
}
