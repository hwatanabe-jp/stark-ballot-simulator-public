resource "aws_codebuild_project" "release_candidate_preflight" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.release_candidate_preflight_project_name
  service_role  = aws_iam_role.foundation_release_candidate_build[0].arn
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
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.release_candidate_preflight_project_name].name
      stream_name = "preflight"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          "runtime-versions" = {
            nodejs = 24
          }
        }
        build = {
          commands = [
            "mkdir -p release-candidate/evidence",
            "test -f infra/docker/Dockerfile.risc0-toolchain-arm64",
            "test -f infra/docker/Dockerfile.fargate-prover",
            "test -f buildspec-risc0-toolchain.yml",
            "test -f buildspec.yml",
            "node --version | grep -E '^v24\\.'",
            "printf '{\"schemaVersion\":\"develop-release-candidate-preflight-v1\",\"sourceSha\":\"%s\",\"stateIdentity\":\"stark-dev/develop/foundation\",\"dockerBuildStarted\":false,\"nextStage\":null}\\n' \"$CODEBUILD_RESOLVED_SOURCE_VERSION\" > release-candidate/evidence/preflight.json",
          ]
        }
      }
      artifacts = {
        files = [
          "release-candidate/evidence/preflight.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
