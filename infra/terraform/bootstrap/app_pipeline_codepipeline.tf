resource "aws_codepipeline" "development_app" {
  count = local.app_pipeline_enabled ? 1 : 0

  name           = local.app_pipeline_name
  pipeline_type  = "V2"
  execution_mode = "QUEUED"
  role_arn       = aws_iam_role.app_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.app_pipeline_execution_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.app_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  variable {
    name          = "InitialPublication"
    default_value = "false"
    description   = "Explicit first checkpoint and mutation-owner publication for reviewed target cutover."
  }

  stage {
    name = local.deployment_target.sourceAction

    action {
      name             = local.deployment_target.sourceAction
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "AppSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = local.deployment_target.sourceBranch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = local.deployment_target.repository
        OutputArtifactFormat = "CODEBUILD_CLONE_REF"
      }
    }
  }

  stage {
    name = "Prepare"


    action {
      name             = "PlanAppState"
      run_order        = 1
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "PlanAppState"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["PlanOutput"]

      configuration = {
        EnvironmentVariables = local.app_codebuild_plan_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_terraform_plan[0].name
      }
    }
  }

  stage {
    name = "ManualApproval"

    action {
      name     = "ApproveTargetRuntimeApply"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Review and approve this exact saved plan only through ${local.deployment_cli_command} review app --execution-id #{codepipeline.PipelineExecutionId} --source-sha #{AppSource.CommitId}. Every App saved plan requires approval, including an empty Terraform plan. The command creates the bounded approval evidence and transport for ${local.app_lane_authority.stateIdentity}; do not hand-author an approval summary."
      }
    }
  }

  stage {
    name = "DeployApplication"

    action {
      run_order        = 1
      name             = "ApplyReviewedAppPlan"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "PlanOutput"]
      output_artifacts = ["ApplyOutput"]

      configuration = {
        EnvironmentVariables = local.app_codebuild_apply_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_terraform_apply[0].name
      }
    }

    action {
      run_order        = 2
      name             = "DeployStaticFrontend"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ApplyOutput"]
      output_artifacts = ["StaticDeployOutput"]

      configuration = {
        EnvironmentVariables = local.app_codebuild_deployment_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_static_deploy[0].name
      }
    }

    action {
      run_order       = 3
      name            = "TargetRuntimeSmoke"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput", "PlanOutput", "ApplyOutput", "StaticDeployOutput"]

      configuration = {
        EnvironmentVariables = local.app_codebuild_deployment_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_smoke[0].name
      }
    }


  }

  lifecycle {
    precondition {
      condition = alltrue([
        length(local.app_codebuild_release_resolution_env_variables) <= 1000,
        length(local.app_codebuild_deployment_env_variables) <= 1000,
        length(local.app_codebuild_plan_env_variables) <= 1000,
        length(local.app_codebuild_apply_env_variables) <= 1000,
      ])
      error_message = "CodePipeline action configuration values must remain within the 1,000-character quota."
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
