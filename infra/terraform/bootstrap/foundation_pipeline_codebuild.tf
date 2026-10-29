resource "aws_codebuild_project" "foundation_terraform_plan" {
  concurrent_build_limit = 1
  count                  = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_terraform_plan_project_name
  service_role  = aws_iam_role.foundation_terraform_plan[0].arn
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
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.foundation_terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-foundation-plan.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_terraform_apply" {
  concurrent_build_limit = 1
  count                  = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_terraform_apply_project_name
  service_role  = aws_iam_role.foundation_terraform_apply[0].arn
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
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.foundation_terraform_apply_project_name].name
      stream_name = "apply"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-foundation-apply.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_smoke" {
  concurrent_build_limit = 1
  count                  = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_smoke_project_name
  service_role  = aws_iam_role.foundation_terraform_smoke[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "FOUNDATION_APPLY_BOUNDARY_ARN"
      value = local.foundation_apply_deploy_permissions_boundary_policy_arn
    }

    environment_variable {
      name  = "FOUNDATION_APPLY_WORKLOAD_POLICY_ARN"
      value = local.foundation_terraform_apply_workload_policy_arn
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.foundation_smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-foundation-smoke.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
