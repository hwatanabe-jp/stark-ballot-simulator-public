data "aws_iam_policy_document" "app_static_deploy_common" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json]

  statement {
    sid    = "UseRetainedStaticFrontendArtifact"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.staticFrontendArtifactPrefix}/*",
    ]
  }

  statement {
    sid    = "UseAppPipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
  }

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
    sid    = "ReadStaticFrontendPublicationLeaseHolderBuild"
    effect = "Allow"

    actions = ["codebuild:BatchGetBuilds"]
    resources = compact([
      local.source_path_app_start_build_projects.app_static_deploy.project_arn,
      local.app_static_fast_enabled ? local.source_path_static_fast_start_build_projects.app_static_fast_static_deploy.project_arn : null,
    ])
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

data "aws_iam_policy_document" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_static_deploy_common[0].json]

  statement {
    sid       = "ReadExactAppStaticDeployProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.source_path_app_start_build_projects.app_static_deploy.project_arn]
  }

  statement {
    sid    = "WriteAppStaticDeployLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${local.app_codebuild_log_group_arn_by_project_name[local.app_static_deploy_project_name]}:*",
    ]
  }

  statement {
    sid    = "UseAppFullExecutionArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.app_pipeline_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_execution_artifacts[0].arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [module.app_pipeline_codebuild_log_groups]

  name   = "${local.app_static_deploy_role_name}-policy"
  role   = aws_iam_role.app_static_deploy[0].id
  policy = data.aws_iam_policy_document.app_static_deploy[0].json
}

data "aws_iam_policy_document" "app_static_fast_static_deploy" {
  count = local.app_static_fast_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_static_deploy_common[0].json]

  statement {
    sid       = "ReadExactAppStaticFastDeployProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.source_path_static_fast_start_build_projects.app_static_fast_static_deploy.project_arn]
  }

  statement {
    sid    = "WriteAppStaticFastDeployLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${local.app_codebuild_log_group_arn_by_project_name[local.app_static_fast_static_deploy_project_name]}:*",
    ]
  }

  statement {
    sid    = "UseAppStaticFastExecutionArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.app_static_fast_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "app_static_fast_static_deploy" {
  count = local.app_static_fast_enabled ? 1 : 0

  depends_on = [module.app_pipeline_codebuild_log_groups]

  name   = "${local.app_static_fast_static_deploy_role_name}-policy"
  role   = aws_iam_role.app_static_fast_static_deploy[0].id
  policy = data.aws_iam_policy_document.app_static_fast_static_deploy[0].json
}
