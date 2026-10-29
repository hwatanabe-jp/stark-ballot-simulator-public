locals {
  foundation_app_status_key                    = local.deployment_shared_names.appDeploymentStatusKey
  foundation_app_status_publisher_project_name = local.deployment_shared_names.appDeploymentStatusPublisherProject
  foundation_app_status_publisher_role_name    = local.deployment_shared_names.appDeploymentStatusPublisherRole
  foundation_app_status_publisher_role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_app_status_publisher_role_name}"
  foundation_app_status_object_arn             = "${local.app_retained_artifact_bucket_arn}/${local.foundation_app_status_key}"
  foundation_app_status_acceptance_pointer_object_arn = (
    "${local.app_retained_artifact_bucket_arn}/deployment/${local.deployment_target.targetKey}/app/checkpoint.json"
  )

}

resource "aws_iam_role" "app_deployment_status_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.foundation_app_status_publisher_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["app_deployment_status_publisher"].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })


}

data "aws_iam_policy_document" "app_deployment_status_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  # Direct GitHub source authentication differs from a CodePipeline clone reference.
  statement {
    sid       = "ReadStatusSourceConnection"
    actions   = ["codeconnections:GetConnection", "codeconnections:GetConnectionToken"]
    resources = [aws_codeconnections_connection.source[0].arn]
  }

  statement {
    sid    = "AssertAppStatusPublisherIdentity"
    effect = "Allow"

    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
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
    sid    = "ReadExactAppAcceptanceHistory"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.foundation_app_status_acceptance_pointer_object_arn,
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
    sid       = "ObserveExactAppCheckpointVersion"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.app_retained_artifact_bucket_arn]
    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = ["deployment/${local.deployment_target.targetKey}/app/checkpoint.json"]
    }
    condition {
      test     = "NumericEquals"
      variable = "s3:max-keys"
      values   = ["1"]
    }
  }

  statement {
    sid       = "ObserveExactCurrentStatusVersion"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.app_retained_artifact_bucket_arn]
    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = [local.foundation_app_status_key]
    }
    condition {
      test     = "NumericEquals"
      variable = "s3:max-keys"
      values   = ["1"]
    }
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
  lifecycle {
    # The provider suppresses clearing an old pipeline artifact name. Source
    # identity changes recreate this stateless project and retain its logs.
    replace_triggered_by = [terraform_data.development_app_pipeline_identity_guard]
  }

  concurrent_build_limit = 1
  count                  = local.app_pipeline_enabled ? 1 : 0

  name          = local.foundation_app_status_publisher_project_name
  service_role  = aws_iam_role.app_deployment_status_publisher[0].arn
  build_timeout = 5

  artifacts {
    type = "NO_ARTIFACTS"
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
    type      = "GITHUB"
    location  = "https://github.com/${local.deployment_target.repository}.git"
    buildspec = "infra/terraform/bootstrap/buildspec-app-publish-current-status.yml"
    auth {
      type     = "CODECONNECTIONS"
      resource = aws_codeconnections_connection.source[0].arn
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy.app_deployment_status_publisher]
}
