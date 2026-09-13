resource "aws_codepipeline" "development_app" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_pipeline_name
  pipeline_type = "V2"
  role_arn      = aws_iam_role.app_pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.app_pipeline_execution_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.app_pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  variable {
    name          = "DeploymentMode"
    default_value = "normal"
    description   = "Explicit app deployment mode: normal or rollback."
  }

  dynamic "variable" {
    for_each = local.deployment_target.environmentId == "main" ? { AppInputMode = "accepted" } : {}
    content {
      name          = variable.key
      default_value = variable.value
      description   = "Explicit production input mode: accepted, verifier-prerequisite, or initial."
    }
  }

  variable {
    name          = "DynamoDbRecoveryPhase"
    default_value = "primary_active"
    description   = "Explicit DynamoDB recovery phase: primary_active, primary_quiesced, replacement_quiesced, or replacement_active."
  }

  variable {
    name          = "SelectedAcceptanceKey"
    default_value = "__NOT_APPLICABLE__"
    description   = "Content-addressed App acceptance key selected only for rollback."
  }

  variable {
    name          = "DynamoDbRecoveryManifestKey"
    default_value = "__DISABLED__"
    description   = "Validated DynamoDB recovery activation manifest key, or __DISABLED__."
  }

  variable {
    name          = "DynamoDbRecoveryManifestVersionId"
    default_value = "__DISABLED__"
    description   = "Exact DynamoDB recovery activation manifest VersionId, or __DISABLED__."
  }

  variable {
    name          = "DynamoDbRecoveryManifestSha256"
    default_value = "__DISABLED__"
    description   = "Exact DynamoDB recovery activation manifest body SHA-256, or __DISABLED__."
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
    name = "ResolveRelease"

    action {
      name             = "ResolveRelease"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "ReleaseResolution"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["ReleaseResolutionOutput"]

      configuration = {
        EnvironmentVariables = local.app_codebuild_release_resolution_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_execution_authority[0].name
      }
    }
  }

  stage {
    name = "VerifierPreflightPlan"

    action {
      name             = "PlanVerifierPreflight"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "VerifierPreflightPlan"
      input_artifacts  = ["SourceOutput", "ReleaseResolutionOutput"]
      output_artifacts = ["VerifierPreflightPlanOutput"]

      configuration = {
        EnvironmentVariables = local.app_signature_preflight_plan_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_preflight_plan[0].name
      }
    }
  }

  stage {
    name = "VerifierPreflightApproval"

    before_entry {
      # CodePipeline applies SKIP when the rule fails. A rollback reuses the
      # retained cryptographic authority and must not mutate the current verifier.
      condition {
        result = "SKIP"

        rule {
          name = "SkipVerifierPreflightApprovalForRollback"

          rule_type_id {
            category = "Rule"
            owner    = "AWS"
            provider = "VariableCheck"
            version  = "1"
          }

          configuration = {
            Variable = "#{variables.DeploymentMode}"
            Value    = "rollback"
            Operator = "NE"
          }
        }
      }
    }

    action {
      name     = "ApproveVerifierPreflightApply"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "foundation=#{ReleaseResolution.FoundationAcceptanceKey}; contract=#{ReleaseResolution.FoundationContractHash}; toolchain=#{ReleaseResolution.ToolchainReleaseKey}@#{ReleaseResolution.ToolchainImageDigest}; prover=#{ReleaseResolution.ProverReleaseKey}@#{ReleaseResolution.ProverImageDigest}; preflight=#{VerifierPreflightPlan.VerifierPreflightChange}. Approve with: ${local.deployment_cli_command} review app-preflight --execution-id #{codepipeline.PipelineExecutionId} --source-sha #{ReleaseResolution.AppSourceSha}"
      }
    }
  }

  stage {
    name = "VerifierPreflightApply"

    action {
      name             = "ApplyReviewedVerifierPreflightPlan"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "VerifierPreflightApply"
      input_artifacts  = ["SourceOutput", "ReleaseResolutionOutput", "VerifierPreflightPlanOutput"]
      output_artifacts = ["VerifierPreflightApplyOutput"]

      configuration = {
        EnvironmentVariables = local.app_signature_preflight_apply_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_preflight_apply[0].name
      }
    }
  }

  stage {
    name = "VerifyProverSignature"

    dynamic "before_entry" {
      for_each = local.deployment_target.environmentId == "main" ? [true] : []
      content {
        condition {
          result = "SKIP"
          rule {
            name = "SkipAfterVerifierPrerequisite"
            rule_type_id {
              category = "Rule"
              owner    = "AWS"
              provider = "VariableCheck"
              version  = "1"
            }
            configuration = {
              Variable = "#{ReleaseResolution.AppInputMode}"
              Value    = "verifier-prerequisite"
              Operator = "NE"
            }
          }
        }
      }
    }

    action {
      name             = "VerifyCryptographicImageSignature"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "ReleaseResolutionOutput", "VerifierPreflightApplyOutput"]
      output_artifacts = ["VerifierSignatureOutput"]

      configuration = {
        EnvironmentVariables = local.app_signature_preflight_invoke_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_preflight_invoke[0].name
      }
    }
  }

  stage {
    name = "TerraformPlan"

    dynamic "before_entry" {
      for_each = local.deployment_target.environmentId == "main" ? [true] : []
      content {
        condition {
          result = "SKIP"
          rule {
            name = "SkipAfterVerifierPrerequisite"
            rule_type_id {
              category = "Rule"
              owner    = "AWS"
              provider = "VariableCheck"
              version  = "1"
            }
            configuration = {
              Variable = "#{ReleaseResolution.AppInputMode}"
              Value    = "verifier-prerequisite"
              Operator = "NE"
            }
          }
        }
      }
    }

    action {
      name             = "PlanAppState"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "PlanAppState"
      input_artifacts  = ["SourceOutput", "ReleaseResolutionOutput", "VerifierSignatureOutput"]
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

    before_entry {
      # CodePipeline before_entry conditions apply their result when a rule fails.
      # SKIP therefore uses NE true so unset/garbage/non-empty plans run approval.
      condition {
        result = "SKIP"

        rule {
          name = local.deployment_target.environmentId == "main" ? "SkipAfterVerifierPrerequisite" : "SkipEmptyDevelopPlan"

          rule_type_id {
            category = "Rule"
            owner    = "AWS"
            provider = "VariableCheck"
            version  = "1"
          }

          configuration = {
            Variable = local.deployment_target.environmentId == "main" ? "#{ReleaseResolution.AppInputMode}" : "#{PlanAppState.APPROVAL_REQUIRED}"
            Value    = local.deployment_target.environmentId == "main" ? "verifier-prerequisite" : "false"
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
        CustomData = "Review and approve this exact saved plan only through ${local.deployment_cli_command} review app --execution-id #{codepipeline.PipelineExecutionId} --source-sha #{AppSource.CommitId}. Rollback always requires approval even when Terraform is empty. The command creates the bounded approval evidence and transport for ${local.app_lane_authority.stateIdentity}; do not hand-author an approval summary."
      }
    }
  }

  stage {
    name = "TerraformApply"

    dynamic "before_entry" {
      for_each = local.deployment_target.environmentId == "main" ? [true] : []
      content {
        condition {
          result = "SKIP"
          rule {
            name = "SkipAfterVerifierPrerequisite"
            rule_type_id {
              category = "Rule"
              owner    = "AWS"
              provider = "VariableCheck"
              version  = "1"
            }
            configuration = {
              Variable = "#{ReleaseResolution.AppInputMode}"
              Value    = "verifier-prerequisite"
              Operator = "NE"
            }
          }
        }
      }
    }

    action {
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
  }

  stage {
    name = "StaticFrontendDeploy"

    dynamic "before_entry" {
      for_each = local.deployment_target.environmentId == "main" ? [true] : []
      content {
        condition {
          result = "SKIP"
          rule {
            name = "SkipAfterVerifierPrerequisite"
            rule_type_id {
              category = "Rule"
              owner    = "AWS"
              provider = "VariableCheck"
              version  = "1"
            }
            configuration = {
              Variable = "#{ReleaseResolution.AppInputMode}"
              Value    = "verifier-prerequisite"
              Operator = "NE"
            }
          }
        }
      }
    }

    action {
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
  }

  stage {
    name = "PostApplySmoke"

    dynamic "before_entry" {
      for_each = local.deployment_target.environmentId == "main" ? [true] : []
      content {
        condition {
          result = "SKIP"
          rule {
            name = "SkipAfterVerifierPrerequisite"
            rule_type_id {
              category = "Rule"
              owner    = "AWS"
              provider = "VariableCheck"
              version  = "1"
            }
            configuration = {
              Variable = "#{ReleaseResolution.AppInputMode}"
              Value    = "verifier-prerequisite"
              Operator = "NE"
            }
          }
        }
      }
    }

    action {
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

  stage {
    name = "PublishCurrentStatus"

    dynamic "before_entry" {
      for_each = local.deployment_target.environmentId == "main" ? [true] : []
      content {
        condition {
          result = "SKIP"
          rule {
            name = "SkipAfterVerifierPrerequisite"
            rule_type_id {
              category = "Rule"
              owner    = "AWS"
              provider = "VariableCheck"
              version  = "1"
            }
            configuration = {
              Variable = "#{ReleaseResolution.AppInputMode}"
              Value    = "verifier-prerequisite"
              Operator = "NE"
            }
          }
        }
      }
    }

    action {
      name            = "PublishCurrentStatus"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput"]

      configuration = {
        EnvironmentVariables = local.foundation_app_status_publisher_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_deployment_status_publisher[0].name
      }
    }
  }

  lifecycle {
    precondition {
      condition = alltrue([
        length(local.app_signature_preflight_plan_env_variables) <= 1000,
        length(local.app_signature_preflight_apply_env_variables) <= 1000,
        length(local.app_signature_preflight_invoke_env_variables) <= 1000,
        length(local.app_codebuild_release_resolution_env_variables) <= 1000,
        length(local.app_codebuild_deployment_env_variables) <= 1000,
        length(local.app_codebuild_plan_env_variables) <= 1000,
        length(local.app_codebuild_apply_env_variables) <= 1000,
        length(local.foundation_app_status_publisher_env_variables) <= 1000,
      ])
      error_message = "CodePipeline action configuration values must remain within the 1,000-character quota."
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
