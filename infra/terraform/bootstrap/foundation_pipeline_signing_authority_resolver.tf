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
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.foundation_image_signing_authority_resolver_project_name].name
      stream_name = "foundation-signing-authority"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        build = {
          commands = [
            "set -eu",
            "test \"$REQUESTED_SOURCE_SHA\" = \"$PIPELINE_SOURCE_SHA\"",
            "test \"$REQUESTED_SOURCE_SHA\" = \"$CODEBUILD_RESOLVED_SOURCE_VERSION\"",
            "printf '%s' \"$REQUESTED_SOURCE_SHA\" | grep -Eq '^[0-9a-f]{40}$'",
            "mkdir -p foundation-signing-authority",
            "node infra/terraform/bootstrap/foundation-pipeline-scripts/validate-foundation-image-signing-authority.mjs --bucket \"$FOUNDATION_SIGNING_AUTHORITY_BUCKET\" --key \"$FOUNDATION_SIGNING_AUTHORITY_KEY\" --version-id \"$FOUNDATION_SIGNING_AUTHORITY_VERSION_ID\" --sha256 \"$FOUNDATION_SIGNING_AUTHORITY_SHA256\" --expected-account-id \"$AWS_ACCOUNT_ID\" --region \"$AWS_DEFAULT_REGION\" --source-sha \"$REQUESTED_SOURCE_SHA\" --output foundation-signing-authority/foundation-signing-authority.json",
          ]
        }
      }
      artifacts = {
        files = [
          "foundation-signing-authority/foundation-signing-authority.json",
        ]
        "discard-paths" = true
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
