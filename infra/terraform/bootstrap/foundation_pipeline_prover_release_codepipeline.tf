resource "aws_codepipeline" "development_prover_release" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.prover_release_pipeline_name
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
    name          = "ToolchainSelection"
    default_value = "accepted"
    description   = "Toolchain authority selector for the prover candidate: accepted or pinned."
  }

  variable {
    name        = "RequestedSourceSha"
    description = "Required full lowercase prover source Git SHA; the Source override and every release stage must match it exactly."
  }

  variable {
    name        = "FoundationSigningAuthorityKey"
    description = "Required immutable Foundation image-signing authority S3 key emitted by the reviewed Foundation PostApplySmoke execution."
  }

  variable {
    name        = "FoundationSigningAuthorityVersionId"
    description = "Required exact S3 VersionId for the reviewed Foundation image-signing authority."
  }

  variable {
    name        = "FoundationSigningAuthoritySha256"
    description = "Required SHA-256 of the exact reviewed Foundation image-signing authority body."
  }

  variable {
    name          = "PinnedToolchainArtifactKey"
    default_value = "__NO_PINNED_TOOLCHAIN_ARTIFACT_KEY__"
    description   = "Pinned immutable toolchain artifact record key when ToolchainSelection is pinned."
  }

  variable {
    name          = "PinnedToolchainArtifactVersionId"
    default_value = "__NO_PINNED_TOOLCHAIN_ARTIFACT_VERSION_ID__"
    description   = "Pinned immutable toolchain artifact record S3 VersionId when ToolchainSelection is pinned."
  }

  variable {
    name          = "PinnedToolchainArtifactSha256"
    default_value = "__NO_PINNED_TOOLCHAIN_ARTIFACT_SHA256__"
    description   = "Pinned immutable toolchain artifact record checksum when ToolchainSelection is pinned."
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
    name = "ResolveFoundationSigningAuthority"

    action {
      name             = "ResolveFoundationSigningAuthority"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["FoundationSigningAuthorityOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
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
            name  = "FOUNDATION_SIGNING_AUTHORITY_KEY"
            value = "#{variables.FoundationSigningAuthorityKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "FOUNDATION_SIGNING_AUTHORITY_VERSION_ID"
            value = "#{variables.FoundationSigningAuthorityVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "FOUNDATION_SIGNING_AUTHORITY_SHA256"
            value = "#{variables.FoundationSigningAuthoritySha256}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.foundation_image_signing_authority_resolver[0].name
      }
    }
  }

  stage {
    name = "ResolveToolchainAuthority"

    action {
      name             = "ResolveToolchainAuthority"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "FoundationSigningAuthorityOutput"]
      output_artifacts = ["ToolchainAuthorityOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "TOOLCHAIN_SELECTION"
            value = "#{variables.ToolchainSelection}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PINNED_TOOLCHAIN_ARTIFACT_KEY"
            value = "#{variables.PinnedToolchainArtifactKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PINNED_TOOLCHAIN_ARTIFACT_VERSION_ID"
            value = "#{variables.PinnedToolchainArtifactVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PINNED_TOOLCHAIN_ARTIFACT_SHA256"
            value = "#{variables.PinnedToolchainArtifactSha256}"
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
        CustomData = "Approve to start the prover candidate build on the resolved digest-pinned toolchain (review ToolchainAuthorityOutput/toolchain-authority.json). Verify the execution's Source revision first: a pending execution does not follow later pushes, so approving an old execution builds its own resolved source. This starts a build only; prover promotion still requires ApproveProverPromotion after candidate evidence exists."
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
      input_artifacts  = ["SourceOutput", "FoundationSigningAuthorityOutput", "ToolchainAuthorityOutput"]
      output_artifacts = ["CandidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
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
      input_artifacts  = ["SourceOutput", "FoundationSigningAuthorityOutput", "CandidateOutput"]
      output_artifacts = ["AcceptedPointerOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "PROVER_ACCEPTED_POINTER_KEY"
            value = local.deployment_shared_names.proverAcceptedPointerKey
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
          {
            name  = "RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
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
