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
    name          = "RequestedSourceSha"
    default_value = "__MISSING_REQUESTED_SOURCE_SHA__"
    description   = "Operator-requested prover source Git SHA that candidate and promotion evidence must match when set; leave the default to build the resolved branch head (recorded as sourceShaMode branch-head)."
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
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "ProverReleaseSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = var.source_branch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = var.github_full_repository_id
        OutputArtifactFormat = "CODE_ZIP"
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
      input_artifacts  = ["SourceOutput"]
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
        ])
        ProjectName = aws_codebuild_project.prover_release_toolchain_resolver[0].name
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
      input_artifacts  = ["SourceOutput", "ToolchainAuthorityOutput"]
      output_artifacts = ["CandidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "PROVER_IMAGE_METADATA_PREFIX"
            value = "artifacts/prover/candidates/#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "IMAGE_TAG"
            value = "candidate-#{codepipeline.PipelineExecutionId}"
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
        CustomData = "Approve only after reviewing CandidateOutput/image-metadata.json, confirming the selected digest-pinned toolchain image, prover scan result, ImageID/methodVersion, and ECR signing status COMPLETE. This approval promotes the prover candidate only; it is not app Terraform approval."
      }
    }
  }

  stage {
    name = "PublishPromotionEvidence"

    action {
      name             = "PublishPromotionEvidence"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["CandidateOutput"]
      output_artifacts = ["PromotionEvidenceOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "PROVER_RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "PROVER_RELEASE_EVIDENCE_KEY"
            value = "promotions/develop/prover/#{codepipeline.PipelineExecutionId}/prover-promotion-evidence.json"
            type  = "PLAINTEXT"
          },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
        ])
        ProjectName = aws_codebuild_project.prover_release_promotion_evidence[0].name
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
      input_artifacts  = ["SourceOutput", "PromotionEvidenceOutput"]
      output_artifacts = ["AcceptedPointerOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "PROVER_ACCEPTED_POINTER_KEY"
            value = "channels/develop/prover/accepted.json"
            type  = "PLAINTEXT"
          },
          {
            name  = "PROVER_RELEASE_EVIDENCE_KEY"
            value = "promotions/develop/prover/#{codepipeline.PipelineExecutionId}/prover-promotion-evidence.json"
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
