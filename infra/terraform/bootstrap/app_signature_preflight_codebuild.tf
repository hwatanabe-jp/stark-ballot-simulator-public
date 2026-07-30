resource "aws_codebuild_project" "app_signature_state_refresh_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_state_refresh_plan_project_name
  service_role  = aws_iam_role.app_signature_preflight_plan[0].arn
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
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_signature_state_refresh_plan_project_name].name
      stream_name = "signature-state-refresh-plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      env = {
        "git-credential-helper" = "yes"
        "exported-variables" = [
          "VerifierStateRefreshRequired",
        ]
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
            <<-EOT
set -eu
case "$APP_DEPLOYMENT_MODE" in
  rollback)
    mkdir -p .tmp
    VerifierStateRefreshRequired="false"
    export VerifierStateRefreshRequired
    printf '{"disposition":"rollback-retained-authority","stateRefresh":"skipped"}\n' > .tmp/verifier-state-refresh-skipped.json
    ;;
  normal)
    test "$APP_STATE_REFRESH_SOURCE_SHA" = "$CODEBUILD_RESOLVED_SOURCE_VERSION"
    mkdir -p .tmp infra/terraform/app/evidence
    ${local.app_backend_config_command}
    ${local.app_tfvars_command}
    ${local.app_guard_init_command}
    terraform -chdir=infra/terraform/app show -json > .tmp/current-app-state.json
    node infra/terraform/bootstrap/app-signature-preflight-scripts/prepare-output-overlay.mjs .tmp/current-app-state.json infra/terraform/app/outputs.tf --state-refresh
    APP_STATE_REFRESH_STATE_PATH=.tmp/current-app-state.json APP_STATE_REFRESH_TFVARS_PATH=infra/terraform/app/pipeline.auto.tfvars node infra/terraform/bootstrap/app-signature-preflight-scripts/prepare-state-refresh-input.mjs
    ${local.app_guard_validate_command}
    ${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app plan -refresh-only -out=tfplan -var-file=pipeline.auto.tfvars -target=terraform_data.image_signature_verifier_permissions_boundary_authority -target=aws_cloudwatch_log_group.image_signature_verifier -target=aws_iam_role.image_signature_verifier -target=aws_iam_role_policy.image_signature_verifier -target=aws_lambda_function.image_signature_verifier -target=aws_lambda_alias.image_signature_verifier_preflight
    terraform -chdir=infra/terraform/app show -json tfplan > infra/terraform/app/tfplan.json
    terraform -chdir=infra/terraform/app show -no-color tfplan > infra/terraform/app/tfplan.txt
    sha256sum infra/terraform/app/tfplan > infra/terraform/app/tfplan.sha256
    VerifierStateRefreshRequired="$(node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-state-refresh-plan.mjs infra/terraform/app/tfplan.json infra/terraform/app/evidence/image-signature-state-refresh-plan.json)"
    case "$VerifierStateRefreshRequired" in true|false) ;; *) exit 1 ;; esac
    export VerifierStateRefreshRequired
    ;;
  *)
    echo "APP_DEPLOYMENT_MODE must be normal or rollback." >&2
    exit 1
    ;;
esac
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/backend.pipeline.hcl",
          "infra/terraform/app/outputs.tf",
          "infra/terraform/app/pipeline.auto.tfvars",
          "infra/terraform/app/tfplan",
          "infra/terraform/app/tfplan.json",
          "infra/terraform/app/tfplan.sha256",
          "infra/terraform/app/tfplan.txt",
          "infra/terraform/app/evidence/image-signature-state-refresh-plan.json",
          ".tmp/verifier-state-refresh-skipped.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_state_refresh_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_state_refresh_apply_project_name
  service_role  = aws_iam_role.app_signature_state_refresh_apply[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_STATE_REFRESH_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_STATE_REFRESH_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_STATE_REFRESH_PIPELINE_NAME"
      value = local.app_pipeline_name
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_signature_state_refresh_apply_project_name].name
      stream_name = "signature-state-refresh-apply"
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
            <<-EOT
set -eu
test "$APP_DEPLOYMENT_MODE" = "normal"
test "$APP_STATE_REFRESH_SOURCE_SHA" = "$CODEBUILD_RESOLVED_SOURCE_VERSION"
test -n "$CODEBUILD_SRC_DIR_VerifierStateRefreshPlanOutput"
mkdir -p infra/terraform/app/evidence .tmp/app-signature-state-refresh-apply
for path in infra/terraform/app/backend.pipeline.hcl infra/terraform/app/outputs.tf infra/terraform/app/pipeline.auto.tfvars infra/terraform/app/tfplan infra/terraform/app/tfplan.json infra/terraform/app/tfplan.sha256 infra/terraform/app/tfplan.txt infra/terraform/app/evidence/image-signature-state-refresh-plan.json; do
  cp "$CODEBUILD_SRC_DIR_VerifierStateRefreshPlanOutput/$path" "$path"
done
sha256sum -c infra/terraform/app/tfplan.sha256
aws codepipeline list-action-executions --pipeline-name "$APP_STATE_REFRESH_PIPELINE_NAME" --filter "pipelineExecutionId=$APP_STATE_REFRESH_PIPELINE_EXECUTION_ID" --region "$APP_STATE_REFRESH_REGION" --output json --no-cli-pager > .tmp/app-signature-state-refresh-apply/action-executions.json
APP_STATE_REFRESH_ACTION_EXECUTIONS_PATH=.tmp/app-signature-state-refresh-apply/action-executions.json APP_STATE_REFRESH_PLAN_CHECKSUM_PATH=infra/terraform/app/tfplan.sha256 APP_STATE_REFRESH_APPROVAL_EVIDENCE_PATH=infra/terraform/app/evidence/image-signature-state-refresh-approval.json node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-state-refresh-approval.mjs
${local.app_guard_init_command}
terraform -chdir=infra/terraform/app show -json tfplan > .tmp/app-signature-state-refresh-apply/replayed-tfplan.json
node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-state-refresh-plan.mjs .tmp/app-signature-state-refresh-apply/replayed-tfplan.json .tmp/app-signature-state-refresh-apply/revalidated-plan.json > .tmp/app-signature-state-refresh-apply/refresh-required.txt
test "$(cat .tmp/app-signature-state-refresh-apply/refresh-required.txt)" = "true"
node -e 'const fs=require("node:fs"); const a=JSON.parse(fs.readFileSync("infra/terraform/app/evidence/image-signature-state-refresh-plan.json")); const b=JSON.parse(fs.readFileSync(".tmp/app-signature-state-refresh-apply/revalidated-plan.json")); if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error("Verifier state-refresh plan allowlist changed after review.")'
${local.app_guard_apply_command}
terraform -chdir=infra/terraform/app show -json > infra/terraform/app/state-refresh-applied-state.json
node infra/terraform/bootstrap/app-signature-preflight-scripts/verify-state-refresh.mjs .tmp/app-signature-state-refresh-apply/replayed-tfplan.json infra/terraform/app/state-refresh-applied-state.json infra/terraform/app/evidence/image-signature-state-refresh-apply.json
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/evidence/image-signature-state-refresh-apply.json",
          "infra/terraform/app/evidence/image-signature-state-refresh-approval.json",
          "infra/terraform/app/evidence/image-signature-state-refresh-plan.json",
          "infra/terraform/app/state-refresh-applied-state.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_preflight_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_preflight_plan_project_name
  service_role  = aws_iam_role.app_signature_preflight_plan[0].arn
  build_timeout = 30

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_PREFLIGHT_ARTIFACT_BUCKET"
      value = local.app_pipeline_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_PREFLIGHT_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PREFLIGHT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PREFLIGHT_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_KEY"
      value = local.app_state_backend_key
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_signature_preflight_plan_project_name].name
      stream_name = "signature-preflight-plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      env = {
        "git-credential-helper" = "yes"
        "exported-variables" = [
          "ProverImageUri",
        ]
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
            <<-EOT
set -eu
case "$APP_DEPLOYMENT_MODE" in
  rollback)
    mkdir -p .tmp
    ProverImageUri="__NOT_APPLICABLE__"
    export ProverImageUri
    printf '{"disposition":"rollback-retained-authority","mutation":"skipped"}\n' > .tmp/verifier-preflight-skipped.json
    ;;
  normal)
    test "$APP_PREFLIGHT_REQUESTED_SOURCE_SHA" = "$APP_PREFLIGHT_SOURCE_SHA"
    test "$APP_PREFLIGHT_SOURCE_SHA" = "$CODEBUILD_RESOLVED_SOURCE_VERSION"
    mkdir -p infra/terraform/app/evidence
    corepack enable
    pnpm install --frozen-lockfile
    ProverImageUri="$(node infra/terraform/bootstrap/app-signature-preflight-scripts/resolve-prover-image.mjs)"
    export ProverImageUri
    node scripts/build/build-image-signature-verifier-lambda.mjs --platform linux-amd64 --output .tmp/image-signature-verifier-lambda
    ${local.app_backend_config_command}
    ${local.app_tfvars_command}
    ${local.app_guard_init_command}
    terraform -chdir=infra/terraform/app show -json > .tmp/current-app-state.json
    node infra/terraform/bootstrap/app-signature-preflight-scripts/prepare-output-overlay.mjs .tmp/current-app-state.json infra/terraform/app/outputs.tf
    APP_PREFLIGHT_PROVER_IMAGE_URI="$ProverImageUri" APP_PREFLIGHT_STATE_PATH=.tmp/current-app-state.json APP_PREFLIGHT_PACKAGE_MANIFEST_PATH=.tmp/image-signature-verifier-lambda/manifest.json APP_PREFLIGHT_PACKAGE_PATH=.tmp/image-signature-verifier-lambda/image-signature-verifier.zip APP_PREFLIGHT_TFVARS_PATH=infra/terraform/app/pipeline.auto.tfvars APP_PREFLIGHT_ARTIFACT_EVIDENCE_PATH=infra/terraform/app/evidence/image-signature-verifier-package.json node infra/terraform/bootstrap/app-signature-preflight-scripts/prepare-plan-input.mjs
    ${local.app_guard_validate_command}
    ${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app plan -out=tfplan -var-file=pipeline.auto.tfvars -target=terraform_data.image_signature_verifier_permissions_boundary_authority -target=aws_cloudwatch_log_group.image_signature_verifier -target=aws_iam_role.image_signature_verifier -target=aws_iam_role_policy.image_signature_verifier -target=aws_lambda_function.image_signature_verifier -target=aws_lambda_alias.image_signature_verifier_preflight
    terraform -chdir=infra/terraform/app show -json tfplan > infra/terraform/app/tfplan.json
    terraform -chdir=infra/terraform/app show -no-color tfplan > infra/terraform/app/tfplan.txt
    sha256sum infra/terraform/app/tfplan > infra/terraform/app/tfplan.sha256
    node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-plan.mjs infra/terraform/app/tfplan.json infra/terraform/app/evidence/image-signature-preflight-plan.json
    plan_json_sha256="$(sha256sum infra/terraform/app/tfplan.json | awk '{print $1}')"
    node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-live-baseline.mjs capture infra/terraform/app/tfplan.json "$plan_json_sha256" infra/terraform/app/evidence/image-signature-preflight-live-baseline.json
    ;;
  *)
    echo "APP_DEPLOYMENT_MODE must be normal or rollback." >&2
    exit 1
    ;;
esac
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/backend.pipeline.hcl",
          "infra/terraform/app/outputs.tf",
          "infra/terraform/app/pipeline.auto.tfvars",
          "infra/terraform/app/tfplan",
          "infra/terraform/app/tfplan.json",
          "infra/terraform/app/tfplan.sha256",
          "infra/terraform/app/tfplan.txt",
          "infra/terraform/app/evidence/image-signature-preflight-plan.json",
          "infra/terraform/app/evidence/image-signature-preflight-live-baseline.json",
          "infra/terraform/app/evidence/image-signature-verifier-package.json",
          ".tmp/verifier-preflight-skipped.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_preflight_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_preflight_apply_project_name
  service_role  = aws_iam_role.app_signature_preflight_apply[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "APP_PREFLIGHT_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PREFLIGHT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PREFLIGHT_PIPELINE_NAME"
      value = local.app_pipeline_name
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }

    environment_variable {
      name  = "APP_LIVE_BASELINE_STATE_KEY"
      value = local.app_state_backend_key
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_signature_preflight_apply_project_name].name
      stream_name = "signature-preflight-apply"
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
            <<-EOT
set -eu
case "$APP_DEPLOYMENT_MODE" in
  rollback)
    mkdir -p .tmp
    printf '{"disposition":"rollback-retained-authority","mutation":"skipped"}\n' > .tmp/verifier-preflight-apply-skipped.json
    ;;
  normal)
    test -n "$CODEBUILD_SRC_DIR_VerifierPreflightPlanOutput"
    test "$APP_PREFLIGHT_REQUESTED_SOURCE_SHA" = "$CODEBUILD_RESOLVED_SOURCE_VERSION"
    mkdir -p infra/terraform/app/evidence .tmp/app-signature-preflight-apply
    for path in infra/terraform/app/backend.pipeline.hcl infra/terraform/app/outputs.tf infra/terraform/app/pipeline.auto.tfvars infra/terraform/app/tfplan infra/terraform/app/tfplan.json infra/terraform/app/tfplan.sha256 infra/terraform/app/tfplan.txt infra/terraform/app/evidence/image-signature-preflight-plan.json infra/terraform/app/evidence/image-signature-preflight-live-baseline.json infra/terraform/app/evidence/image-signature-verifier-package.json; do
      cp "$CODEBUILD_SRC_DIR_VerifierPreflightPlanOutput/$path" "$path"
    done
    sha256sum -c infra/terraform/app/tfplan.sha256
    aws codepipeline list-action-executions --pipeline-name "$APP_PREFLIGHT_PIPELINE_NAME" --filter "pipelineExecutionId=$APP_PREFLIGHT_PIPELINE_EXECUTION_ID" --region "$APP_PREFLIGHT_REGION" --output json --no-cli-pager > .tmp/app-signature-preflight-apply/action-executions.json
    APP_PREFLIGHT_ACTION_EXECUTIONS_PATH=.tmp/app-signature-preflight-apply/action-executions.json APP_PREFLIGHT_PLAN_CHECKSUM_PATH=infra/terraform/app/tfplan.sha256 APP_PREFLIGHT_APPROVAL_EVIDENCE_PATH=infra/terraform/app/evidence/image-signature-preflight-approval.json node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-approval.mjs
    ${local.app_guard_init_command}
    terraform -chdir=infra/terraform/app show -json tfplan > .tmp/app-signature-preflight-apply/replayed-tfplan.json
    node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-plan.mjs .tmp/app-signature-preflight-apply/replayed-tfplan.json .tmp/app-signature-preflight-apply/revalidated-plan.json
    node -e 'const fs=require("node:fs"); const a=JSON.parse(fs.readFileSync("infra/terraform/app/evidence/image-signature-preflight-plan.json")); const b=JSON.parse(fs.readFileSync(".tmp/app-signature-preflight-apply/revalidated-plan.json")); if (JSON.stringify(a)!==JSON.stringify(b)) throw new Error("Verifier-only plan allowlist changed after review.")'
    plan_json_sha256="$(sha256sum .tmp/app-signature-preflight-apply/replayed-tfplan.json | awk '{print $1}')"
    node infra/terraform/bootstrap/app-signature-preflight-scripts/validate-live-baseline.mjs assert .tmp/app-signature-preflight-apply/replayed-tfplan.json "$plan_json_sha256" .tmp/app-signature-preflight-apply/current-live-baseline.json infra/terraform/app/evidence/image-signature-preflight-live-baseline.json
    ${local.app_guard_apply_command}
    terraform -chdir=infra/terraform/app output -json > infra/terraform/app/apply-outputs.json
    APP_PREFLIGHT_OUTPUTS_PATH=infra/terraform/app/apply-outputs.json APP_PREFLIGHT_ARTIFACT_EVIDENCE_PATH=infra/terraform/app/evidence/image-signature-verifier-package.json APP_PREFLIGHT_APPLY_EVIDENCE_PATH=infra/terraform/app/evidence/image-signature-preflight-apply.json node infra/terraform/bootstrap/app-signature-preflight-scripts/verify-applied-verifier.mjs
    ;;
  *)
    echo "APP_DEPLOYMENT_MODE must be normal or rollback." >&2
    exit 1
    ;;
esac
EOT
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/apply-outputs.json",
          "infra/terraform/app/evidence/image-signature-preflight-apply.json",
          "infra/terraform/app/evidence/image-signature-preflight-approval.json",
          "infra/terraform/app/evidence/image-signature-preflight-plan.json",
          "infra/terraform/app/evidence/image-signature-preflight-live-baseline.json",
          "infra/terraform/app/evidence/image-signature-verifier-package.json",
          ".tmp/verifier-preflight-apply-skipped.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

resource "aws_codebuild_project" "app_signature_preflight_invoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name          = local.app_signature_preflight_invoke_project_name
  service_role  = aws_iam_role.app_signature_preflight_invoker[0].arn
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
      name  = "APP_PREFLIGHT_ARTIFACT_BUCKET"
      value = local.app_pipeline_artifact_bucket_name
    }

    environment_variable {
      name  = "APP_PREFLIGHT_ACCOUNT_ID"
      value = var.aws_account_id
    }

    environment_variable {
      name  = "APP_PREFLIGHT_REGION"
      value = var.aws_region
    }

    environment_variable {
      name  = "APP_PREFLIGHT_ALIAS_ARN"
      value = local.app_signature_preflight_alias_arn
    }

    environment_variable {
      name  = "APP_PREFLIGHT_SIGNING_PROFILE_ARN"
      value = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-profiles/${replace(local.app_runtime_name_prefix, "-", "_")}_ecr"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_signature_preflight_invoke_project_name].name
      stream_name = "signature-preflight-invoke"
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
          commands = [
            "set -eu",
            "node --version | grep -E '^v24\\.'",
          ]
        }
        build = {
          commands = [
            <<-EOT
set -eu
case "$APP_DEPLOYMENT_MODE" in
  rollback)
    mkdir -p .tmp/app-signature-preflight
    printf '{"disposition":"rollback-retained-authority","verification":"skipped"}\n' > .tmp/app-signature-preflight/publication.json
    ;;
  normal)
    test -n "$CODEBUILD_SRC_DIR_SigApply"
    test "$APP_PREFLIGHT_REQUESTED_SOURCE_SHA" = "$APP_PREFLIGHT_SOURCE_SHA"
    test "$APP_PREFLIGHT_SOURCE_SHA" = "$CODEBUILD_RESOLVED_SOURCE_VERSION"
    APP_PREFLIGHT_APPLY_EVIDENCE_PATH="$CODEBUILD_SRC_DIR_SigApply/infra/terraform/app/evidence/image-signature-preflight-apply.json" node infra/terraform/bootstrap/app-signature-preflight-scripts/invoke-preflight.mjs
    ;;
  *)
    echo "APP_DEPLOYMENT_MODE must be normal or rollback." >&2
    exit 1
    ;;
esac
EOT
          ]
        }
      }
      artifacts = {
        files = [
          ".tmp/app-signature-preflight/publication.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
