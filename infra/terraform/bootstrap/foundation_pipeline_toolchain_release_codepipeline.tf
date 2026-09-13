resource "aws_codepipeline" "development_toolchain_release" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.toolchain_release_pipeline_name
  pipeline_type = "V2"
  role_arn      = aws_iam_role.foundation_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.foundation_pipeline_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.foundation_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  variable {
    name        = "RequestedSourceSha"
    description = "Required full lowercase control source Git SHA; the Source override and every release stage must match it exactly."
  }

  variable {
    name          = "ToolchainSelection"
    default_value = "build"
    description   = "Select build for a new Toolchain image or existing for one retained immutable Toolchain artifact."
  }

  variable {
    name          = "ExistingToolchainRecordKey"
    default_value = "__NOT_APPLICABLE__"
    description   = "Retained immutable Toolchain candidate ledger record key when ToolchainSelection is existing."
  }

  stage {
    name = local.deployment_target.sourceAction

    action {
      name             = local.deployment_target.sourceAction
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "ToolchainReleaseSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = local.deployment_target.sourceBranch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = local.deployment_target.repository
        OutputArtifactFormat = "CODE_ZIP"
      }
    }
  }

  stage {
    name = "CandidateApproval"

    # Both modes require this gate because the shared candidate project keeps
    # build-mode ECR mutation permissions even though existing is read/validate-only.
    action {
      name     = "ApproveToolchainCandidateExecution"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve the candidate action for the selected mode after verifying its control source and parameters. build creates a new image from this execution's exact source revision; existing performs retained-artifact resolution through one exact candidate ledger record key with no Docker build, image push, ECR mutation, or new scan. Promotion reissues the validated image authority as a current semantic record while preserving its original build provenance. This approval is required in both modes because the shared candidate project is privileged. Promotion to the accepted toolchain channel still requires ApproveToolchainPromotion after candidate evidence exists."
      }
    }
  }

  stage {
    name = "PrepareToolchainCandidate"

    action {
      name             = "PrepareToolchainCandidate"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ToolchainCandidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PIPELINE_SOURCE_SHA"
            value = "#{ToolchainReleaseSource.CommitId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_IMAGE_TAG"
            value = "candidate-#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_SELECTION"
            value = "#{variables.ToolchainSelection}"
            type  = "PLAINTEXT"
          },
          {
            name  = "EXISTING_TOOLCHAIN_RECORD_KEY"
            value = "#{variables.ExistingToolchainRecordKey}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.toolchain_release_candidate[0].name
      }
    }
  }

  stage {
    name = "PromotionApproval"

    action {
      name     = "ApproveToolchainPromotion"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing ToolchainCandidateOutput/image-info.json. Confirm selection mode and control source; for build, confirm candidate source; for existing, confirm original source plus the exact candidate ledger record key. In both modes confirm the digest-pinned image and warn-only scan result. Toolchain findings are accepted and non-blocking for this PoC; no waiver, remediation, signature, or signature-verification review is required. This promotes only the selected Toolchain authority, not Prover or App."
      }
    }
  }

  stage {
    name = "UpdateAcceptedPointer"

    action {
      name             = "UpdateAcceptedPointer"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ToolchainCandidateOutput"]
      output_artifacts = ["ToolchainAcceptedPointerOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "TOOLCHAIN_ACCEPTED_POINTER_KEY"
            value = local.deployment_shared_names.toolchainAcceptedPointerKey
            type  = "PLAINTEXT"
          },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PIPELINE_SOURCE_SHA"
            value = "#{ToolchainReleaseSource.CommitId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_SELECTION"
            value = "#{variables.ToolchainSelection}"
            type  = "PLAINTEXT"
          },
          {
            name  = "EXISTING_TOOLCHAIN_RECORD_KEY"
            value = "#{variables.ExistingToolchainRecordKey}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.toolchain_release_update_accepted_pointer[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
