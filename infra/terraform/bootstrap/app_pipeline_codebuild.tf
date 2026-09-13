resource "aws_codebuild_project" "app_execution_authority" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_execution_authority_project_name
  service_role  = aws_iam_role.app_execution_authority[0].arn
  build_timeout = 15

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "APP_EXPECTED_AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_execution_authority_project_name].name
      stream_name = "release-resolution"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-release-resolution.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_terraform_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_terraform_plan_project_name
  service_role  = aws_iam_role.app_terraform_plan[0].arn
  build_timeout = 50

  artifacts {
    type = "CODEPIPELINE"
  }

  cache {
    type     = "S3"
    location = "${aws_s3_bucket.app_pipeline_artifacts[0].bucket}/codebuild-cache/${local.app_terraform_plan_project_name}"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_ACCOUNT_ALIAS"
      value = var.account_alias
    }

    environment_variable {
      name  = "APP_BACKEND_CONFIG_BASE64"
      value = base64encode(local.app_backend_config_content)
    }

    environment_variable {
      name  = "APP_DEPLOYMENT_ENVIRONMENT"
      value = var.deployment_environment
    }

    environment_variable {
      name  = "APP_EXPECTED_AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_EXPECTED_AWS_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_BUCKET"
      value = local.app_retained_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_PIPELINE_TFVARS_BASE64"
      value = base64encode(local.app_pipeline_tfvars_content)
    }

    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_KMS_KEY_ID"
      value = var.state_kms_alias
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_REGION"
      value = var.aws_region
    }

  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-terraform-plan.yml"
  }
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_terraform_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_terraform_apply_project_name
  service_role  = aws_iam_role.app_terraform_apply[0].arn
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
      name  = "APP_BACKEND_CONFIG_BASE64"
      value = base64encode(local.app_backend_config_content)
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_KMS_KEY_ID"
      value = var.state_kms_alias
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_terraform_apply_project_name].name
      stream_name = "apply"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-terraform-apply.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_smoke_project_name
  service_role  = aws_iam_role.app_terraform_smoke[0].arn
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
      name  = "APP_AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_BUCKET"
      value = local.app_retained_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "APP_AWS_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_DEPLOYMENT_ENVIRONMENT"
      value = var.deployment_environment
    }

    environment_variable {
      name  = "APP_TERRAFORM_SMOKE_ROLE_NAME"
      value = local.app_terraform_smoke_role_name
    }

    environment_variable {
      name  = "APP_ACCEPTANCE_PUBLISHER_ROLE_ARN"
      value = local.app_acceptance_publisher_role_arn
    }

    environment_variable {
      name  = "APP_STATE_BUCKET_ARN"
      value = aws_s3_bucket.state.arn
    }

    environment_variable {
      name  = "APP_STATE_KMS_KEY_ARN"
      value = aws_kms_key.state.arn
    }

    environment_variable {
      name  = "APP_TERRAFORM_SMOKE_ROLE_ARN"
      value = aws_iam_role.app_terraform_smoke[0].arn
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_KMS_KEY_ID"
      value = var.state_kms_alias
    }

  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-smoke.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_deploy_project_name
  service_role  = aws_iam_role.app_static_deploy[0].arn
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
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_static_deploy_project_name].name
      stream_name = "static-deploy"
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
