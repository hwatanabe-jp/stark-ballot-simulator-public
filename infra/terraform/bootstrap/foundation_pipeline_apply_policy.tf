data "aws_iam_policy_document" "foundation_terraform_apply" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_terraform_plan[0].json]

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
    resources = [aws_codepipeline.development_foundation[0].arn]
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
    resources = [
      local.foundation_release_manifest_bucket_arn,
      local.foundation_release_manifest_objects_arn,
    ]
  }
}

resource "aws_iam_policy" "foundation_terraform_apply_workload" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_apply_role_name}-workload"
  policy = data.aws_iam_policy_document.foundation_terraform_apply_workload[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

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
}
