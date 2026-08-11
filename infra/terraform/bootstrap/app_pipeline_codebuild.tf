resource "aws_codebuild_project" "app_deployment_record" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_deployment_record_project_name
  service_role  = aws_iam_role.app_deployment_record[0].arn
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
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_deployment_record_project_name].name
      stream_name = "app-deployment-record"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-deployment-record.yml.tftpl", {
      entrypoint_sha256 = filesha256("${path.module}/app-pipeline-scripts/app-deployment-record-build.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_validate" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_validate_project_name
  service_role  = aws_iam_role.app_terraform_plan[0].arn
  build_timeout = 30

  artifacts {
    type = "CODEPIPELINE"
  }

  cache {
    type     = "S3"
    location = "${aws_s3_bucket.app_pipeline_artifacts[0].bucket}/codebuild-cache/${local.app_validate_project_name}"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_validate_project_name].name
      stream_name = "validate"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-validate.yml.tftpl", {
      entrypoint_sha256          = filesha256("${path.module}/app-pipeline-scripts/app-validate.sh")
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_terraform_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_terraform_plan_project_name
  service_role  = aws_iam_role.app_terraform_plan[0].arn
  build_timeout = 20

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

    environment_variable {
      name  = "TERRAFORM_DISTRIBUTION_SHA256"
      value = local.terraform_distribution_sha256
    }

    environment_variable {
      name  = "TERRAFORM_VERSION"
      value = var.terraform_version
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
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_terraform_apply_project_name].name
      stream_name = "apply"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-terraform-apply.yml.tftpl", {
      app_backend_config_base64  = base64encode(local.app_backend_config_content)
      entrypoint_sha256          = filesha256("${path.module}/app-pipeline-scripts/app-terraform-apply.sh")
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
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
      name  = "APP_ACCEPTED_MARKER_PATH"
      value = local.app_accepted_marker_path
    }

    environment_variable {
      name  = "APP_ACCEPTED_DEPLOYMENT_RETENTION_COUNT"
      value = tostring(local.app_accepted_deployment_retention_count)
    }

    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_RETENTION_DAYS"
      value = tostring(local.storage_retention.app_accepted_authority_days)
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-smoke.yml.tftpl", {
      accepted_marker_path       = local.app_accepted_marker_path
      entrypoint_sha256          = filesha256("${path.module}/app-pipeline-scripts/app-smoke.sh")
      state_bucket_arn           = aws_s3_bucket.state.arn
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      state_kms_key_arn          = aws_kms_key.state.arn
      terraform_install_commands = jsonencode(local.terraform_install_commands)
      terraform_smoke_role_arn   = aws_iam_role.app_terraform_smoke[0].arn
    })
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
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-app-static-deploy.yml.tftpl", {
      entrypoint_sha256 = filesha256("${path.module}/app-pipeline-scripts/app-static-deploy.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
