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
    name          = "RequestedSourceSha"
    default_value = "__MISSING_REQUESTED_SOURCE_SHA__"
    description   = "Operator-requested toolchain source Git SHA that candidate and promotion evidence must match when set; leave the default to build the resolved branch head (recorded as sourceShaMode branch-head)."
  }

  variable {
    name          = "ToolchainScanWaiverId"
    default_value = "__NO_TOOLCHAIN_SCAN_WAIVER__"
    description   = "Reviewed scan waiver evidence id required when the warn-only toolchain scan reports HIGH/CRITICAL findings."
  }

  stage {
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "ToolchainReleaseSource"
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
    name = "BuildApproval"

    action {
      name     = "ApproveToolchainBuild"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve to start the ~2h ARM64 RISC Zero toolchain candidate build for this execution's source revision. Verify the execution's Source revision first: a pending execution does not follow later pushes, so approving an old execution builds its own resolved source. This starts a build only; promotion to the accepted toolchain channel still requires ApproveToolchainPromotion after candidate evidence exists."
      }
    }
  }

  stage {
    name = "BuildToolchainCandidate"

    action {
      name             = "BuildToolchainCandidate"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ToolchainCandidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "TOOLCHAIN_IMAGE_METADATA_PREFIX"
            value = "candidates/toolchain/#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_IMAGE_TAG"
            value = "candidate-#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.toolchain_release_candidate[0].name
      }
    }
  }

  stage {
    name = "ManualApproval"

    action {
      name     = "ApproveToolchainPromotion"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing ToolchainCandidateOutput/image-info.json, confirming the digest-pinned toolchain image, the warn-only scan result (a waiver evidence id is required when findings are present), and ECR signing status COMPLETE. This approval promotes the toolchain candidate only; it is not prover or app approval."
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
      input_artifacts  = ["ToolchainCandidateOutput"]
      output_artifacts = ["ToolchainPromotionEvidenceOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "TOOLCHAIN_RELEASE_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_RELEASE_EVIDENCE_KEY"
            value = "promotions/develop/toolchain/#{codepipeline.PipelineExecutionId}/toolchain-promotion-evidence.json"
            type  = "PLAINTEXT"
          },
          {
            name  = "REQUESTED_SOURCE_SHA"
            value = "#{variables.RequestedSourceSha}"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_SCAN_WAIVER_ID"
            value = "#{variables.ToolchainScanWaiverId}"
            type  = "PLAINTEXT"
          },
        ])
        ProjectName = aws_codebuild_project.toolchain_release_promotion_evidence[0].name
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
      input_artifacts  = ["SourceOutput", "ToolchainPromotionEvidenceOutput"]
      output_artifacts = ["ToolchainAcceptedPointerOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "TOOLCHAIN_ACCEPTED_POINTER_KEY"
            value = "channels/develop/toolchain/accepted.json"
            type  = "PLAINTEXT"
          },
          {
            name  = "TOOLCHAIN_RELEASE_EVIDENCE_KEY"
            value = "promotions/develop/toolchain/#{codepipeline.PipelineExecutionId}/toolchain-promotion-evidence.json"
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
