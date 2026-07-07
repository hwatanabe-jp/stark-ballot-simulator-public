data "aws_iam_policy_document" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_codebuild_common[0].json]

  statement {
    sid    = "DeployTargetStaticFrontend"
    effect = "Allow"

    actions = [
      "s3:DeleteObject",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
      "s3:PutObjectTagging",
    ]

    resources = [
      local.app_target_frontend_bucket_arn,
      "${local.app_target_frontend_bucket_arn}/*",
    ]
  }

  statement {
    sid    = "InvalidateTargetCloudFrontDistribution"
    effect = "Allow"

    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetDistribution",
      "cloudfront:GetInvalidation",
    ]

    resources = [local.app_target_cloudfront_distribution_arn]
  }

  statement {
    sid    = "ReadTargetBrowserPublicConfig"
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
    ]

    resources = local.app_browser_public_config_parameter_arns
  }
}

resource "aws_iam_role_policy" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_deploy_role_name}-policy"
  role   = aws_iam_role.app_static_deploy[0].id
  policy = data.aws_iam_policy_document.app_static_deploy[0].json
}
