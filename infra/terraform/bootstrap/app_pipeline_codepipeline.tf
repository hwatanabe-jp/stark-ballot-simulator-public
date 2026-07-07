resource "aws_codepipeline" "development_app" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_pipeline_name
  pipeline_type = "V2"
  role_arn      = aws_iam_role.app_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.app_pipeline_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.app_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  variable {
    name          = "ReleaseManifestKey"
    default_value = "__MISSING_RELEASE_MANIFEST_KEY__"
    description   = "S3 object key for the immutable release-candidate manifest consumed by the target app lane."
  }

  variable {
    name          = "ReleaseManifestVersionId"
    default_value = "__MISSING_RELEASE_MANIFEST_VERSION_ID__"
    description   = "VersionId for the immutable release-candidate manifest object."
  }

  variable {
    name          = "ReleaseManifestSha256"
    default_value = "__MISSING_RELEASE_MANIFEST_SHA256__"
    description   = "SHA-256 checksum for the exact immutable release-candidate manifest object body."
  }

  stage {
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "AppSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = var.source_branch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = var.github_full_repository_id
        OutputArtifactFormat = "CODEBUILD_CLONE_REF"
      }
    }
  }

  stage {
    name = "GenerateAppDeploymentRecord"

    action {
      name             = "GenerateAppDeploymentRecord"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "AppDeploymentRecord"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["AppDeploymentRecordOutput"]

      configuration = {
        EnvironmentVariables = local.app_codebuild_source_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_deployment_record[0].name
      }
    }
  }

  stage {
    name = "Validate"

    action {
      name             = "ValidateAppLane"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "AppDeploymentRecordOutput"]
      output_artifacts = ["ValidateOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_RELEASE_MANIFEST_KEY"
            value = "#{AppDeploymentRecord.ReleaseManifestKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_VERSION_ID"
            value = "#{AppDeploymentRecord.ReleaseManifestVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_SHA256"
            value = "#{AppDeploymentRecord.ReleaseManifestSha256}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_validate[0].name
      }
    }
  }

  stage {
    name = "TerraformPlan"

    action {
      name             = "PlanAppState"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "PlanAppState"
      input_artifacts  = ["SourceOutput", "ValidateOutput"]
      output_artifacts = ["PlanOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_RELEASE_MANIFEST_KEY"
            value = "#{AppDeploymentRecord.ReleaseManifestKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_VERSION_ID"
            value = "#{AppDeploymentRecord.ReleaseManifestVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_SHA256"
            value = "#{AppDeploymentRecord.ReleaseManifestSha256}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_terraform_plan[0].name
      }
    }
  }

  stage {
    name = "ManualApproval"

    before_entry {
      # CodePipeline before_entry conditions apply their result when a rule fails.
      # SKIP therefore uses NE true so unset/garbage/non-empty plans run approval.
      condition {
        result = "SKIP"

        rule {
          name = "SkipEmptyDevelopPlan"

          rule_type_id = {
            category = "Rule"
            owner    = "AWS"
            provider = "VariableCheck"
            version  = "1"
          }

          configuration = {
            Variable = "#{PlanAppState.PLAN_EMPTY}"
            Value    = "true"
            Operator = "NE"
          }
        }
      }
    }

    action {
      name     = "ApproveTargetRuntimeApply"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing PlanOutput/infra/terraform/app/tfplan.txt, infra/terraform/app/tfplan.sha256, and infra/terraform/app/evidence/target-lambda-artifacts.json for stark-dev/develop/app. Approval summary must be JSON: {\"sourceSha\":\"<requested/resolved sha>\",\"accountId\":\"${var.aws_account_id}\",\"deploymentEnvironment\":\"develop\",\"reviewedPlanChecksum\":\"<tfplan sha256>\"}."
      }
    }
  }

  stage {
    name = "TerraformApply"

    action {
      name             = "ApplyReviewedAppPlan"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "PlanOutput"]
      output_artifacts = ["ApplyOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_RELEASE_MANIFEST_KEY"
            value = "#{AppDeploymentRecord.ReleaseManifestKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_VERSION_ID"
            value = "#{AppDeploymentRecord.ReleaseManifestVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_SHA256"
            value = "#{AppDeploymentRecord.ReleaseManifestSha256}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_terraform_apply[0].name
      }
    }
  }

  stage {
    name = "StaticFrontendDeploy"

    action {
      name             = "DeployStaticFrontend"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ApplyOutput"]
      output_artifacts = ["StaticDeployOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_RELEASE_MANIFEST_KEY"
            value = "#{AppDeploymentRecord.ReleaseManifestKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_VERSION_ID"
            value = "#{AppDeploymentRecord.ReleaseManifestVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_SHA256"
            value = "#{AppDeploymentRecord.ReleaseManifestSha256}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_static_deploy[0].name
      }
    }
  }

  stage {
    name = "PostApplySmoke"

    action {
      name            = "TargetRuntimeSmoke"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput", "PlanOutput", "ApplyOutput", "StaticDeployOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "APP_RELEASE_MANIFEST_KEY"
            value = "#{AppDeploymentRecord.ReleaseManifestKey}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_VERSION_ID"
            value = "#{AppDeploymentRecord.ReleaseManifestVersionId}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_RELEASE_MANIFEST_SHA256"
            value = "#{AppDeploymentRecord.ReleaseManifestSha256}"
            type  = "PLAINTEXT"
          },
          {
            name  = "APP_PIPELINE_EXECUTION_ID"
            value = "#{codepipeline.PipelineExecutionId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.app_smoke[0].name
      }
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
