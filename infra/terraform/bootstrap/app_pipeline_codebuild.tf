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
          "ReleaseManifestKey",
          "ReleaseManifestVersionId",
          "ReleaseManifestSha256",
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
test -n "$APP_RELEASE_MANIFEST_BUCKET"
test -n "$APP_RELEASE_MANIFEST_KEY"
test -n "$APP_RELEASE_MANIFEST_VERSION_ID"
test -n "$APP_RELEASE_MANIFEST_SHA256"
mkdir -p .tmp infra/terraform/app/evidence
aws s3api get-object --bucket "$APP_RELEASE_MANIFEST_BUCKET" --key "$APP_RELEASE_MANIFEST_KEY" --version-id "$APP_RELEASE_MANIFEST_VERSION_ID" transitional-release-manifest.json --output json --no-cli-pager > transitional-release-manifest.get-object.json
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const actual = crypto.createHash("sha256").update(fs.readFileSync("transitional-release-manifest.json")).digest("hex");
if (actual !== process.env.APP_RELEASE_MANIFEST_SHA256) {
  throw new Error("Transitional release manifest SHA-256 does not match the supplied sidecar.");
}
NODE
aws s3api get-object --bucket "$APP_RELEASE_MANIFEST_BUCKET" --key channels/develop/toolchain/accepted.json accepted-toolchain-pointer.json --output json --no-cli-pager > accepted-toolchain-pointer.get-object.json
aws s3api get-object --bucket "$APP_RELEASE_MANIFEST_BUCKET" --key channels/develop/prover/accepted.json accepted-prover-pointer.json --output json --no-cli-pager > accepted-prover-pointer.get-object.json
node <<'NODE' > .tmp/release-authority.env
const crypto = require("node:crypto");
const fs = require("node:fs");
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function emit(name, value) {
  console.log(name + "=" + shellQuote(value));
}
function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
const toolchainPointer = JSON.parse(fs.readFileSync("accepted-toolchain-pointer.json", "utf8"));
const toolchainPointerGet = JSON.parse(fs.readFileSync("accepted-toolchain-pointer.get-object.json", "utf8"));
const proverPointer = JSON.parse(fs.readFileSync("accepted-prover-pointer.json", "utf8"));
const proverPointerGet = JSON.parse(fs.readFileSync("accepted-prover-pointer.get-object.json", "utf8"));
if (toolchainPointer.schemaVersion !== "develop-toolchain-accepted-pointer-v1") {
  throw new Error("Accepted toolchain pointer schema is invalid.");
}
if (proverPointer.schemaVersion !== "develop-prover-accepted-pointer-v1") {
  throw new Error("Accepted prover pointer schema is invalid.");
}
emit("toolchain_artifact_key", toolchainPointer.artifactRecordKey);
emit("toolchain_artifact_version_id", toolchainPointer.artifactRecordVersionId);
emit("toolchain_artifact_sha256", toolchainPointer.artifactRecordSha256);
emit("toolchain_pointer_version_id", toolchainPointerGet.VersionId);
emit("toolchain_pointer_sha256", sha256("accepted-toolchain-pointer.json"));
emit("prover_release_key", proverPointer.releaseRecordKey);
emit("prover_release_version_id", proverPointer.releaseRecordVersionId);
emit("prover_release_sha256", proverPointer.releaseRecordSha256);
emit("prover_pointer_version_id", proverPointerGet.VersionId);
emit("prover_pointer_sha256", sha256("accepted-prover-pointer.json"));
NODE
set -a
. .tmp/release-authority.env
set +a
aws s3api get-object --bucket "$APP_RELEASE_MANIFEST_BUCKET" --key "$toolchain_artifact_key" --version-id "$toolchain_artifact_version_id" toolchain-artifact-record.json --output json --no-cli-pager > toolchain-artifact-record.get-object.json
aws s3api get-object --bucket "$APP_RELEASE_MANIFEST_BUCKET" --key "$prover_release_key" --version-id "$prover_release_version_id" prover-release-record.json --output json --no-cli-pager > prover-release-record.get-object.json
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
const sourceSha = process.env.CODEBUILD_RESOLVED_SOURCE_VERSION;
if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sourceSha || "")) {
  throw new Error("CODEBUILD_RESOLVED_SOURCE_VERSION must be a Git SHA.");
}
if (sha256("toolchain-artifact-record.json") !== process.env.toolchain_artifact_sha256) {
  throw new Error("toolchain artifact record body hash does not match the accepted pointer.");
}
if (sha256("prover-release-record.json") !== process.env.prover_release_sha256) {
  throw new Error("prover release record body hash does not match the accepted pointer.");
}
const bridge = JSON.parse(fs.readFileSync("transitional-release-manifest.json", "utf8"));
const provenance = bridge.provenance || {};
const input = {
  schemaVersion: "develop-app-deployment-selection-input-v1",
  appSourceSha: sourceSha,
  finalIntegrationEvidenceId: bridge.finalIntegrationEvidenceId || provenance.exactSourceCiEvidenceId || "pipeline/app-deployment-record/" + sourceSha,
  bootstrapBaselineRerunEvidenceId: bridge.bootstrapBaselineRerunEvidenceId || provenance.bootstrapNoChangeBaselineEvidenceId,
  selectedProverSelector: "accepted",
  toolchainArtifactRecord: JSON.parse(fs.readFileSync("toolchain-artifact-record.json", "utf8")),
  toolchainArtifactRecordRef: {
    key: process.env.toolchain_artifact_key,
    versionId: process.env.toolchain_artifact_version_id,
    sha256: process.env.toolchain_artifact_sha256,
  },
  acceptedToolchainPointer: JSON.parse(fs.readFileSync("accepted-toolchain-pointer.json", "utf8")),
  acceptedToolchainPointerRef: {
    key: "channels/develop/toolchain/accepted.json",
    versionId: process.env.toolchain_pointer_version_id,
    sha256: process.env.toolchain_pointer_sha256,
  },
  proverReleaseRecord: JSON.parse(fs.readFileSync("prover-release-record.json", "utf8")),
  proverReleaseRecordRef: {
    key: process.env.prover_release_key,
    versionId: process.env.prover_release_version_id,
    sha256: process.env.prover_release_sha256,
  },
  acceptedProverPointer: JSON.parse(fs.readFileSync("accepted-prover-pointer.json", "utf8")),
  acceptedProverPointerRef: {
    key: "channels/develop/prover/accepted.json",
    versionId: process.env.prover_pointer_version_id,
    sha256: process.env.prover_pointer_sha256,
  },
  compatibility: {
    temporaryRiskDecision: provenance.zkvmCompatibilityEvidenceId || "compatibility/temporary-risk/" + sourceSha,
  },
  foundation: {
    proverSubnetIds: bridge.proverSubnetIds,
    proverSecurityGroupIds: bridge.proverSecurityGroupIds,
    runtimeReferencesEvidenceId: provenance.foundationRuntimeReferencesEvidenceId,
    dnsAcmDispositionEvidenceId: provenance.dnsAcmDispositionEvidenceId,
    bootstrapNoChangeBaselineEvidenceId: provenance.bootstrapNoChangeBaselineEvidenceId,
    targetAwsAccountAlias: provenance.targetAwsAccountAlias,
    targetAwsRegion: provenance.targetAwsRegion,
    deploymentEnvironment: provenance.deploymentEnvironment,
    foundationStateIdentity: provenance.foundationStateIdentity,
  },
  appDeploymentRecord: {
    key: "deployments/develop/" + sourceSha + ".json",
    schemaVersion: "develop-app-deployment-record-v1",
  },
  releaseManifest: {
    key: "release-candidates/develop/" + sourceSha + "/release-manifest.json",
    privateManifestLocator: provenance.privateManifestLocator,
  },
};
fs.writeFileSync("app-deployment-selection-input.json", JSON.stringify(input, null, 2) + "\n");
NODE
pnpm aws:app-deployment-record:generate:develop -- --input app-deployment-selection-input.json --write-app-deployment-record app-deployment-record.json --write-release-manifest release-manifest.json
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const generatedSha256 = crypto.createHash("sha256").update(fs.readFileSync("release-manifest.json")).digest("hex");
if (generatedSha256 !== process.env.APP_RELEASE_MANIFEST_SHA256) {
  throw new Error("Generated release manifest bridge does not match the supplied transitional manifest.");
}
NODE
app_record_key="deployments/develop/$CODEBUILD_RESOLVED_SOURCE_VERSION.json"
APP_DEPLOYMENT_RECORD_KEY="$app_record_key" APP_DEPLOYMENT_RECORD_BODY=app-deployment-record.json APP_DEPLOYMENT_RECORD_PUT_OUTPUT=put-app-deployment-record.json infra/terraform/bootstrap/app-pipeline-scripts/app-deployment-record-put.sh
export ReleaseManifestKey="$APP_RELEASE_MANIFEST_KEY"
ReleaseManifestVersionId="$APP_RELEASE_MANIFEST_VERSION_ID"
export ReleaseManifestVersionId
ReleaseManifestSha256="$APP_RELEASE_MANIFEST_SHA256"
export ReleaseManifestSha256
node <<'NODE'
const fs = require("node:fs");
const appPut = JSON.parse(fs.readFileSync("put-app-deployment-record.json", "utf8"));
const evidence = {
  schemaVersion: "app-deployment-record-generation-v1",
  appDeploymentRecordKey: "deployments/develop/" + process.env.CODEBUILD_RESOLVED_SOURCE_VERSION + ".json",
  appDeploymentRecordVersionId: appPut.VersionId,
  releaseManifestKey: process.env.ReleaseManifestKey,
  releaseManifestVersionId: process.env.ReleaseManifestVersionId,
  releaseManifestSha256: process.env.ReleaseManifestSha256,
  sourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION,
};
if (!evidence.appDeploymentRecordVersionId || !evidence.releaseManifestVersionId || !evidence.releaseManifestSha256) {
  throw new Error("Generated app deployment record publication and manifest sidecars must be complete.");
}
fs.writeFileSync("infra/terraform/app/evidence/app-deployment-record-generation.json", JSON.stringify(evidence, null, 2) + "\n");
NODE
cat infra/terraform/app/evidence/app-deployment-record-generation.json
EOT,
          ]
        }
      }
      artifacts = {
        files = [
          "app-deployment-record.json",
          "release-manifest.json",
          "app-deployment-selection-input.json",
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
            local.app_source_preflight_command,
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
EOT,
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
        "exported-variables" = ["PLAN_EMPTY"]
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
            "cp \"$CODEBUILD_SRC_DIR_ValidateOutput\"/infra/terraform/app/evidence/source-preflight.json infra/terraform/app/evidence/source-preflight.json",
            local.app_backend_config_command,
            local.app_tfvars_command,
            "node --version | grep -E '^v24\\.'",
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
                  sourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || "",
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
            EOT,
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
          "infra/terraform/app/tfplan",
          "infra/terraform/app/tfplan.txt",
          "infra/terraform/app/tfplan.json",
          "infra/terraform/app/tfplan.sha256",
          "infra/terraform/app/pipeline.auto.tfvars",
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
            "for path in infra/terraform/app/tfplan infra/terraform/app/tfplan.sha256 infra/terraform/app/pipeline.auto.tfvars infra/terraform/app/evidence/source-preflight.json; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
            "sha256sum -c infra/terraform/app/tfplan.sha256",
            local.app_source_preflight_command,
            local.app_backend_config_command,
            local.app_guard_init_command,
            local.app_guard_apply_command,
            "terraform -chdir=infra/terraform/app output -json > infra/terraform/app/apply-outputs.json",
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/app/apply-outputs.json",
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
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
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_PlanOutput\"",
            "test -n \"$CODEBUILD_SRC_DIR_ApplyOutput\"",
            "test -n \"$CODEBUILD_SRC_DIR_StaticDeployOutput\"",
            "mkdir -p infra/terraform/app/evidence",
            "for path in infra/terraform/app/tfplan infra/terraform/app/tfplan.sha256 infra/terraform/app/tfplan.txt infra/terraform/app/tfplan.json infra/terraform/app/evidence/source-preflight.json infra/terraform/app/evidence/target-lambda-artifacts.json infra/terraform/app/evidence/app-plan-empty.json infra/terraform/app/evidence/terraform-version.json infra/terraform/app/evidence/terraform-providers.txt; do cp \"$CODEBUILD_SRC_DIR_PlanOutput/$path\" \"$path\"; done",
            "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/apply-outputs.json infra/terraform/app/apply-outputs.json",
            "cp \"$CODEBUILD_SRC_DIR_StaticDeployOutput\"/infra/terraform/app/evidence/static-frontend-deploy.json infra/terraform/app/evidence/static-frontend-deploy.json",
            "aws sts get-caller-identity --output json --no-cli-pager > app-smoke-caller.json",
            local.app_guard_smoke_command,
            local.app_no_runtime_source_check_command,
            local.app_smoke_dynamodb_data_plane_command,
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
          "app-smoke-dynamodb-data-plane-evidence.json",
          "app-smoke-caller.json",
          "app-smoke-report.json",
          "infra/terraform/app/evidence/static-frontend-deploy.json",
          "${local.app_accepted_marker_path}/index.json",
          "${local.app_accepted_marker_path}/**/*",
        ]
      }
    })
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
            "pnpm install --frozen-lockfile",
          ]
        }
        build = {
          commands = [
            "test -n \"$CODEBUILD_SRC_DIR_ApplyOutput\"",
            "mkdir -p infra/terraform/app/evidence",
            "cp \"$CODEBUILD_SRC_DIR_ApplyOutput\"/infra/terraform/app/apply-outputs.json infra/terraform/app/apply-outputs.json",
            <<-EOT
set -eu
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
rm -f .tmp/static-frontend-config.env

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
const imageIdMappingSha256 = crypto.createHash("sha256").update(fs.readFileSync("public/imageId-mapping.json")).digest("hex");
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
  sourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION,
  pipelineExecutionId: process.env.APP_PIPELINE_EXECUTION_ID,
  frontendBucketName: frontend.frontend_bucket_name,
  cloudfrontDistributionId: frontend.cloudfront_distribution_id,
  cloudfrontDistributionDomain: frontend.cloudfront_distribution_domain,
  operatorGateEnabled: frontend.operator_gate_enabled !== false,
  distFileCount: files.length,
  artifactSha256,
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
        ]
      }
    })
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
