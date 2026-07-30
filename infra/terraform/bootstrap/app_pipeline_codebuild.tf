resource "aws_codebuild_project" "app_deployment_record" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_deployment_record_project_name
  service_role  = aws_iam_role.app_deployment_record[0].arn
  build_timeout = 15

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_deployment_record_project_name].name
      stream_name = "app-deployment-record"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      env = {
        "git-credential-helper" = "yes"
        "exported-variables" = [
          "DeploymentMode",
          "AppDeploymentRecordSha256",
          "AppSourceSha",
          "DeploymentId",
        ]
      }
      phases = {
        install = {
          "runtime-versions" = {
            nodejs = 24
          }
          commands = [
            "corepack enable",
            "pnpm install --frozen-lockfile",
          ]
        }
        build = {
          commands = [
            <<-EOT
set -eu
test "$APP_DEPLOYMENT_MODE" = normal -o "$APP_DEPLOYMENT_MODE" = rollback
test -n "$CODEBUILD_SRC_DIR_VerifierPreflightVerifyOutput"
APP_IMAGE_SIGNATURE_PREFLIGHT_PUBLICATION_PATH="$CODEBUILD_SRC_DIR_VerifierPreflightVerifyOutput/.tmp/app-signature-preflight/publication.json" APP_PIPELINE_ARTIFACT_BUCKET="${local.app_pipeline_artifact_bucket_name}" APP_EXPECTED_AWS_ACCOUNT_ID="${var.aws_account_id}" APP_EXPECTED_AWS_REGION="${var.aws_region}" APP_EXPECTED_DEPLOYMENT_ENVIRONMENT="${var.deployment_environment}" infra/terraform/bootstrap/app-pipeline-scripts/app-deployment-selection.sh
export DeploymentMode="$APP_DEPLOYMENT_MODE"
AppDeploymentRecordSha256="$(node -e 'const fs=require("node:fs"); const e=JSON.parse(fs.readFileSync("infra/terraform/app/evidence/app-deployment-record-generation.json","utf8")); process.stdout.write(e.appDeploymentRecordSha256)')"
export AppDeploymentRecordSha256
AppSourceSha="$(node -e 'const fs=require("node:fs"); const e=JSON.parse(fs.readFileSync("infra/terraform/app/evidence/app-deployment-record-generation.json","utf8")); process.stdout.write(e.appSourceSha)')"
export AppSourceSha
APP_DEPLOYMENT_RECORD_SHA256="$AppDeploymentRecordSha256" APP_SOURCE_SHA="$AppSourceSha" pnpm tsx scripts/aws/deployment-identity.ts --write deployment-identity.json
DeploymentId="$(node -e 'const fs=require("node:fs"); const e=JSON.parse(fs.readFileSync("deployment-identity.json","utf8")); process.stdout.write(e.deploymentId)')"
export DeploymentId
cat infra/terraform/app/evidence/app-deployment-record-generation.json
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "app-deployment-record.json",
          "app-deployment-selection-input.json",
          "foundation-app-networking-validation.json",
          "image-signature-preflight-validation.json",
          "toolchain-artifact-record.json",
          "prover-release-record.json",
          "selected-deployment-record.json",
          "rollback-selection.json",
          "zkvm-contract-descriptor.json",
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
          "deployment-identity.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_validate" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_validate_project_name
  service_role  = aws_iam_role.app_terraform_plan[0].arn
  build_timeout = 30

  artifacts {
    type = "CODEPIPELINE"
  }

  cache {
    type     = "S3"
    location = "${aws_s3_bucket.app_pipeline_artifacts[0].bucket}/codebuild-cache/${local.app_validate_project_name}"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_validate_project_name].name
      stream_name = "validate"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      env = {
        "git-credential-helper" = "yes"
      }
      phases = {
        install = {
          "runtime-versions" = {
            nodejs = 24
          }
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"",
            "terraform -chdir=infra/terraform/app init -backend=false",
            "terraform -chdir=infra/terraform/bootstrap fmt -check -recursive",
            "terraform -chdir=infra/terraform/app fmt -check -recursive",
            local.app_guard_validate_command,
            "node --version | grep -E '^v24\\.'",
            "corepack enable",
            "pnpm install --frozen-lockfile",
            "pnpm format:check",
            "pnpm lint",
            "pnpm type-check",
            "pnpm public-safety:scan",
            "mkdir -p infra/terraform/app/evidence",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/app-deployment-record.json app-deployment-record.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/infra/terraform/app/evidence/app-deployment-record-generation.json infra/terraform/app/evidence/app-deployment-record-generation.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/deployment-identity.json deployment-identity.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/selected-deployment-record.json selected-deployment-record.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/rollback-selection.json rollback-selection.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/image-signature-preflight-validation.json image-signature-preflight-validation.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/toolchain-artifact-record.json toolchain-artifact-record.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/prover-release-record.json prover-release-record.json",
            "if [ -f \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput/zkvm-contract-descriptor.json\" ]; then cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput/zkvm-contract-descriptor.json\" zkvm-contract-descriptor.json; fi",
            local.app_source_preflight_command,
            "pnpm test:run",
          ]
        }
      }
      cache = {
        paths = [
          "~/.local/share/pnpm/store/**/*",
          "~/.cargo/**/*",
          "target/**/*",
          "zkvm/target/**/*",
          "verifier-service/target/**/*",
        ]
      }
      artifacts = {
        files = [
          "app-deployment-record.json",
          "selected-deployment-record.json",
          "rollback-selection.json",
          "image-signature-preflight-validation.json",
          "toolchain-artifact-record.json",
          "prover-release-record.json",
          "zkvm-contract-descriptor.json",
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
          "deployment-identity.json",
          "infra/terraform/app/evidence/source-preflight.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_terraform_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_terraform_plan_project_name
  service_role  = aws_iam_role.app_terraform_plan[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  cache {
    type     = "S3"
    location = "${aws_s3_bucket.app_pipeline_artifacts[0].bucket}/codebuild-cache/${local.app_terraform_plan_project_name}"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_ACCOUNT_ALIAS"
      value = var.account_alias
    }

    environment_variable {
      name  = "APP_BACKEND_CONFIG_BASE64"
      value = base64encode(local.app_backend_config_content)
    }

    environment_variable {
      name  = "APP_DEPLOYMENT_ENVIRONMENT"
      value = var.deployment_environment
    }

    environment_variable {
      name  = "APP_EXPECTED_AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_EXPECTED_AWS_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_BUCKET"
      value = local.app_pipeline_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_PIPELINE_TFVARS_BASE64"
      value = base64encode(local.app_pipeline_tfvars_content)
    }

    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_KMS_KEY_ID"
      value = var.state_kms_alias
    }

    environment_variable {
      name  = "TERRAFORM_APP_BACKEND_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "TERRAFORM_VERSION"
      value = var.terraform_version
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "infra/terraform/bootstrap/buildspec-app-terraform-plan.yml"
  }
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_terraform_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_terraform_apply_project_name
  service_role  = aws_iam_role.app_terraform_apply[0].arn
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
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_terraform_apply_project_name].name
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
            "mkdir -p infra/terraform/app/evidence",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/app/.terraform.lock.hcl infra/terraform/app/.terraform.lock.hcl",
            "for path in app-deployment-record.json deployment-identity.json selected-deployment-record.json rollback-selection.json image-signature-preflight-validation.json toolchain-artifact-record.json prover-release-record.json infra/terraform/app/tfplan infra/terraform/app/tfplan.sha256 infra/terraform/app/pipeline.auto.tfvars infra/terraform/app/dynamodb-recovery.auto.tfvars.json infra/terraform/app/evidence/app-deployment-record-generation.json infra/terraform/app/evidence/dynamodb-recovery-selection.json infra/terraform/app/evidence/source-preflight.json infra/terraform/app/evidence/target-lambda-artifacts.json infra/terraform/app/evidence/app-plan-empty.json infra/terraform/app/evidence/image-signature-verifier-plan-identity.json; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
            "if [ -f \"$CODEBUILD_SRC_DIR_PlanOutput/zkvm-contract-descriptor.json\" ]; then cp \"$CODEBUILD_SRC_DIR_PlanOutput/zkvm-contract-descriptor.json\" zkvm-contract-descriptor.json; fi",
            "sha256sum -c infra/terraform/app/tfplan.sha256",
            "corepack enable",
            "pnpm install --frozen-lockfile",
            local.app_source_preflight_command,
            local.app_recovery_prepare_command,
            local.app_signature_authority_revalidation_command,
            local.app_backend_config_command,
            local.app_guard_init_command,
            "APP_PIPELINE_NAME=${local.app_pipeline_name} APP_PIPELINE_EXECUTION_ID=\"$APP_PIPELINE_EXECUTION_ID\" APP_DEPLOYMENT_MODE=\"$APP_DEPLOYMENT_MODE\" APP_EXPECTED_CONTROL_SOURCE_SHA=\"$CODEBUILD_RESOLVED_SOURCE_VERSION\" APP_EXPECTED_SELECTED_SOURCE_SHA=\"$APP_SOURCE_SHA\" APP_EXPECTED_ACCOUNT_ID=${var.aws_account_id} APP_DEPLOYMENT_ENVIRONMENT=${var.deployment_environment} APP_TFPLAN_SHA256_PATH=infra/terraform/app/tfplan.sha256 APP_PLAN_EMPTY_EVIDENCE_PATH=infra/terraform/app/evidence/app-plan-empty.json APP_APPROVAL_EVIDENCE_PATH=infra/terraform/app/evidence/approval-evidence.json APP_APPROVAL_PUBLICATION_PATH=infra/terraform/app/evidence/approval-evidence-publication.json APP_PIPELINE_ARTIFACT_BUCKET=${local.app_pipeline_artifact_bucket_name} APP_APPROVAL_EVIDENCE_KEY_PREFIX=approval-evidence infra/terraform/bootstrap/app-pipeline-scripts/app-approval-evidence.sh",
            local.app_guard_apply_command,
            "terraform -chdir=infra/terraform/app output -json > infra/terraform/app/apply-outputs.json",
            "node infra/terraform/bootstrap/app-pipeline-scripts/validate-image-signature-verifier-identity.mjs --deployment-mode \"$APP_DEPLOYMENT_MODE\" --phase apply --terraform-json infra/terraform/app/apply-outputs.json --preflight-validation image-signature-preflight-validation.json --app-deployment-record app-deployment-record.json --expected-prior infra/terraform/app/evidence/image-signature-verifier-plan-identity.json --output infra/terraform/app/evidence/image-signature-verifier-apply-identity.json",
          ]
        }
      }
      artifacts = {
        files = [
          "app-deployment-record.json",
          "deployment-identity.json",
          "selected-deployment-record.json",
          "rollback-selection.json",
          "image-signature-preflight-validation.json",
          "toolchain-artifact-record.json",
          "prover-release-record.json",
          "infra/terraform/app/apply-outputs.json",
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
          "infra/terraform/app/evidence/dynamodb-recovery-selection.json",
          "infra/terraform/app/evidence/source-preflight.json",
          "infra/terraform/app/evidence/target-lambda-artifacts.json",
          "infra/terraform/app/evidence/approval-evidence.json",
          "infra/terraform/app/evidence/approval-evidence-publication.json",
          "infra/terraform/app/evidence/image-signature-verifier-apply-identity.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

locals {
  app_smoke_buildspec = yamlencode({
    version = "0.2"
    phases = {
      build = {
        commands = [
          "test -n \"$CODEBUILD_SRC_DIR_PlanOutput\"",
          "test -n \"$CODEBUILD_SRC_DIR_ApplyOutput\"",
          "test -n \"$CODEBUILD_SRC_DIR_StaticDeployOutput\"",
          "mkdir -p infra/terraform/app/evidence",
          "for path in app-deployment-record.json deployment-identity.json selected-deployment-record.json rollback-selection.json image-signature-preflight-validation.json toolchain-artifact-record.json prover-release-record.json; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
          "if [ -f \"$CODEBUILD_SRC_DIR_PlanOutput/zkvm-contract-descriptor.json\" ]; then cp \"$CODEBUILD_SRC_DIR_PlanOutput/zkvm-contract-descriptor.json\" zkvm-contract-descriptor.json; fi",
          "for path in infra/terraform/app/tfplan infra/terraform/app/tfplan.sha256 infra/terraform/app/tfplan.txt infra/terraform/app/tfplan.json infra/terraform/app/evidence/app-deployment-record-generation.json infra/terraform/app/evidence/dynamodb-recovery-selection.json infra/terraform/app/evidence/source-preflight.json infra/terraform/app/evidence/target-lambda-artifacts.json infra/terraform/app/evidence/app-plan-empty.json infra/terraform/app/evidence/image-signature-verifier-plan-identity.json infra/terraform/app/evidence/terraform-version.json infra/terraform/app/evidence/terraform-providers.txt; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/apply-outputs.json infra/terraform/app/apply-outputs.json",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/evidence/approval-evidence.json infra/terraform/app/evidence/approval-evidence.json",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/evidence/approval-evidence-publication.json infra/terraform/app/evidence/approval-evidence-publication.json",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/evidence/image-signature-verifier-apply-identity.json infra/terraform/app/evidence/image-signature-verifier-apply-identity.json",
          "cp \"$CODEBUILD_SRC_DIR_StaticDeployOutput\"/infra/terraform/app/evidence/static-frontend-deploy.json infra/terraform/app/evidence/static-frontend-deploy.json",
          "aws sts get-caller-identity --output json --no-cli-pager > app-smoke-caller.json",
          local.app_signature_authority_revalidation_command,
          "node infra/terraform/bootstrap/app-pipeline-scripts/validate-image-signature-verifier-identity.mjs --deployment-mode \"$APP_DEPLOYMENT_MODE\" --phase smoke --terraform-json infra/terraform/app/apply-outputs.json --preflight-validation image-signature-preflight-validation.json --app-deployment-record app-deployment-record.json --expected-prior infra/terraform/app/evidence/image-signature-verifier-apply-identity.json --output infra/terraform/app/evidence/image-signature-verifier-smoke-identity.json",
          local.app_guard_smoke_command,
          local.app_no_runtime_source_check_command,
          local.app_smoke_operator_gate_keyset_command,
          local.app_smoke_dynamodb_data_plane_command,
          local.app_smoke_dynamodb_recovery_phase_command,
          local.app_smoke_denial_checks_command,
          local.app_fetch_existing_acceptance_current_authority_command,
          "bash infra/terraform/bootstrap/app-pipeline-scripts/app-smoke-report.sh",
          local.app_acceptance_publish_command,
          local.app_acceptance_event_publish_command,
        ]
      }
    }
    artifacts = {
      files = [
        "app-smoke-terraform-files.txt",
        "deployment-identity.json",
        "app-smoke-declared-blocks.txt",
        "app-smoke-state-denial-simulation.json",
        "app-smoke-mutation-denial-simulation.json",
        "app-smoke-denial-evidence.json",
        "app-smoke-operator-gate-keyset-evidence.json",
        "app-smoke-dynamodb-data-plane-evidence.json",
        "app-smoke-dynamodb-recovery-phase-evidence.json",
        "app-smoke-caller.json",
        "app-smoke-report.json",
        "app-acceptance-event-publication.json",
        "infra/terraform/app/evidence/retained-acceptance-authority-validation.json",
        "infra/terraform/app/evidence/static-frontend-deploy.json",
        "${local.app_accepted_marker_path}/current.json",
        "${local.app_accepted_marker_path}/**/*",
      ]
    }
  })
}

resource "aws_codebuild_project" "app_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_smoke_project_name
  service_role  = aws_iam_role.app_terraform_smoke[0].arn
  build_timeout = 10

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_BUCKET"
      value = local.app_pipeline_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "APP_AWS_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_DEPLOYMENT_ENVIRONMENT"
      value = var.deployment_environment
    }

    environment_variable {
      name  = "APP_TERRAFORM_SMOKE_ROLE_NAME"
      value = local.app_terraform_smoke_role_name
    }

    environment_variable {
      name  = "APP_ACCEPTED_MARKER_PATH"
      value = local.app_accepted_marker_path
    }

    environment_variable {
      name  = "APP_ACCEPTED_DEPLOYMENT_RETENTION_COUNT"
      value = tostring(local.app_accepted_deployment_retention_count)
    }

    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_RETENTION_DAYS"
      value = tostring(local.storage_retention.app_accepted_authority_days)
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = local.app_smoke_buildspec
  }

  lifecycle {
    precondition {
      condition     = length(local.app_smoke_buildspec) <= 24000
      error_message = "The app smoke buildspec must stay within the 24,000-character operational budget below the CodeBuild limit."
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_static_deploy_project_name
  service_role  = aws_iam_role.app_static_deploy[0].arn
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
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_static_deploy_project_name].name
      stream_name = "static-deploy"
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
          commands = [
            "corepack enable",
          ]
        }
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_ApplyOutput\"",
            "mkdir -p infra/terraform/app/evidence",
            "test \"$APP_STATIC_FAST_MODE\" = true -o \"$APP_STATIC_FAST_MODE\" = false",
            "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/apply-outputs.json infra/terraform/app/apply-outputs.json",
            "if [ \"$APP_STATIC_FAST_MODE\" = true ]; then test \"$APP_DEPLOYMENT_MODE\" = normal; cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/evidence/static-fast-gate.json infra/terraform/app/evidence/static-fast-gate.json; else cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/app-deployment-record.json app-deployment-record.json; fi",
            "if [ \"$APP_STATIC_FAST_MODE\" = true ]; then APP_DEPLOYMENT_ID=\"$(node -e 'const fs=require(\"node:fs\"); const e=JSON.parse(fs.readFileSync(\"infra/terraform/app/evidence/static-fast-gate.json\",\"utf8\")); process.stdout.write(e.deploymentId || \"\")')\"; export APP_DEPLOYMENT_ID; fi",
            "if [ \"$APP_DEPLOYMENT_MODE\" = rollback ]; then cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/selected-deployment-record.json selected-deployment-record.json; else printf '{}\\n' > selected-deployment-record.json; fi",
            <<-EOT
set -eu
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const staticFastMode = process.env.APP_STATIC_FAST_MODE === "true";
if (!/^dep_[0-9a-f]{32}$/.test(process.env.APP_DEPLOYMENT_ID || "")) {
  throw new Error("Static deployment requires an accepted APP_DEPLOYMENT_ID.");
}
const applyOutputsBody = fs.readFileSync("infra/terraform/app/apply-outputs.json", "utf8");
const outputs = JSON.parse(applyOutputsBody);
if (
  outputs.app_state_identity?.value !== "stark-dev/develop/app" ||
  outputs.app_state_backend_key?.value !==
    "stark-ballot-simulator/stark-dev/develop/app/terraform.tfstate"
) {
  throw new Error("Static deployment apply output does not identify the expected app state.");
}
if (staticFastMode) {
  const gate = JSON.parse(fs.readFileSync("infra/terraform/app/evidence/static-fast-gate.json", "utf8"));
  const actualApplyOutputsSha256 = crypto.createHash("sha256").update(applyOutputsBody).digest("hex");
  if (
    gate.gateType !== "app-static-fast" ||
    gate.deploymentId !== process.env.APP_DEPLOYMENT_ID ||
    gate.sourceSha !== process.env.APP_SOURCE_SHA ||
    actualApplyOutputsSha256 !== gate.applyOutputsSha256 ||
    gate.stateIdentity !== outputs.app_state_identity.value ||
    gate.backendKey !== outputs.app_state_backend_key.value ||
    gate.accountAlias !== "stark-dev" ||
    gate.deploymentEnvironment !== "develop" ||
    !/^[0-9a-f]{40}$/.test(gate.acceptedSourceSha || "") ||
    !/^[0-9a-f]{64}$/.test(gate.imageIdMappingSha256 || "")
  ) {
    throw new Error("Static fast deployment evidence does not match the accepted app authority.");
  }
} else {
  const appDeploymentRecordBody = fs.readFileSync("app-deployment-record.json", "utf8");
  const appDeploymentRecord = JSON.parse(appDeploymentRecordBody);
  const actualSha256 = crypto.createHash("sha256").update(appDeploymentRecordBody).digest("hex");
  if (
    !/^[0-9a-f]{64}$/.test(process.env.APP_DEPLOYMENT_RECORD_SHA256 || "") ||
    actualSha256 !== process.env.APP_DEPLOYMENT_RECORD_SHA256 ||
    appDeploymentRecord.recordType !== "app-deployment" ||
    appDeploymentRecord.appSourceSha !== process.env.APP_SOURCE_SHA
  ) {
    throw new Error("Static deployment app record does not match the selected immutable authority.");
  }
}
NODE
pnpm install --frozen-lockfile --ignore-scripts
if [ "$APP_DEPLOYMENT_MODE" = "normal" ]; then
echo "Resolve Plan 02 static frontend config"
mkdir -p .tmp
node <<'NODE' > .tmp/static-frontend-config.env
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const outputs = JSON.parse(fs.readFileSync("infra/terraform/app/apply-outputs.json", "utf8"));
const references = outputs.runtime_secret_config_reference_names && outputs.runtime_secret_config_reference_names.value;

function requireString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(name + " is required before target static frontend build.");
  }
  if (/__MISSING_|<|>|change-me|placeholder/i.test(value)) {
    throw new Error(name + " must not be a placeholder.");
  }
  return value.trim();
}

const siteKeyRef = requireString(
  "VITE_TURNSTILE_SITE_KEY_REF",
  references && references.VITE_TURNSTILE_SITE_KEY_REF
);
if (!siteKeyRef.endsWith("/app/config/vite-turnstile-site-key")) {
  throw new Error("VITE_TURNSTILE_SITE_KEY_REF must point at the target browser-public site-key parameter.");
}
const siteKey = requireString(
  "VITE_TURNSTILE_SITE_KEY",
  execFileSync("aws", ["ssm", "get-parameter", "--name", siteKeyRef, "--query", "Parameter.Value", "--output", "text", "--no-cli-pager"], { encoding: "utf8" })
);

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function exportValue(name, value) {
  console.log("export " + name + "=" + shellQuote(value));
}

console.log("unset VITE_API_BASE_URL");
exportValue("VITE_APP_ENV", "develop");
exportValue("VITE_DEPLOYMENT_ID", process.env.APP_DEPLOYMENT_ID);
console.log("unset VITE_CONTRACT_GENERATION");
console.log("unset CONTRACT_GENERATION");
exportValue("TARGET_DEVELOP_OPERATOR_GATE_ENABLED", "true");
exportValue("TARGET_PUBLIC_SESSION_CREATE_ENABLED", "true");
exportValue("SESSION_CREATE_TURNSTILE_REQUIRED", "false");
exportValue("VITE_SESSION_CREATE_TURNSTILE_REQUIRED", "false");
exportValue("VITE_STH_SOURCES", "/api/sth");
exportValue("VITE_STH_MIN_MATCHES", "1");
exportValue("VITE_TURNSTILE_BYPASS", "false");
exportValue("VITE_TURNSTILE_SITE_KEY", siteKey);
exportValue("VITE_USE_MOCK_API", "false");
NODE
. .tmp/static-frontend-config.env
pnpm tsx scripts/aws/static-frontend-config-authority.ts --apply-outputs infra/terraform/app/apply-outputs.json --write-record infra/terraform/app/evidence/static-frontend-config-authority.json
pnpm build:ci
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const staticFastMode = process.env.APP_STATIC_FAST_MODE === "true";
const staticFastGate = staticFastMode
  ? JSON.parse(fs.readFileSync("infra/terraform/app/evidence/static-fast-gate.json", "utf8"))
  : null;
const appDeploymentRecord = staticFastMode
  ? null
  : JSON.parse(fs.readFileSync("app-deployment-record.json", "utf8"));
const expectedImageIdMappingSha256 = staticFastMode
  ? staticFastGate.imageIdMappingSha256
  : appDeploymentRecord.imageIdMappingSha256;
const imageIdMappingSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync("dist/imageId-mapping.json"))
  .digest("hex");
if (
  !/^[0-9a-f]{64}$/.test(expectedImageIdMappingSha256 || "") ||
  imageIdMappingSha256 !== expectedImageIdMappingSha256
) {
  throw new Error("Static frontend ImageID mapping checksum does not match its deployment authority.");
}
NODE
rm -f .tmp/static-frontend-config.env
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf .tmp/static-frontend-dist.tar dist infra/terraform/app/evidence/static-frontend-config-authority.json
gzip -n -c .tmp/static-frontend-dist.tar > .tmp/static-frontend-dist.tar.gz
static_archive_key="static-frontend-artifacts/$APP_SOURCE_SHA/$APP_DEPLOYMENT_ID/dist.tar.gz"
static_is_precondition_failure() {
  grep -Eiq '^(An error occurred \((PreconditionFailed|412)\) when calling the ([A-Za-z0-9-]+ )?operation:|PreconditionFailed: 412$)' "$1"
}
static_is_conditional_conflict() {
  grep -Eiq '^(An error occurred \((ConditionalRequestConflict|409)\) when calling the ([A-Za-z0-9-]+ )?operation:|ConditionalRequestConflict: 409$)' "$1"
}
static_put_state=""
static_put_attempt=1
while [ "$static_put_attempt" -le 4 ]; do
  set +e
  aws s3api put-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_archive_key" --body .tmp/static-frontend-dist.tar.gz --metadata "sourceSha=$APP_SOURCE_SHA" --if-none-match '*' --expected-bucket-owner "${var.aws_account_id}" --region "${var.aws_region}" --output json --no-cli-pager > .tmp/static-frontend-dist.put-object.json 2> .tmp/static-frontend-dist.put-object.error
  static_put_status=$?
  set -e
  if [ "$static_put_status" -eq 0 ]; then
    static_put_state=published
    break
  fi
  if static_is_precondition_failure .tmp/static-frontend-dist.put-object.error; then
    static_put_state=precondition
    break
  fi
  if ! static_is_conditional_conflict .tmp/static-frontend-dist.put-object.error; then
    echo "Static frontend archive conditional publication failed." >&2
    exit 1
  fi
  if [ "$static_put_attempt" -eq 4 ]; then
    echo "Static frontend archive conditional publication retry budget was exhausted." >&2
    exit 1
  fi
  static_put_attempt=$((static_put_attempt + 1))
  sleep 1
done
if [ "$static_put_state" = precondition ]; then
  if ! aws s3api head-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_archive_key" --expected-bucket-owner "${var.aws_account_id}" --region "${var.aws_region}" --output json --no-cli-pager > .tmp/static-frontend-dist.head-object.json 2> .tmp/static-frontend-dist.head-object.error; then
    echo "Retained static frontend archive metadata could not be read." >&2
    exit 1
  fi
  static_archive_version_id="$(node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).VersionId; if(typeof v!=="string"||v.length===0||v==="null"||/\s/.test(v))process.exit(1); process.stdout.write(v)' .tmp/static-frontend-dist.head-object.json)"
  static_archive_etag="$(node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).ETag; if(typeof v!=="string"||v.length===0||/\s/.test(v))process.exit(1); process.stdout.write(v)' .tmp/static-frontend-dist.head-object.json)"
  if ! aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_archive_key" --version-id "$static_archive_version_id" --expected-bucket-owner "${var.aws_account_id}" --region "${var.aws_region}" .tmp/static-frontend-dist.existing.tar.gz --output json --no-cli-pager > .tmp/static-frontend-dist.existing.get-object.json 2> .tmp/static-frontend-dist.existing.get-object.error; then
    echo "Retained static frontend archive exact version could not be read." >&2
    exit 1
  fi
  APP_STATIC_ARCHIVE_VERSION_ID="$static_archive_version_id" APP_STATIC_ARCHIVE_ETAG="$static_archive_etag" node <<'NODE'
const fs = require("node:fs");
const response = JSON.parse(fs.readFileSync(".tmp/static-frontend-dist.existing.get-object.json", "utf8"));
if (
  response.VersionId !== process.env.APP_STATIC_ARCHIVE_VERSION_ID ||
  response.ETag !== process.env.APP_STATIC_ARCHIVE_ETAG
) {
  throw new Error("Retained static frontend archive changed during exact-version verification.");
}
NODE
  cmp -s .tmp/static-frontend-dist.tar.gz .tmp/static-frontend-dist.existing.tar.gz || { echo "Retained static frontend archive differs for the same source SHA." >&2; exit 1; }
  cp .tmp/static-frontend-dist.head-object.json .tmp/static-frontend-dist.put-object.json
elif [ "$static_put_state" != published ]; then
  echo "Static frontend archive publication ended without a terminal result." >&2
  exit 1
fi
APP_STATIC_ARCHIVE_KEY="$static_archive_key" node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const put = JSON.parse(fs.readFileSync(".tmp/static-frontend-dist.put-object.json", "utf8"));
if (
  typeof put.VersionId !== "string" ||
  put.VersionId.length === 0 ||
  put.VersionId.trim() !== put.VersionId ||
  put.VersionId === "null"
) {
  throw new Error("Retained static frontend archive publication requires a non-null VersionId.");
}
fs.writeFileSync("infra/terraform/app/evidence/static-frontend-retained.json", JSON.stringify({
  bucket: "${local.app_pipeline_artifact_bucket_name}",
  key: process.env.APP_STATIC_ARCHIVE_KEY,
  versionId: put.VersionId,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(".tmp/static-frontend-dist.tar.gz")).digest("hex"),
}, null, 2) + "\n");
NODE
elif [ "$APP_DEPLOYMENT_MODE" = "rollback" ]; then
  node <<'NODE' > .tmp/static-frontend-retained.env
const fs = require("node:fs");
const selected = JSON.parse(fs.readFileSync("selected-deployment-record.json", "utf8"));
const retained = selected.retainedDeployables?.staticFrontend;
if (
  !retained?.bucket ||
  !retained?.key ||
  typeof retained?.versionId !== "string" ||
  retained.versionId.length === 0 ||
  retained.versionId.trim() !== retained.versionId ||
  retained.versionId === "null" ||
  !/^[0-9a-f]{64}$/.test(retained.sha256 || "")
) throw new Error("Rollback static frontend retention coordinates are incomplete.");
function q(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
for (const [name, value] of Object.entries({ bucket: retained.bucket, key: retained.key, version: retained.versionId, sha: retained.sha256 })) console.log(name + "=" + q(value));
fs.writeFileSync("infra/terraform/app/evidence/static-frontend-retained.json", JSON.stringify(retained, null, 2) + "\n");
NODE
  set -a
  . .tmp/static-frontend-retained.env
  set +a
  aws s3api get-object --bucket "$bucket" --key "$key" --version-id "$version" --expected-bucket-owner "${var.aws_account_id}" .tmp/static-frontend-dist.tar.gz --output json --no-cli-pager > .tmp/static-frontend-dist.get-object.json
  APP_EXPECTED_STATIC_VERSION="$version" node <<'NODE'
const fs = require("node:fs");
const response = JSON.parse(fs.readFileSync(".tmp/static-frontend-dist.get-object.json", "utf8"));
if (response.VersionId !== process.env.APP_EXPECTED_STATIC_VERSION) {
  throw new Error("Rollback static frontend VersionId mismatch.");
}
NODE
  test "$(sha256sum .tmp/static-frontend-dist.tar.gz | awk '{print $1}')" = "$sha"
  tar -xzf .tmp/static-frontend-dist.tar.gz
else
  echo "APP_DEPLOYMENT_MODE must be normal or rollback." >&2
  exit 1
fi

node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const outputs = JSON.parse(fs.readFileSync("infra/terraform/app/apply-outputs.json", "utf8"));
const frontend = outputs.static_frontend && outputs.static_frontend.value;
if (!frontend || !frontend.frontend_bucket_name || !frontend.cloudfront_distribution_id) {
  throw new Error("static_frontend output is required before static deploy.");
}

const staticFrontendConfigAuthority = JSON.parse(fs.readFileSync("infra/terraform/app/evidence/static-frontend-config-authority.json", "utf8"));
const expectedBrowserPublicKeys = [
  "VITE_API_BASE_URL",
  "VITE_APP_ENV",
  "VITE_CONTRACT_GENERATION",
  "VITE_DEPLOYMENT_ID",
  "VITE_SESSION_CREATE_TURNSTILE_REQUIRED",
  "VITE_STH_MIN_MATCHES",
  "VITE_STH_SOURCES",
  "VITE_TURNSTILE_BYPASS",
  "VITE_TURNSTILE_SITE_KEY",
  "VITE_USE_MOCK_API",
];
if (staticFrontendConfigAuthority.authorityType !== "static-frontend-config") {
  throw new Error("Static frontend config authority has an unexpected authority type.");
}
if (JSON.stringify(staticFrontendConfigAuthority.browserPublicKeys) !== JSON.stringify(expectedBrowserPublicKeys)) {
  throw new Error("Static frontend config authority does not cover every browser-public key.");
}
if (staticFrontendConfigAuthority.browserPublicConfig?.VITE_TURNSTILE_BYPASS?.effectiveValue !== "false" ||
    staticFrontendConfigAuthority.browserPublicConfig?.VITE_USE_MOCK_API?.effectiveValue !== "false") {
  throw new Error("Terraform static deploy requires disabled browser bypass/mock flags.");
}
if (staticFrontendConfigAuthority.browserPublicConfig?.VITE_API_BASE_URL?.effectiveValue !== "same-origin") {
  throw new Error("Terraform static deploy requires same-origin browser API config.");
}
if (!staticFrontendConfigAuthority.serverRuntimeConfig?.VERIFIER_PUBLIC_BASE_URL ||
    !staticFrontendConfigAuthority.serverRuntimeConfig?.CONTRACT_GENERATION) {
  throw new Error("Static frontend config authority is missing server runtime config.");
}
const publicFrontendConfig = {
  sourceMapDisposition: "disabled",
  ...staticFrontendConfigAuthority,
};

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = dir + "/" + entry.name;
    if (entry.isDirectory()) {
      walk(full);
    } else {
      files.push(full);
    }
  }
}
walk("dist");
const hash = crypto.createHash("sha256");
for (const file of files.sort()) {
  hash.update(file.slice("dist/".length));
  hash.update(fs.readFileSync(file));
}
const artifactSha256 = hash.digest("hex");
const retainedStaticFrontend = JSON.parse(fs.readFileSync("infra/terraform/app/evidence/static-frontend-retained.json", "utf8"));
if (retainedStaticFrontend.artifactSha256 && retainedStaticFrontend.artifactSha256 !== artifactSha256) {
  throw new Error("Retained rollback static frontend content checksum does not match the selected deployment.");
}
const imageIdMappingSha256 = crypto.createHash("sha256").update(fs.readFileSync("dist/imageId-mapping.json")).digest("hex");
const staticFastMode = process.env.APP_STATIC_FAST_MODE === "true";
const staticFastGate = staticFastMode
  ? JSON.parse(fs.readFileSync("infra/terraform/app/evidence/static-fast-gate.json", "utf8"))
  : null;
const appDeploymentRecord = staticFastMode
  ? null
  : JSON.parse(fs.readFileSync("app-deployment-record.json", "utf8"));
const expectedImageIdMappingSha256 = staticFastMode
  ? staticFastGate.imageIdMappingSha256
  : appDeploymentRecord.imageIdMappingSha256;
if (
  !/^[0-9a-f]{64}$/.test(expectedImageIdMappingSha256 || "") ||
  imageIdMappingSha256 !== expectedImageIdMappingSha256
) {
  throw new Error("Static frontend ImageID mapping checksum does not match its deployment authority.");
}
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const stablePublicAssetCacheControl = "public,max-age=300";
execFileSync("aws", ["s3", "sync", "dist/", "s3://" + frontend.frontend_bucket_name + "/", "--delete", "--cache-control", "public,max-age=31536000,immutable", "--exclude", "index.html", "--exclude", "imageId-mapping.json", "--exclude", "patterns/*", "--exclude", "textures/*", "--no-cli-pager"], { stdio: "inherit" });
execFileSync("aws", ["s3", "sync", "dist/patterns/", "s3://" + frontend.frontend_bucket_name + "/patterns/", "--delete", "--cache-control", stablePublicAssetCacheControl, "--no-cli-pager"], { stdio: "inherit" });
execFileSync("aws", ["s3", "sync", "dist/textures/", "s3://" + frontend.frontend_bucket_name + "/textures/", "--delete", "--cache-control", stablePublicAssetCacheControl, "--no-cli-pager"], { stdio: "inherit" });
execFileSync("aws", ["s3", "cp", "dist/index.html", "s3://" + frontend.frontend_bucket_name + "/index.html", "--cache-control", "no-cache", "--content-type", "text/html; charset=utf-8", "--no-cli-pager"], { stdio: "inherit" });
execFileSync("aws", ["s3", "cp", "dist/imageId-mapping.json", "s3://" + frontend.frontend_bucket_name + "/imageId-mapping.json", "--cache-control", "no-cache", "--content-type", "application/json; charset=utf-8", "--no-cli-pager"], { stdio: "inherit" });
const invalidation = JSON.parse(execFileSync("aws", ["cloudfront", "create-invalidation", "--distribution-id", frontend.cloudfront_distribution_id, "--paths", "/*", "--output", "json", "--no-cli-pager"], { encoding: "utf8" }));

const publicFrontendConfigSha256 = crypto.createHash("sha256").update(canonicalJson(publicFrontendConfig)).digest("hex");
const evidence = {
  evidenceType: "static-frontend-deployment",
  deploymentId: process.env.APP_DEPLOYMENT_ID,
  sourceSha: process.env.APP_SOURCE_SHA,
  pipelineExecutionId: process.env.APP_PIPELINE_EXECUTION_ID,
  frontendBucketName: frontend.frontend_bucket_name,
  cloudfrontDistributionId: frontend.cloudfront_distribution_id,
  cloudfrontDistributionDomain: frontend.cloudfront_distribution_domain,
  operatorGateEnabled: frontend.operator_gate_enabled !== false,
  distFileCount: files.length,
  artifactSha256,
  retainedArchive: {
    bucket: retainedStaticFrontend.bucket,
    key: retainedStaticFrontend.key,
    versionId: retainedStaticFrontend.versionId,
    sha256: retainedStaticFrontend.sha256,
  },
  publicFrontendConfig,
  publicFrontendConfigSha256,
  imageIdMapping: {
    path: "public/imageId-mapping.json",
    deployedPath: "/imageId-mapping.json",
    sha256: imageIdMappingSha256,
    cacheControl: "no-cache",
  },
  stablePublicAssets: {
    paths: ["/patterns/*", "/textures/*"],
    cacheControl: stablePublicAssetCacheControl,
    cloudFrontCachePolicy: "frontend_app_shell",
  },
  invalidationId: invalidation.Invalidation && invalidation.Invalidation.Id,
};
fs.writeFileSync("infra/terraform/app/evidence/static-frontend-deploy.json", JSON.stringify(evidence, null, 2) + "\n");
NODE
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/evidence/static-frontend-deploy.json",
          "infra/terraform/app/evidence/static-frontend-retained.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
