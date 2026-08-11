resource "aws_codebuild_project" "app_signature_state_refresh_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_state_refresh_plan_project_name
  service_role  = aws_iam_role.app_signature_preflight_plan[0].arn
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
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_state_refresh_plan_project_name].name
      stream_name = "signature-state-refresh-plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-signature-state-refresh-plan.yml.tftpl", {
      app_backend_config_base64  = base64encode(local.app_backend_config_content)
      app_pipeline_tfvars_base64 = base64encode(local.app_pipeline_tfvars_content)
      aws_account_id             = var.aws_account_id
      entrypoint_sha256          = filesha256("${path.module}/app-signature-preflight-scripts/app-signature-state-refresh-plan.sh")
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_state_refresh_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_state_refresh_apply_project_name
  service_role  = aws_iam_role.app_signature_state_refresh_apply[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_STATE_REFRESH_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_STATE_REFRESH_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_STATE_REFRESH_PIPELINE_NAME"
      value = local.app_pipeline_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_state_refresh_apply_project_name].name
      stream_name = "signature-state-refresh-apply"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-signature-state-refresh-apply.yml.tftpl", {
      entrypoint_sha256          = filesha256("${path.module}/app-signature-preflight-scripts/app-signature-state-refresh-apply.sh")
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_preflight_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_preflight_plan_project_name
  service_role  = aws_iam_role.app_signature_preflight_plan[0].arn
  build_timeout = 30

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_PREFLIGHT_ARTIFACT_BUCKET"
      value = local.app_retained_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_PREFLIGHT_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PREFLIGHT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PREFLIGHT_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_KEY"
      value = local.app_state_backend_key
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_preflight_plan_project_name].name
      stream_name = "signature-preflight-plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-signature-preflight-plan.yml.tftpl", {
      app_backend_config_base64  = base64encode(local.app_backend_config_content)
      app_pipeline_tfvars_base64 = base64encode(local.app_pipeline_tfvars_content)
      entrypoint_sha256          = filesha256("${path.module}/app-signature-preflight-scripts/app-signature-preflight-plan.sh")
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_preflight_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_preflight_apply_project_name
  service_role  = aws_iam_role.app_signature_preflight_apply[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_PREFLIGHT_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PREFLIGHT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PREFLIGHT_PIPELINE_NAME"
      value = local.app_pipeline_name
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_KEY"
      value = local.app_state_backend_key
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_preflight_apply_project_name].name
      stream_name = "signature-preflight-apply"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-signature-preflight-apply.yml.tftpl", {
      entrypoint_sha256          = filesha256("${path.module}/app-signature-preflight-scripts/app-signature-preflight-apply.sh")
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_preflight_invoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_preflight_invoke_project_name
  service_role  = aws_iam_role.app_signature_preflight_invoker[0].arn
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
      name  = "APP_PREFLIGHT_ARTIFACT_BUCKET"
      value = local.app_retained_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_PREFLIGHT_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PREFLIGHT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PREFLIGHT_ALIAS_ARN"
      value = local.app_signature_preflight_alias_arn
    }

    environment_variable {
      name  = "APP_PREFLIGHT_SIGNING_PROFILE_ARN"
      value = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-profiles/${replace(local.app_runtime_name_prefix, "-", "_")}_ecr"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_preflight_invoke_project_name].name
      stream_name = "signature-preflight-invoke"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-signature-preflight-invoke.yml.tftpl", {
      entrypoint_sha256 = filesha256("${path.module}/app-signature-preflight-scripts/app-signature-preflight-invoke.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
