resource "aws_iam_role" "app_static_fast_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_pipeline_role_name
  assume_role_policy   = data.aws_iam_policy_document.pipeline_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_gate_and_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_static_deploy_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_apply_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_fast_smoke_lite_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_smoke_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

data "aws_iam_policy_document" "app_static_fast_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
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
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "RunAppStaticFastCodeBuildProjects"
    effect = "Allow"

    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
    ]
    resources = [
      aws_codebuild_project.app_static_fast_gate_and_build[0].arn,
      aws_codebuild_project.app_static_fast_static_deploy[0].arn,
      aws_codebuild_project.app_static_fast_smoke_lite[0].arn,
    ]
  }

  statement {
    sid    = "UseAppStaticFastPipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.app_static_fast_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid       = "ListAppStaticFastPipelineArtifacts"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.app_static_fast_execution_artifacts[0].arn]
  }

  statement {
    sid    = "UseAppStaticFastArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "app_static_fast_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_fast_pipeline_role_name}-policy"
  role   = aws_iam_role.app_static_fast_pipeline[0].id
  policy = data.aws_iam_policy_document.app_static_fast_pipeline[0].json
}

data "aws_iam_policy_document" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "WriteAppStaticFastGateLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${module.app_pipeline_codebuild_log_groups.log_groups[local.app_static_fast_gate_project_name].arn}:*",
    ]
  }

  statement {
    sid    = "ReadAcceptedAppDeploymentEvidence"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPointerKey}",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*/attempts/*/authoritative-app-deployment.json",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*/attempts/*/apply-outputs.json",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*/attempts/*/static-frontend-deploy.json",
    ]
  }

  statement {
    sid    = "ReadAppStaticFastPipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*"]
  }

  statement {
    sid       = "WriteAppStaticFastPipelineArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*"]
  }

  statement {
    sid       = "ListAppStaticFastPipelineArtifacts"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.app_static_fast_execution_artifacts[0].arn]
  }

  statement {
    sid    = "UseAppStaticFastArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
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

resource "aws_iam_role_policy" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_fast_gate_and_build_role_name}-policy"
  role   = aws_iam_role.app_static_fast_gate_and_build[0].id
  policy = data.aws_iam_policy_document.app_static_fast_gate_and_build[0].json
}

data "aws_iam_policy_document" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"
    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "WriteAppStaticFastSmokeLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${module.app_pipeline_codebuild_log_groups.log_groups[local.app_static_fast_smoke_project_name].arn}:*",
    ]
  }

  statement {
    sid    = "ReadAppStaticFastSmokeArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.app_static_fast_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid       = "WriteAppStaticFastSmokeArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_static_fast_execution_artifacts[0].arn}/*"]
  }

  statement {
    sid    = "UseAppStaticFastSmokeArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_static_fast_smoke_lite_role_name}-policy"
  role   = aws_iam_role.app_static_fast_smoke_lite[0].id
  policy = data.aws_iam_policy_document.app_static_fast_smoke_lite[0].json
}

resource "aws_codebuild_project" "app_static_fast_gate_and_build" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_gate_project_name
  service_role  = aws_iam_role.app_static_fast_gate_and_build[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_static_fast_gate_project_name].name
      stream_name = "static-fast-gate-and-build"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-static-fast-gate-and-build.yml.tftpl", {
      aws_account_id    = var.aws_account_id
      entrypoint_sha256 = filesha256("${path.module}/app-pipeline-scripts/app-static-fast-gate-and-build.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_fast_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_static_deploy_project_name
  service_role  = aws_iam_role.app_static_fast_static_deploy[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_static_fast_static_deploy_project_name].name
      stream_name = "static-fast-static-deploy"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-static-deploy.yml.tftpl", {
      entrypoint_sha256 = filesha256("${path.module}/app-pipeline-scripts/app-static-deploy.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_fast_smoke_lite" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_smoke_project_name
  service_role  = aws_iam_role.app_static_fast_smoke_lite[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_static_fast_smoke_project_name].name
      stream_name = "static-fast-smoke-lite"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-static-fast-smoke-lite.yml.tftpl", {
      entrypoint_sha256 = filesha256("${path.module}/app-pipeline-scripts/app-static-fast-smoke-lite.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codepipeline" "app_static_fast" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_fast_pipeline_name
  pipeline_type = "V2"
  role_arn      = aws_iam_role.app_static_fast_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.app_static_fast_execution_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.app_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  variable {
    name        = "RequestedSourceSha"
    description = "Required exact source SHA; the Source override, Source action output, and GateAndBuild resolution must match it."
  }

  stage {
    name = local.deployment_target.sourceAction

    action {
      name             = local.deployment_target.sourceAction
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "StaticFastSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = local.deployment_target.sourceBranch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = local.deployment_target.repository
        OutputArtifactFormat = "CODEBUILD_CLONE_REF"
      }
    }
  }

  stage {
    name = "GateAndBuild"

    action {
      name             = "GateAndBuild"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ApplyOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "STATIC_FAST_REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "STATIC_FAST_SOURCE_ACTION_SHA"
            value = "#{StaticFastSource.CommitId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_static_fast_gate_and_build[0].name
      }
    }
  }

  stage {
    name = "StaticFrontendDeploy"

    action {
      name             = "DeployStaticFrontend"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ApplyOutput"]
      output_artifacts = ["StaticDeployOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_static_fast_static_deploy[0].name
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_DEPLOYMENT_MODE"
            value = "normal"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_SOURCE_SHA"
            value = "#{StaticFastSource.CommitId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_STATIC_FAST_MODE"
            value = "true"
            type  = "PLAINTEXT"
          },
        ])
      }
    }
  }

  stage {
    name = "SmokeLite"

    action {
      name            = "SmokeLite"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput", "StaticDeployOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_static_fast_smoke_lite[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
