locals {
  foundation_app_status_key                    = local.deployment_shared_names.appDeploymentStatusKey
  foundation_app_status_publisher_project_name = local.deployment_shared_names.appDeploymentStatusPublisherProject
  foundation_app_status_publisher_project_arn  = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.foundation_app_status_publisher_project_name}"
  foundation_app_status_publisher_role_name    = local.deployment_shared_names.appDeploymentStatusPublisherRole
  foundation_app_status_publisher_role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_app_status_publisher_role_name}"
  foundation_app_status_object_arn             = "${local.app_retained_artifact_bucket_arn}/${local.foundation_app_status_key}"
  foundation_app_status_acceptance_pointer_object_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPointerKey}"
  )
  foundation_app_status_acceptance_records_object_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/acceptances/*"
  )
  foundation_app_status_execution_artifact_bucket_arn = (
    "arn:aws:s3:::${local.app_lane_authority.names.artifactBucket}"
  )
  foundation_app_status_publisher_env_variables = jsonencode([
    {
      name  = "APP_STATUS_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
  ])
}

resource "aws_iam_role" "app_deployment_status_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.foundation_app_status_publisher_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

data "aws_iam_policy_document" "app_deployment_status_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json]

  statement {
    sid    = "AssertAppStatusPublisherIdentity"
    effect = "Allow"

    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadExactAppStatusProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.foundation_app_status_publisher_project_arn]
  }

  statement {
    sid    = "WriteAppStatusPublisherLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${local.app_codebuild_log_group_arn_by_project_name[local.foundation_app_status_publisher_project_name]}:*",
    ]
  }

  statement {
    sid    = "ReadAppStatusSourceArtifact"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${local.foundation_app_status_execution_artifact_bucket_arn}/*"]
  }

  statement {
    sid    = "ReadExactAppAcceptanceHistory"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.foundation_app_status_acceptance_pointer_object_arn,
      local.foundation_app_status_acceptance_records_object_arn,
    ]
  }

  statement {
    sid    = "ReadAndConditionallyWriteCurrentAppStatus"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_app_status_object_arn]
  }

  statement {
    sid       = "DescribeExactAppStatusArtifactKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:RequestAlias"
      values   = [local.app_lane_authority.names.artifactKmsAlias]
    }
  }

  statement {
    sid    = "UseExactAppStatusArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values = [
        local.app_retained_artifact_bucket_arn,
        local.foundation_app_status_execution_artifact_bucket_arn,
      ]
    }
  }
}

resource "aws_iam_role_policy" "app_deployment_status_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [module.app_pipeline_codebuild_log_groups]

  name   = "${local.foundation_app_status_publisher_role_name}-policy"
  role   = aws_iam_role.app_deployment_status_publisher[0].id
  policy = data.aws_iam_policy_document.app_deployment_status_publisher[0].json
}

check "app_deployment_status_publisher_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_deployment_status_publisher[0].json))) <= 10240, false)
    )
    error_message = "The App deployment-status publisher identity policy must remain within the inline-policy quota."
  }
}

resource "aws_codebuild_project" "app_deployment_status_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.foundation_app_status_publisher_project_name
  service_role  = aws_iam_role.app_deployment_status_publisher[0].arn
  build_timeout = 5

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = false
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.foundation_app_status_publisher_project_name].name
      stream_name = "publish-current-status"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-publish-current-status.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy.app_deployment_status_publisher]
}
