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
      name  = "APP_BACKEND_CONFIG_BASE64"
      value = base64encode(local.app_backend_config_content)
    }

    environment_variable {
      name  = "APP_PIPELINE_TFVARS_BASE64"
      value = base64encode(local.app_pipeline_tfvars_content)
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
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_preflight_plan_project_name].name
      stream_name = "signature-preflight-plan"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-signature-preflight-plan.yml"
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
      group_name  = module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_preflight_apply_project_name].name
      stream_name = "signature-preflight-apply"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-signature-preflight-apply.yml"
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
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-signature-preflight-invoke.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
