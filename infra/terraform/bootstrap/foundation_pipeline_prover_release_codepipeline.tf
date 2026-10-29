resource "aws_codepipeline" "development_prover_release" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name           = local.prover_release_pipeline_name
  pipeline_type  = "V2"
  execution_mode = "QUEUED"
  role_arn       = aws_iam_role.foundation_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.foundation_pipeline_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.foundation_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  variable {
    name          = "PromotionMode"
    default_value = "current"
    description   = "Explicit initial mode requires absent promotion; current mode requires an existing version."
  }

  variable {
    name          = "ToolchainSelection"
    default_value = "accepted"
    description   = "Toolchain authority selector for the prover candidate: accepted or pinned."
  }

  variable {
    name          = "ProverSelection"
    default_value = "build"
    description   = "Prover candidate selector: build creates a new candidate; existing selects one exact retained candidate ledger record."
  }

  variable {
    name          = "ExistingProverCandidateRecordKey"
    default_value = "__NOT_APPLICABLE__"
    description   = "Exact content-addressed Prover candidate ledger key when ProverSelection is existing."
  }

  variable {
    name        = "RequestedSourceSha"
    description = "Required full lowercase prover source Git SHA; the Source override and every release stage must match it exactly."
  }

  variable {
    name          = "PinnedToolchainVersionId"
    default_value = "__NO_PINNED_TOOLCHAIN_VERSION_ID__"
    description   = "Exact Toolchain promotion VersionId when ToolchainSelection is pinned."
  }

  stage {
    name = local.deployment_target.sourceAction

    action {
      name             = local.deployment_target.sourceAction
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "ProverReleaseSource"
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
    name = "PrepareImage"

    action {
      name             = "PrepareImage"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ToolchainAuthorityOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "RELEASE_PIPELINE_EXECUTION_ID"
            type  = "PLAINTEXT"
            value = "#{codepipeline.PipelineExecutionId}"
          },
          { name = "IMAGE_PROMOTION_MODE", value = "#{variables.PromotionMode}", type = "PLAINTEXT" },
          {
            name  = "TOOLCHAIN_SELECTION"
            value = "#{variables.ToolchainSelection}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PINNED_TOOLCHAIN_VERSION_ID"
            value = "#{variables.PinnedToolchainVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PIPELINE_SOURCE_SHA"
            value = "#{ProverReleaseSource.CommitId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.prover_release_toolchain_resolver[0].name
      }
    }
  }

  stage {
    name = "BuildApproval"

    action {
      name     = "ApproveProverBuild"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve the Prover candidate action for the selected mode after reviewing the exact Source, ToolchainAuthorityOutput Foundation checkpoint and Toolchain promotion. build creates and validates a new Prover image; existing selects one exact Prover candidate ledger record and never rebuilds, pushes, scans, or signs an image. Prover promotion remains separately gated."
      }
    }
  }

  stage {
    name = "BuildProverCandidate"

    action {
      name             = "BuildProverCandidate"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ToolchainAuthorityOutput"]
      output_artifacts = ["CandidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "IMAGE_PROMOTION_MODE", value = "#{variables.PromotionMode}", type = "PLAINTEXT" },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PIPELINE_SOURCE_SHA"
            value = "#{ProverReleaseSource.CommitId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "IMAGE_TAG"
            value = "candidate-#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PROVER_SELECTION"
            value = "#{variables.ProverSelection}"
            type  = "PLAINTEXT"
          },
          {
            name  = "EXISTING_PROVER_CANDIDATE_RECORD_KEY"
            value = "#{variables.ExistingProverCandidateRecordKey}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.prover_release_candidate[0].name
      }
    }
  }

  stage {
    name = "ManualApproval"

    action {
      name     = "ApproveProverPromotion"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing CandidateOutput/image-metadata.json and confirming the exact source, selected digest-pinned toolchain image, prover scan result, ECR managed-signing readiness, ImageID/methodVersion, the canonical failureMarkerContractSha256, and failureMarkerSmokeStatus=PASS. Cryptographic verification occurs in the App preflight/runtime verifier Lambda, not this release lane. This approval promotes the prover candidate only; it is not app Terraform approval."
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
      input_artifacts  = ["SourceOutput", "CandidateOutput", "ToolchainAuthorityOutput"]
      output_artifacts = ["AcceptedPointerOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "IMAGE_PROMOTION_MODE", value = "#{variables.PromotionMode}", type = "PLAINTEXT" },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PIPELINE_SOURCE_SHA"
            value = "#{ProverReleaseSource.CommitId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PROVER_SELECTION"
            value = "#{variables.ProverSelection}"
            type  = "PLAINTEXT"
          },
          {
            name  = "EXISTING_PROVER_CANDIDATE_RECORD_KEY"
            value = "#{variables.ExistingProverCandidateRecordKey}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.prover_release_update_accepted_pointer[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
