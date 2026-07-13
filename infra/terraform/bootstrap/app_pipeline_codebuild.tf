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
APP_PIPELINE_ARTIFACT_BUCKET="${local.app_pipeline_artifact_bucket_name}" APP_EXPECTED_AWS_ACCOUNT_ID="${var.aws_account_id}" APP_EXPECTED_AWS_REGION="${var.aws_region}" APP_EXPECTED_DEPLOYMENT_ENVIRONMENT="${var.deployment_environment}" infra/terraform/bootstrap/app-pipeline-scripts/app-deployment-selection.sh
export DeploymentMode="$APP_DEPLOYMENT_MODE"
AppDeploymentRecordSha256="$(node -e 'const fs=require("node:fs"); const e=JSON.parse(fs.readFileSync("infra/terraform/app/evidence/app-deployment-record-generation.json","utf8")); process.stdout.write(e.appDeploymentRecordSha256)')"
export AppDeploymentRecordSha256
AppSourceSha="$(node -e 'const fs=require("node:fs"); const e=JSON.parse(fs.readFileSync("infra/terraform/app/evidence/app-deployment-record-generation.json","utf8")); process.stdout.write(e.appSourceSha)')"
export AppSourceSha
cat infra/terraform/app/evidence/app-deployment-record-generation.json
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "app-deployment-record.json",
          "app-deployment-selection-input.json",
          "selected-deployment-record.json",
          "rollback-selection.json",
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
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
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/selected-deployment-record.json selected-deployment-record.json",
            "cp \"$CODEBUILD_SRC_DIR_AppDeploymentRecordOutput\"/rollback-selection.json rollback-selection.json",
            local.app_source_preflight_command,
            <<-EOT
set -eu
RUN_FULL_VALIDATE_SUITE=true
if aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "accepted-deployments/stark-dev/develop/app/index.json" accepted-index-existing.json --output json --no-cli-pager > accepted-index-existing.get-object.json 2> accepted-index-existing.error; then
  if node <<'NODE' > accepted-source-sha.txt
const fs = require("node:fs");
const index = JSON.parse(fs.readFileSync("accepted-index-existing.json", "utf8"));
const deployments = Array.isArray(index.acceptedDeployments) ? index.acceptedDeployments : [];
const latest = deployments.find((deployment) => deployment && typeof deployment.sourceSha === "string");
if (!latest) {
  throw new Error("Accepted deployment marker has no sourceSha.");
}
process.stdout.write(latest.sourceSha + "\n");
NODE
  then
    accepted_source_sha="$(cat accepted-source-sha.txt)"
    if git rev-parse --verify "$accepted_source_sha^{commit}" >/dev/null 2>&1 &&
       git rev-parse --verify "$CODEBUILD_RESOLVED_SOURCE_VERSION^{commit}" >/dev/null 2>&1 &&
       git merge-base --is-ancestor "$accepted_source_sha" "$CODEBUILD_RESOLVED_SOURCE_VERSION"; then
      git diff --name-status --no-renames -z "$accepted_source_sha" "$CODEBUILD_RESOLVED_SOURCE_VERSION" > app-validate-source-diff.z
      RUN_FULL_VALIDATE_SUITE="$(node <<'NODE'
const fs = require("node:fs");
const entries = fs.readFileSync("app-validate-source-diff.z", "utf8").split("\0").filter(Boolean);
const paths = [];
for (let index = 0; index < entries.length;) {
  const status = entries[index++] || "";
  const path = entries[index++];
  if (path) {
    paths.push(path);
  }
  if (/^[RC]/.test(status)) {
    const newPath = entries[index++];
    if (newPath) {
      paths.push(newPath);
    }
  }
}
const triggerPrefixes = ["apps/api/", "packages/", "zkvm/", "infra/lambdas/"];
process.stdout.write(paths.some((path) => triggerPrefixes.some((prefix) => path.startsWith(prefix))) ? "true" : "false");
NODE
)"
    else
      echo "Accepted deployment source is not an ancestor of the current source, or a source SHA is unavailable; running full validate suite." >&2
      RUN_FULL_VALIDATE_SUITE=true
    fi
  else
    echo "Accepted deployment marker is empty or unreadable; running full validate suite." >&2
    RUN_FULL_VALIDATE_SUITE=true
  fi
else
  echo "Unable to verify accepted deployment marker; running full validate suite." >&2
  RUN_FULL_VALIDATE_SUITE=true
fi
if [ "$RUN_FULL_VALIDATE_SUITE" = "true" ]; then
  pnpm test:run
else
  echo "Skipping pnpm test:run because the diff does not touch apps/api/**, packages/**, zkvm/**, or infra/lambdas/**."
fi
EOT
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
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
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
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      env = {
        "git-credential-helper" = "yes"
        "exported-variables"    = ["PLAN_EMPTY", "APPROVAL_REQUIRED"]
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
            "test -n \"$CODEBUILD_SRC_DIR_ValidateOutput\"",
            "mkdir -p infra/terraform/app/evidence",
            "for path in app-deployment-record.json selected-deployment-record.json rollback-selection.json infra/terraform/app/evidence/app-deployment-record-generation.json infra/terraform/app/evidence/source-preflight.json; do cp \"$CODEBUILD_SRC_DIR_ValidateOutput/$path\" \"$path\"; done",
            local.app_backend_config_command,
            local.app_tfvars_command,
            "node --version | grep -E '^v24\\.'",
            "corepack enable",
            "pnpm install --frozen-lockfile",
            local.app_recovery_prepare_command,
            local.app_target_lambda_artifacts_command,
            local.app_guard_init_command,
            local.app_guard_validate_command,
            "mkdir -p infra/terraform/app/evidence",
            "terraform -chdir=infra/terraform/app version -json > infra/terraform/app/evidence/terraform-version.json",
            "terraform -chdir=infra/terraform/app providers > infra/terraform/app/evidence/terraform-providers.txt",
            local.app_guard_plan_command,
            "terraform -chdir=infra/terraform/app show -no-color tfplan > infra/terraform/app/tfplan.txt",
            "terraform -chdir=infra/terraform/app show -json tfplan > infra/terraform/app/tfplan.json",
            <<-EOT
            export PLAN_EMPTY=false
            PLAN_EMPTY="$(node <<'NODE'
            const fs = require("node:fs");
            let planEmpty = false;
            let resourceChangeCount = 0;
            let outputChangeCount = 0;
            let movedResourceChangeCount = 0;
            let importingResourceChangeCount = 0;
            try {
              const plan = JSON.parse(fs.readFileSync("infra/terraform/app/tfplan.json", "utf8"));
              const resourceChanges = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
              resourceChangeCount = resourceChanges.filter((change) => {
                const actions = change?.change?.actions;
                return !(Array.isArray(actions) && actions.length === 1 && actions[0] === "no-op");
              }).length;
              movedResourceChangeCount = resourceChanges.filter((change) => typeof change?.previous_address === "string").length;
              importingResourceChangeCount = resourceChanges.filter((change) => change?.importing !== undefined).length;
              const outputChanges = plan.output_changes && typeof plan.output_changes === "object" ? Object.values(plan.output_changes) : [];
              outputChangeCount = outputChanges.filter((change) => {
                const actions = change?.actions;
                return !(Array.isArray(actions) && actions.length === 1 && actions[0] === "no-op");
              }).length;
              planEmpty =
                resourceChangeCount === 0 &&
                outputChangeCount === 0 &&
                movedResourceChangeCount === 0 &&
                importingResourceChangeCount === 0;
            } catch (error) {
              planEmpty = false;
              resourceChangeCount = -1;
              outputChangeCount = -1;
              movedResourceChangeCount = -1;
              importingResourceChangeCount = -1;
            }
            fs.writeFileSync(
              "infra/terraform/app/evidence/app-plan-empty.json",
              JSON.stringify(
                {
                  schemaVersion: "app-plan-empty-v1",
                  deploymentMode: process.env.APP_DEPLOYMENT_MODE || "",
                  controlSourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || "",
                  selectedSourceSha: process.env.APP_SOURCE_SHA || "",
                  planEmpty,
                  resourceChangeCount,
                  outputChangeCount,
                  movedResourceChangeCount,
                  importingResourceChangeCount,
                },
                null,
                2,
              ) + "\n",
            );
            process.stdout.write(planEmpty ? "true" : "false");
            NODE
            )"
            export PLAN_EMPTY
            export APPROVAL_REQUIRED=true
            if [ "$APP_DEPLOYMENT_MODE" = "normal" ] && [ "$PLAN_EMPTY" = "true" ]; then
              APPROVAL_REQUIRED=false
            fi
            export APPROVAL_REQUIRED
            EOT
            ,
            "sha256sum infra/terraform/app/tfplan > infra/terraform/app/tfplan.sha256",
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
          "infra/terraform/app/.terraform.lock.hcl",
          "infra/terraform/app/tfplan",
          "infra/terraform/app/tfplan.txt",
          "infra/terraform/app/tfplan.json",
          "infra/terraform/app/tfplan.sha256",
          "infra/terraform/app/pipeline.auto.tfvars",
          "infra/terraform/app/dynamodb-recovery.auto.tfvars.json",
          "app-deployment-record.json",
          "selected-deployment-record.json",
          "rollback-selection.json",
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
          "infra/terraform/app/evidence/dynamodb-recovery-selection.json",
          "infra/terraform/app/evidence/source-preflight.json",
          "infra/terraform/app/evidence/target-lambda-artifacts.json",
          "infra/terraform/app/evidence/app-plan-empty.json",
          "infra/terraform/app/evidence/terraform-version.json",
          "infra/terraform/app/evidence/terraform-providers.txt",
        ]
      }
    })
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
            "for path in app-deployment-record.json selected-deployment-record.json rollback-selection.json infra/terraform/app/tfplan infra/terraform/app/tfplan.sha256 infra/terraform/app/pipeline.auto.tfvars infra/terraform/app/dynamodb-recovery.auto.tfvars.json infra/terraform/app/evidence/app-deployment-record-generation.json infra/terraform/app/evidence/dynamodb-recovery-selection.json infra/terraform/app/evidence/source-preflight.json infra/terraform/app/evidence/target-lambda-artifacts.json infra/terraform/app/evidence/app-plan-empty.json; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
            "sha256sum -c infra/terraform/app/tfplan.sha256",
            "corepack enable",
            "pnpm install --frozen-lockfile",
            local.app_source_preflight_command,
            local.app_recovery_prepare_command,
            local.app_backend_config_command,
            local.app_guard_init_command,
            "APP_PIPELINE_NAME=${local.app_pipeline_name} APP_PIPELINE_EXECUTION_ID=\"$APP_PIPELINE_EXECUTION_ID\" APP_DEPLOYMENT_MODE=\"$APP_DEPLOYMENT_MODE\" APP_EXPECTED_CONTROL_SOURCE_SHA=\"$CODEBUILD_RESOLVED_SOURCE_VERSION\" APP_EXPECTED_SELECTED_SOURCE_SHA=\"$APP_SOURCE_SHA\" APP_EXPECTED_ACCOUNT_ID=${var.aws_account_id} APP_DEPLOYMENT_ENVIRONMENT=${var.deployment_environment} APP_TFPLAN_SHA256_PATH=infra/terraform/app/tfplan.sha256 APP_PLAN_EMPTY_EVIDENCE_PATH=infra/terraform/app/evidence/app-plan-empty.json APP_APPROVAL_EVIDENCE_PATH=infra/terraform/app/evidence/approval-evidence.json APP_APPROVAL_PUBLICATION_PATH=infra/terraform/app/evidence/approval-evidence-publication.json APP_PIPELINE_ARTIFACT_BUCKET=${local.app_pipeline_artifact_bucket_name} APP_APPROVAL_EVIDENCE_KEY_PREFIX=approval-evidence infra/terraform/bootstrap/app-pipeline-scripts/app-approval-evidence.sh",
            local.app_guard_apply_command,
            "terraform -chdir=infra/terraform/app output -json > infra/terraform/app/apply-outputs.json",
          ]
        }
      }
      artifacts = {
        files = [
          "app-deployment-record.json",
          "selected-deployment-record.json",
          "rollback-selection.json",
          "infra/terraform/app/apply-outputs.json",
          "infra/terraform/app/evidence/app-deployment-record-generation.json",
          "infra/terraform/app/evidence/dynamodb-recovery-selection.json",
          "infra/terraform/app/evidence/source-preflight.json",
          "infra/terraform/app/evidence/target-lambda-artifacts.json",
          "infra/terraform/app/evidence/approval-evidence.json",
          "infra/terraform/app/evidence/approval-evidence-publication.json",
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
          "for path in app-deployment-record.json selected-deployment-record.json rollback-selection.json; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
          "for path in infra/terraform/app/tfplan infra/terraform/app/tfplan.sha256 infra/terraform/app/tfplan.txt infra/terraform/app/tfplan.json infra/terraform/app/evidence/app-deployment-record-generation.json infra/terraform/app/evidence/dynamodb-recovery-selection.json infra/terraform/app/evidence/source-preflight.json infra/terraform/app/evidence/target-lambda-artifacts.json infra/terraform/app/evidence/app-plan-empty.json infra/terraform/app/evidence/terraform-version.json infra/terraform/app/evidence/terraform-providers.txt; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/apply-outputs.json infra/terraform/app/apply-outputs.json",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/evidence/approval-evidence.json infra/terraform/app/evidence/approval-evidence.json",
          "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/evidence/approval-evidence-publication.json infra/terraform/app/evidence/approval-evidence-publication.json",
          "cp \"$CODEBUILD_SRC_DIR_StaticDeployOutput\"/infra/terraform/app/evidence/static-frontend-deploy.json infra/terraform/app/evidence/static-frontend-deploy.json",
          "aws sts get-caller-identity --output json --no-cli-pager > app-smoke-caller.json",
          local.app_guard_smoke_command,
          local.app_no_runtime_source_check_command,
          local.app_smoke_operator_gate_keyset_command,
          local.app_smoke_dynamodb_data_plane_command,
          local.app_smoke_dynamodb_recovery_phase_command,
          local.app_smoke_denial_checks_command,
          local.app_fetch_existing_acceptance_index_command,
          "bash infra/terraform/bootstrap/app-pipeline-scripts/app-smoke-report.sh",
          local.app_acceptance_publish_command,
        ]
      }
    }
    artifacts = {
      files = [
        "app-smoke-terraform-files.txt",
        "app-smoke-declared-blocks.txt",
        "app-smoke-state-denial-simulation.json",
        "app-smoke-mutation-denial-simulation.json",
        "app-smoke-denial-evidence.json",
        "app-smoke-operator-gate-keyset-evidence.json",
        "app-smoke-dynamodb-data-plane-evidence.json",
        "app-smoke-dynamodb-recovery-phase-evidence.json",
        "app-smoke-caller.json",
        "app-smoke-report.json",
        "infra/terraform/app/evidence/static-frontend-deploy.json",
        "${local.app_accepted_marker_path}/index.json",
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
      name  = "APP_AWS_REGION"
      value = var.aws_region
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
      value = tostring(var.app_pipeline_artifact_retention_days)
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
            "if [ \"$APP_DEPLOYMENT_MODE\" = rollback ]; then cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/selected-deployment-record.json selected-deployment-record.json; else printf '{}\\n' > selected-deployment-record.json; fi",
            <<-EOT
set -eu
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const staticFastMode = process.env.APP_STATIC_FAST_MODE === "true";
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
    gate.schemaVersion !== "app-static-fast-gate-v1" ||
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
    appDeploymentRecord.schemaVersion !== "develop-app-deployment-record-v1" ||
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
static_archive_key="static-frontend-artifacts/$APP_SOURCE_SHA/dist.tar.gz"
set +e
aws s3api put-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_archive_key" --body .tmp/static-frontend-dist.tar.gz --metadata "sourceSha=$APP_SOURCE_SHA" --if-none-match '*' --expected-bucket-owner "${var.aws_account_id}" --output json --no-cli-pager > .tmp/static-frontend-dist.put-object.json 2> .tmp/static-frontend-dist.put-object.error
static_put_status=$?
set -e
if [ "$static_put_status" -ne 0 ]; then
  grep -Eq 'PreconditionFailed|412' .tmp/static-frontend-dist.put-object.error || { sed -n '1,120p' .tmp/static-frontend-dist.put-object.error >&2; exit "$static_put_status"; }
  aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_archive_key" --expected-bucket-owner "${var.aws_account_id}" .tmp/static-frontend-dist.existing.tar.gz --output json --no-cli-pager > .tmp/static-frontend-dist.existing.get-object.json
  cmp .tmp/static-frontend-dist.tar.gz .tmp/static-frontend-dist.existing.tar.gz || { echo "Retained static frontend archive differs for the same source SHA." >&2; exit 1; }
  aws s3api head-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$static_archive_key" --expected-bucket-owner "${var.aws_account_id}" --output json --no-cli-pager > .tmp/static-frontend-dist.put-object.json
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
  "VITE_SESSION_CREATE_TURNSTILE_REQUIRED",
  "VITE_STH_MIN_MATCHES",
  "VITE_STH_SOURCES",
  "VITE_TURNSTILE_BYPASS",
  "VITE_TURNSTILE_SITE_KEY",
  "VITE_USE_MOCK_API",
];
if (staticFrontendConfigAuthority.schemaVersion !== "develop-static-frontend-config-authority-v1") {
  throw new Error("Static frontend config authority has an unexpected schema version.");
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
  schemaVersion: "static-frontend-deploy-v1",
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
