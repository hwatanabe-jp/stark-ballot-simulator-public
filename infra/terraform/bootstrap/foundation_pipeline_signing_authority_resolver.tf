resource "aws_codebuild_project" "foundation_image_signing_authority_resolver" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_policy.bootstrap_deploy_permissions_boundary]

  name          = local.foundation_image_signing_authority_resolver_project_name
  service_role  = aws_iam_role.foundation_image_signing_authority_resolver_build[0].arn
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
      name  = "FOUNDATION_SIGNING_AUTHORITY_BUCKET"
      value = local.foundation_release_manifest_bucket_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.foundation_pipeline_codebuild_log_groups.log_groups[local.foundation_image_signing_authority_resolver_project_name].name
      stream_name = "foundation-signing-authority"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-foundation-signing-authority-resolver.yml.tftpl", {
      entrypoint_sha256 = filesha256("${path.module}/foundation-pipeline-scripts/resolve-foundation-signing-authority.sh")
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
