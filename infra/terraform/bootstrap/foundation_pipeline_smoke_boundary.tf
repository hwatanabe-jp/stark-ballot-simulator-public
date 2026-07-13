data "aws_iam_policy_document" "foundation_smoke_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_deploy_permissions_boundary[0].json]

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
    sid    = "FoundationSmokeApplyRetentionBoundaryReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
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
}
