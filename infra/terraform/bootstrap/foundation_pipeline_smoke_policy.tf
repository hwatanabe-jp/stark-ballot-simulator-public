data "aws_iam_policy_document" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_codebuild_common[0].json]

  statement {
    sid       = "ReadFoundationStateKeyIdentityForSmoke"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.state.arn]
  }

  statement {
    sid       = "AssumeFoundationAcceptancePublisher"
    effect    = "Allow"
    actions   = ["sts:AssumeRole"]
    resources = [local.foundation_terraform_acceptance_publisher_role_arn]
  }

  statement {
    sid       = "ReadFoundationSigningConfigurationForSmoke"
    effect    = "Allow"
    actions   = ["ecr:GetSigningConfiguration"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadFoundationImageRetentionForSmoke"
    effect    = "Allow"
    actions   = ["ecr:GetLifecyclePolicy"]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    sid    = "ReadFoundationManifestRetentionForSmoke"
    effect = "Allow"
    actions = [
      "s3:GetBucketPolicy",
      "s3:GetBucketVersioning",
      "s3:GetLifecycleConfiguration",
    ]
    resources = [local.foundation_release_manifest_bucket_arn]
  }

  statement {
    sid    = "ReadTerraformAuthorityForSmoke"
    effect = "Allow"
    actions = [
      "s3:GetBucketPolicy",
      "s3:GetBucketVersioning",
    ]
    resources = [local.terraform_authority_bucket_arn]
  }

  statement {
    sid    = "ReadFoundationApplyRetentionBoundaryForSmoke"
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
    sid    = "ReadFoundationApplyRetentionBoundaryPolicyForSmoke"
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
    sid    = "ReadFoundationEcrRetentionRoleForSmoke"
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
    sid    = "ReadFoundationEcrRetentionBoundaryForSmoke"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.foundation_ecr_retention_boundary_policy_arn]
  }

  statement {
    sid    = "ReadFoundationEcrRetentionLambdaForSmoke"
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
    sid    = "ReadFoundationEcrRetentionScheduleForSmoke"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
    ]
    resources = [local.foundation_ecr_retention_schedule_arn]
  }

  statement {
    sid       = "ReadFoundationEcrRetentionLogGroupForSmoke"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_smoke_role_name}-policy"
  role   = aws_iam_role.foundation_terraform_smoke[0].id
  policy = data.aws_iam_policy_document.foundation_terraform_smoke[0].json
}
