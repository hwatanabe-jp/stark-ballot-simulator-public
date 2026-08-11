resource "aws_codebuild_project" "toolchain_release_candidate" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.toolchain_release_candidate_project_name
  service_role  = aws_iam_role.foundation_toolchain_release_candidate_build[0].arn
  build_timeout = 240

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_LARGE"
    image                       = "aws/codebuild/amazonlinux2-aarch64-standard:3.0"
    type                        = "ARM_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "IMAGE_REPO_NAME"
      value = local.foundation_risc0_toolchain_ecr_repository_name
    }

    environment_variable {
      name  = "TOOLCHAIN_RELEASE_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }

    environment_variable {
      name  = "SOURCE_REPOSITORY"
      value = local.deployment_target.repositoryUrl
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.toolchain_release_candidate_project_name].name
      stream_name = "candidate"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "buildspec-risc0-toolchain.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "toolchain_release_update_accepted_pointer" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.toolchain_release_update_accepted_pointer_project_name
  service_role  = aws_iam_role.foundation_toolchain_release_update_accepted_pointer_build[0].arn
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
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "IMAGE_SIGNATURE_VERIFICATION_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }

    environment_variable {
      name  = "TOOLCHAIN_RELEASE_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }

    environment_variable {
      name  = "IMAGE_REPO_NAME"
      value = local.foundation_risc0_toolchain_ecr_repository_name
    }

    environment_variable {
      name  = "RELEASE_IMAGE_KIND"
      value = "toolchain"
    }

    environment_variable {
      name  = "RELEASE_AUTHORITY_ACTION"
      value = "update-pointer"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.toolchain_release_update_accepted_pointer_project_name].name
      stream_name = "update-accepted-pointer"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "buildspec-release-authority.yml"
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
