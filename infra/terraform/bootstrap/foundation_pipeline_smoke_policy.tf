data "aws_iam_policy_document" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = concat([data.aws_iam_policy_document.foundation_codebuild_common[0].json, data.aws_iam_policy_document.foundation_gateway_logging_read.json], [data.aws_iam_policy_document.foundation_retained_image_logs_read.json])

  statement {
    sid       = "ReadFoundationStateKeyIdentityForSmoke"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.state.arn]
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

}

resource "aws_iam_role_policy" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_smoke_role_name}-policy"
  role   = aws_iam_role.foundation_terraform_smoke[0].id
  policy = data.aws_iam_policy_document.foundation_terraform_smoke[0].json
}
