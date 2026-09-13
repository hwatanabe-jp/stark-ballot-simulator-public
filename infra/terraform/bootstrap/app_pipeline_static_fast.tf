resource "aws_iam_role" "app_static_fast_pipeline" {
  count = local.app_static_fast_enabled ? 1 : 0

  name                 = local.app_static_fast_pipeline_role_name
  assume_role_policy   = data.aws_iam_policy_document.pipeline_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_gate_and_build" {
  count = local.app_static_fast_enabled ? 1 : 0

  name                 = local.app_static_fast_gate_and_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_static_deploy" {
  count = local.app_static_fast_enabled ? 1 : 0

  name                 = local.app_static_fast_static_deploy_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_apply_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_fast_smoke_lite" {
  count = local.app_static_fast_enabled ? 1 : 0

  name                 = local.app_static_fast_smoke_lite_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_smoke_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

data "aws_iam_policy_document" "app_static_fast_pipeline" {
  count = local.app_static_fast_enabled ? 1 : 0

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
    resources = local.app_static_fast_codebuild_project_arns
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
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
  }
}

resource "aws_iam_role_policy" "app_static_fast_pipeline" {
  count = local.app_static_fast_enabled ? 1 : 0

  depends_on = [
    aws_codebuild_project.app_static_fast_gate_and_build,
    aws_codebuild_project.app_static_fast_smoke_lite,
    aws_codebuild_project.app_static_fast_static_deploy,
  ]

  name   = "${local.app_static_fast_pipeline_role_name}-policy"
  role   = aws_iam_role.app_static_fast_pipeline[0].id
  policy = data.aws_iam_policy_document.app_static_fast_pipeline[0].json
}

check "app_static_fast_pipeline_inline_policy_size" {
  assert {
    condition = (
      !local.app_static_fast_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_static_fast_pipeline[0].json))) <= 10240, false)
    )
    error_message = "The static-fast pipeline inline policy must remain within IAM's 10,240-character role-policy quota."
  }
}

data "aws_iam_policy_document" "app_static_fast_gate_and_build" {
  count = local.app_static_fast_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json]

  statement {
    sid       = "ReadExactAppStaticFastGateProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.source_path_static_fast_start_build_projects.app_static_fast_gate_and_build.project_arn]
  }

  statement {
    sid    = "WriteAppStaticFastGateLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${local.app_codebuild_log_group_arn_by_project_name[local.app_static_fast_gate_project_name]}:*",
    ]
  }

  statement {
    sid    = "ReadCurrentAppAcceptanceEvidence"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPointerKey}",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/acceptances/*",
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*/attempts/*/apply-outputs.json",
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
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
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
  count = local.app_static_fast_enabled ? 1 : 0

  depends_on = [module.app_pipeline_codebuild_log_groups]

  name   = "${local.app_static_fast_gate_and_build_role_name}-policy"
  role   = aws_iam_role.app_static_fast_gate_and_build[0].id
  policy = data.aws_iam_policy_document.app_static_fast_gate_and_build[0].json
}

data "aws_iam_policy_document" "app_static_fast_smoke_lite" {
  count = local.app_static_fast_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json]

  statement {
    sid       = "ReadExactAppStaticFastSmokeProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.source_path_static_fast_start_build_projects.app_static_fast_smoke_lite.project_arn]
  }

  statement {
    sid    = "WriteAppStaticFastSmokeLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${local.app_codebuild_log_group_arn_by_project_name[local.app_static_fast_smoke_project_name]}:*",
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
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
  }
}

resource "aws_iam_role_policy" "app_static_fast_smoke_lite" {
  count = local.app_static_fast_enabled ? 1 : 0

  depends_on = [module.app_pipeline_codebuild_log_groups]

  name   = "${local.app_static_fast_smoke_lite_role_name}-policy"
  role   = aws_iam_role.app_static_fast_smoke_lite[0].id
  policy = data.aws_iam_policy_document.app_static_fast_smoke_lite[0].json
}

resource "aws_codebuild_project" "app_static_fast_gate_and_build" {
  count = local.app_static_fast_enabled ? 1 : 0

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
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-static-fast-gate-and-build.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_fast_static_deploy" {
  count = local.app_static_fast_enabled ? 1 : 0

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
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-static-deploy.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_fast_smoke_lite" {
  count = local.app_static_fast_enabled ? 1 : 0

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
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-static-fast-smoke-lite.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codepipeline" "app_static_fast" {
  count = local.app_static_fast_enabled ? 1 : 0

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
