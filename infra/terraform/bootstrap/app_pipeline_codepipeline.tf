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
    name          = "DeploymentMode"
    default_value = "normal"
    description   = "Explicit app deployment mode: normal or rollback."
  }

  variable {
    name          = "DynamoDbRecoveryPhase"
    default_value = "primary_active"
    description   = "Explicit DynamoDB recovery phase: primary_active, primary_quiesced, replacement_quiesced, or replacement_active."
  }

  variable {
    name          = "SelectedDeploymentRecordKey"
    default_value = "__NOT_APPLICABLE__"
    description   = "Immutable accepted deployment record key selected only for rollback."
  }

  variable {
    name          = "SelectedDeploymentRecordVersionId"
    default_value = "__NOT_APPLICABLE__"
    description   = "Exact accepted deployment record VersionId selected only for rollback."
  }

  variable {
    name          = "SelectedDeploymentRecordSha256"
    default_value = "__NOT_APPLICABLE__"
    description   = "Exact accepted deployment record body SHA-256 selected only for rollback."
  }

  variable {
    name          = "FoundationAppNetworkingKey"
    default_value = "__REQUIRED_FOR_NORMAL__"
    description   = "Fixed Foundation app-networking handoff key selected for a normal deployment."
  }

  variable {
    name          = "FoundationAppNetworkingVersionId"
    default_value = "__REQUIRED_FOR_NORMAL__"
    description   = "Exact S3 VersionId for the selected Foundation app-networking handoff."
  }

  variable {
    name          = "FoundationAppNetworkingSha256"
    default_value = "__REQUIRED_FOR_NORMAL__"
    description   = "Exact body SHA-256 for the selected Foundation app-networking handoff."
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
    name = "VerifierStateRefreshPlan"

    action {
      name             = "PlanVerifierStateRefresh"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      namespace        = "VerifierStateRefreshPlan"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["VerifierStateRefreshPlanOutput"]

      configuration = {
        EnvironmentVariables = local.app_signature_state_refresh_plan_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_state_refresh_plan[0].name
      }
    }
  }

  stage {
    name = "VerifierStateRefreshApproval"

    before_entry {
      condition {
        result = "SKIP"

        rule {
          name = "SkipWhenVerifierStateIsAlreadyCurrent"

          rule_type_id {
            category = "Rule"
            owner    = "AWS"
            provider = "VariableCheck"
            version  = "1"
          }

          configuration = {
            Variable = "#{VerifierStateRefreshPlan.VerifierStateRefreshRequired}"
            Value    = "false"
            Operator = "NE"
          }
        }
      }
    }

    action {
      name     = "ApproveVerifierStateRefresh"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing VerifierStateRefreshPlanOutput/infra/terraform/app/tfplan.txt, tfplan.sha256, and image-signature-state-refresh-plan.json. This saved refresh-only plan may update Terraform state only for the exact reviewed interrupted verifier publish/alias metadata and provider projections; it may not perform remote resource actions. Approval summary must be exact JSON: {\"sourceSha\":\"#{AppSource.CommitId}\",\"accountId\":\"${var.aws_account_id}\",\"deploymentEnvironment\":\"develop\",\"reviewedPlanChecksum\":\"<tfplan sha256>\",\"stateRefreshDisposition\":\"reviewed-state-refresh\"}."
      }
    }
  }

  stage {
    name = "VerifierStateRefreshApply"

    before_entry {
      condition {
        result = "SKIP"

        rule {
          name = "SkipWhenVerifierStateApplyIsUnnecessary"

          rule_type_id {
            category = "Rule"
            owner    = "AWS"
            provider = "VariableCheck"
            version  = "1"
          }

          configuration = {
            Variable = "#{VerifierStateRefreshPlan.VerifierStateRefreshRequired}"
            Value    = "false"
            Operator = "NE"
          }
        }
      }
    }

    action {
      name             = "ApplyReviewedVerifierStateRefresh"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "VerifierStateRefreshPlanOutput"]
      output_artifacts = ["VerifierStateRefreshApplyOutput"]

      configuration = {
        EnvironmentVariables = local.app_signature_state_refresh_apply_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_state_refresh_apply[0].name
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
      input_artifacts  = ["SourceOutput"]
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
        CustomData = "Approve only after reviewing VerifierPreflightPlanOutput/infra/terraform/app/tfplan.txt, tfplan.sha256, image-signature-preflight-plan.json, and image-signature-verifier-package.json. Confirm that the plan binds this execution's exact source SHA to the accepted digest-pinned Prover image. The allowlist permits only the cryptographic verifier log group, execution role and policy, immutable Lambda version, and preflight alias. After apply, the preflight alias must cryptographically verify that Prover image before the App lane can continue. Approval summary must be exact JSON: {\"sourceSha\":\"#{AppSource.CommitId}\",\"accountId\":\"${var.aws_account_id}\",\"deploymentEnvironment\":\"develop\",\"reviewedPlanChecksum\":\"<tfplan sha256>\"}."
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
      input_artifacts  = ["SourceOutput", "VerifierPreflightPlanOutput"]
      output_artifacts = ["SigApply"]

      configuration = {
        EnvironmentVariables = local.app_signature_preflight_apply_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_preflight_apply[0].name
      }
    }
  }

  stage {
    name = "VerifierPreflightVerify"

    action {
      name             = "VerifyCryptographicImageSignature"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "SigApply"]
      output_artifacts = ["VerifierPreflightVerifyOutput"]

      configuration = {
        EnvironmentVariables = local.app_signature_preflight_invoke_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_signature_preflight_invoke[0].name
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
      input_artifacts  = ["SourceOutput", "VerifierPreflightVerifyOutput"]
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
        EnvironmentVariables = local.app_codebuild_deployment_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_validate[0].name
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
          name = "SkipEmptyDevelopPlan"

          rule_type_id {
            category = "Rule"
            owner    = "AWS"
            provider = "VariableCheck"
            version  = "1"
          }

          configuration = {
            Variable = "#{PlanAppState.APPROVAL_REQUIRED}"
            Value    = "false"
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
        CustomData = "Approve only after reviewing PlanOutput/infra/terraform/app/tfplan.txt, infra/terraform/app/tfplan.sha256, and infra/terraform/app/evidence/target-lambda-artifacts.json for stark-dev/develop/app. Rollback always requires approval even when Terraform is empty. Approval summary must be JSON: {\"deploymentMode\":\"normal|rollback\",\"controlSourceSha\":\"<current pipeline source sha>\",\"selectedSourceSha\":\"<selected deployment sha>\",\"accountId\":\"${var.aws_account_id}\",\"deploymentEnvironment\":\"develop\",\"reviewedPlanChecksum\":\"<tfplan sha256>\"}."
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
        EnvironmentVariables = local.app_codebuild_plan_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_terraform_apply[0].name
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
        EnvironmentVariables = local.app_codebuild_deployment_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_static_deploy[0].name
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
        EnvironmentVariables = local.app_codebuild_deployment_env_variables
        PrimarySource        = "SourceOutput"
        ProjectName          = aws_codebuild_project.app_smoke[0].name
      }
    }
  }

  lifecycle {
    precondition {
      condition = alltrue([
        length(local.app_signature_preflight_plan_env_variables) <= 1000,
        length(local.app_signature_state_refresh_plan_env_variables) <= 1000,
        length(local.app_signature_state_refresh_apply_env_variables) <= 1000,
        length(local.app_signature_preflight_apply_env_variables) <= 1000,
        length(local.app_signature_preflight_invoke_env_variables) <= 1000,
        length(local.app_codebuild_source_env_variables) <= 1000,
        length(local.app_codebuild_deployment_env_variables) <= 1000,
        length(local.app_codebuild_plan_env_variables) <= 1000,
      ])
      error_message = "CodePipeline action configuration values must remain within the 1,000-character quota."
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
