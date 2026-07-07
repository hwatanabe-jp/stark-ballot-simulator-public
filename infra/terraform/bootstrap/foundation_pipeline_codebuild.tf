resource "aws_codebuild_project" "foundation_validate" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_validate_project_name
  service_role  = aws_iam_role.foundation_terraform_plan[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.foundation_validate_project_name].name
      stream_name = "validate"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          "runtime-versions" = {
            nodejs = 24
          }
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "mkdir -p infra/terraform/foundation/evidence",
            "terraform -chdir=infra/terraform/foundation init -backend=false",
            "terraform -chdir=infra/terraform/bootstrap fmt -check -recursive",
            "terraform -chdir=infra/terraform/foundation fmt -check -recursive",
            local.foundation_backend_config_command,
            local.foundation_tfvars_command,
            local.foundation_guard_validate_command,
            "node --version | grep -E '^v24\\.'",
            "printf '{\"schemaVersion\":\"foundation-saved-plan-evidence-v1\",\"manifestType\":\"foundation-validate\",\"stateIdentity\":\"stark-dev/develop/foundation\",\"sourceSha\":\"%s\",\"appRuntimeResourcesCreated\":false}\\n' \"$CODEBUILD_RESOLVED_SOURCE_VERSION\" > infra/terraform/foundation/evidence/foundation-validate.json",
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/foundation/evidence/foundation-validate.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_terraform_plan" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_terraform_plan_project_name
  service_role  = aws_iam_role.foundation_terraform_plan[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.foundation_terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          "runtime-versions" = {
            nodejs = 24
          }
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_ValidateOutput\"",
            "mkdir -p infra/terraform/foundation/evidence",
            "cp \"$CODEBUILD_SRC_DIR_ValidateOutput\"/infra/terraform/foundation/evidence/foundation-validate.json infra/terraform/foundation/evidence/foundation-validate.json",
            local.foundation_backend_config_command,
            local.foundation_tfvars_command,
            local.foundation_guard_init_command,
            local.foundation_guard_validate_command,
            "terraform -chdir=infra/terraform/foundation version -json > infra/terraform/foundation/evidence/terraform-version.json",
            "terraform -chdir=infra/terraform/foundation providers > infra/terraform/foundation/evidence/terraform-providers.txt",
            local.foundation_guard_plan_command,
            "terraform -chdir=infra/terraform/foundation show -no-color tfplan > infra/terraform/foundation/tfplan.txt",
            "terraform -chdir=infra/terraform/foundation show -json tfplan > infra/terraform/foundation/tfplan.json",
            "sha256sum infra/terraform/foundation/tfplan > infra/terraform/foundation/tfplan.sha256",
            "printf '{\"schemaVersion\":\"foundation-saved-plan-evidence-v1\",\"manifestType\":\"foundation-plan\",\"stateIdentity\":\"stark-dev/develop/foundation\",\"sourceSha\":\"%s\",\"planChecksum\":\"%s\",\"appRuntimeResourcesCreated\":false}\\n' \"$CODEBUILD_RESOLVED_SOURCE_VERSION\" \"$(cut -d ' ' -f1 infra/terraform/foundation/tfplan.sha256)\" > infra/terraform/foundation/evidence/foundation-plan.json",
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/foundation/tfplan",
          "infra/terraform/foundation/tfplan.txt",
          "infra/terraform/foundation/tfplan.json",
          "infra/terraform/foundation/tfplan.sha256",
          "infra/terraform/foundation/pipeline.auto.tfvars",
          "infra/terraform/foundation/evidence/foundation-validate.json",
          "infra/terraform/foundation/evidence/foundation-plan.json",
          "infra/terraform/foundation/evidence/terraform-version.json",
          "infra/terraform/foundation/evidence/terraform-providers.txt",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_terraform_apply" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_terraform_apply_project_name
  service_role  = aws_iam_role.foundation_terraform_apply[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.foundation_terraform_apply_project_name].name
      stream_name = "apply"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_PlanOutput\"",
            "mkdir -p infra/terraform/foundation/evidence",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/foundation/tfplan infra/terraform/foundation/tfplan",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/foundation/tfplan.sha256 infra/terraform/foundation/tfplan.sha256",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/foundation/pipeline.auto.tfvars infra/terraform/foundation/pipeline.auto.tfvars",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/foundation/evidence/foundation-plan.json infra/terraform/foundation/evidence/foundation-plan.json",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/foundation/evidence/terraform-version.json infra/terraform/foundation/evidence/terraform-version.json",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/foundation/evidence/terraform-providers.txt infra/terraform/foundation/evidence/terraform-providers.txt",
            "sha256sum -c infra/terraform/foundation/tfplan.sha256",
            local.foundation_backend_config_command,
            "aws sts get-caller-identity --output json --no-cli-pager > infra/terraform/foundation/evidence/apply-caller.json",
            "aws codepipeline list-action-executions --pipeline-name ${local.foundation_pipeline_name} --filter \"pipelineExecutionId=$FOUNDATION_PIPELINE_EXECUTION_ID\" --output json --no-cli-pager > infra/terraform/foundation/evidence/foundation-action-executions.json",
            local.foundation_guard_init_command,
            local.foundation_guard_apply_command,
            "terraform -chdir=infra/terraform/foundation output -json > infra/terraform/foundation/apply-outputs.json",
            "printf '{\"schemaVersion\":\"foundation-saved-plan-evidence-v1\",\"manifestType\":\"foundation-apply\",\"stateIdentity\":\"stark-dev/develop/foundation\",\"sourceSha\":\"%s\",\"appRuntimeResourcesCreated\":false,\"evidenceClass\":\"FoundationStateAbsenceOfAppRuntime\"}\\n' \"$CODEBUILD_RESOLVED_SOURCE_VERSION\" > infra/terraform/foundation/evidence/foundation-apply.json",
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/foundation/apply-outputs.json",
          "infra/terraform/foundation/evidence/apply-caller.json",
          "infra/terraform/foundation/evidence/foundation-action-executions.json",
          "infra/terraform/foundation/evidence/foundation-apply.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_codebuild_project" "foundation_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name          = local.foundation_smoke_project_name
  service_role  = aws_iam_role.foundation_terraform_smoke[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.foundation_pipeline_codebuild[local.foundation_smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_ApplyOutput\"",
            "mkdir -p infra/terraform/foundation/evidence",
            "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/foundation/apply-outputs.json infra/terraform/foundation/apply-outputs.json",
            "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/foundation/evidence/foundation-apply.json infra/terraform/foundation/evidence/foundation-apply.json",
            local.foundation_backend_config_command,
            local.foundation_tfvars_command,
            local.foundation_guard_smoke_command,
            local.foundation_absence_smoke_command,
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/foundation/evidence/foundation-smoke.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
