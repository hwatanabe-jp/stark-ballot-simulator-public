resource "aws_codepipeline" "development_foundation" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_pipeline_name
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
    name          = "FoundationEvidenceIntent"
    default_value = "foundation-saved-plan-evidence"
    description   = "Stable label for the foundation saved-plan evidence package."
  }

  stage {
    name = local.deployment_target.sourceAction

    action {
      name             = local.deployment_target.sourceAction
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "FoundationSource"
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
    name = "Validate"

    action {
      name             = "ValidateFoundationLane"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ValidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" },
          { name = "PIPELINE_SOURCE_SHA", value = "#{FoundationSource.CommitId}", type = "PLAINTEXT" },
        ])
        ProjectName = aws_codebuild_project.foundation_validate[0].name
      }
    }
  }

  stage {
    name = "TerraformPlan"

    action {
      name             = "PlanFoundationState"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ValidateOutput"]
      output_artifacts = ["PlanOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" },
          { name = "PIPELINE_SOURCE_SHA", value = "#{FoundationSource.CommitId}", type = "PLAINTEXT" },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.foundation_terraform_plan[0].name
      }
    }
  }

  stage {
    name = "ManualApproval"

    action {
      name     = "ApproveFoundationApply"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing PlanOutput/infra/terraform/foundation/tfplan.txt and tfplan.sha256 for ${local.foundation_lane_authority.stateIdentity}. Approval must confirm the foundation plan manages no app runtime resources; separately deployed app state/runtime may exist. Approval summary must be exact JSON: {\"sourceSha\":\"#{FoundationSource.CommitId}\",\"accountId\":\"${local.deployment_target.accountId}\",\"deploymentEnvironment\":\"${local.deployment_target.environmentId}\",\"reviewedPlanChecksum\":\"<tfplan sha256>\"}."
      }
    }
  }

  stage {
    name = "TerraformApply"

    action {
      name             = "ApplyReviewedFoundationPlan"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "PlanOutput"]
      output_artifacts = ["ApplyOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" },
          { name = "PIPELINE_SOURCE_SHA", value = "#{FoundationSource.CommitId}", type = "PLAINTEXT" },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.foundation_terraform_apply[0].name
      }
    }
  }

  stage {
    name = "PostApplySmoke"

    action {
      name             = "FoundationStateAbsenceOfAppRuntime"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "PlanOutput", "ApplyOutput"]
      output_artifacts = ["FoundationSmokeOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" },
          { name = "TERRAFORM_BASELINE_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" },
          { name = "PIPELINE_SOURCE_SHA", value = "#{FoundationSource.CommitId}", type = "PLAINTEXT" },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.foundation_smoke[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
