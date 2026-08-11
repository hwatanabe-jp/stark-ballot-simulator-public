resource "aws_codebuild_project" "foundation_validate" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_validate_project_name
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
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.foundation_validate_project_name].name
      stream_name = "validate"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-foundation-validate.yml.tftpl", {
      aws_account_id               = var.aws_account_id
      entrypoint_sha256            = filesha256("${path.module}/foundation-pipeline-scripts/foundation-validate.sh")
      foundation_state_backend_key = local.foundation_state_backend_key
      state_bucket_name            = aws_s3_bucket.state.bucket
      state_kms_alias              = var.state_kms_alias
      terraform_install_commands   = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_terraform_plan" {
  count = local.foundation_pipeline_enabled ? 1 : 0

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
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-foundation-plan.yml.tftpl", {
      entrypoint_sha256            = filesha256("${path.module}/foundation-pipeline-scripts/foundation-plan.sh")
      foundation_state_backend_key = local.foundation_state_backend_key
      state_bucket_name            = aws_s3_bucket.state.bucket
      state_kms_alias              = var.state_kms_alias
      terraform_install_commands   = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_terraform_apply" {
  count = local.foundation_pipeline_enabled ? 1 : 0

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
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-foundation-apply.yml.tftpl", {
      entrypoint_sha256            = filesha256("${path.module}/foundation-pipeline-scripts/foundation-apply.sh")
      foundation_state_backend_key = local.foundation_state_backend_key
      state_bucket_name            = aws_s3_bucket.state.bucket
      state_kms_alias              = var.state_kms_alias
      terraform_install_commands   = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

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
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.foundation_smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-foundation-smoke.yml.tftpl", {
      entrypoint_sha256                    = filesha256("${path.module}/foundation-pipeline-scripts/foundation-smoke.sh")
      foundation_apply_boundary_arn        = local.foundation_apply_deploy_permissions_boundary_policy_arn
      foundation_apply_workload_policy_arn = local.foundation_terraform_apply_workload_policy_arn
      foundation_state_backend_key         = local.foundation_state_backend_key
      state_bucket_name                    = aws_s3_bucket.state.bucket
      state_kms_alias                      = var.state_kms_alias
      state_kms_key_arn                    = aws_kms_key.state.arn
      terraform_install_commands           = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
