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
    description   = "Stable label for the Plan 02 foundation saved-plan evidence package."
  }

  stage {
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "FoundationSource"
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
        EnvironmentVariables = jsonencode([{ name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" }])
        ProjectName          = aws_codebuild_project.foundation_validate[0].name
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
        EnvironmentVariables = jsonencode([{ name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" }])
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.foundation_terraform_plan[0].name
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
        CustomData = "Approve only after reviewing PlanOutput/infra/terraform/foundation/tfplan.txt and tfplan.sha256 for stark-dev/develop/foundation. Approval must confirm no app state or app runtime resources are created."
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
        EnvironmentVariables = jsonencode([{ name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" }])
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.foundation_terraform_apply[0].name
      }
    }
  }

  stage {
    name = "PostApplySmoke"

    action {
      name            = "FoundationStateAbsenceOfAppRuntime"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput", "ApplyOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([{ name = "FOUNDATION_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" }])
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.foundation_smoke[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
