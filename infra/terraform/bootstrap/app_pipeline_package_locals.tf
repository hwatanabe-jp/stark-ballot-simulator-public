locals {
  app_codebuild_source_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_DEPLOYMENT_RECORD_KEY"
      value = "#{variables.SelectedDeploymentRecordKey}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_DEPLOYMENT_RECORD_VERSION_ID"
      value = "#{variables.SelectedDeploymentRecordVersionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_DEPLOYMENT_RECORD_SHA256"
      value = "#{variables.SelectedDeploymentRecordSha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
  ])
  app_codebuild_deployment_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{AppDeploymentRecord.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DYNAMODB_RECOVERY_PHASE"
      value = "#{variables.DynamoDbRecoveryPhase}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DEPLOYMENT_RECORD_SHA256"
      value = "#{AppDeploymentRecord.AppDeploymentRecordSha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SOURCE_SHA"
      value = "#{AppDeploymentRecord.AppSourceSha}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_STATIC_FAST_MODE"
      value = "false"
      type  = "PLAINTEXT"
    },
  ])
  app_codebuild_plan_env_variables = jsonencode(concat(
    jsondecode(local.app_codebuild_deployment_env_variables),
    [
      {
        name  = "DynamoDbRecoveryManifestKey"
        value = "#{variables.DynamoDbRecoveryManifestKey}"
        type  = "PLAINTEXT"
      },
      {
        name  = "DynamoDbRecoveryManifestVersionId"
        value = "#{variables.DynamoDbRecoveryManifestVersionId}"
        type  = "PLAINTEXT"
      },
      {
        name  = "DynamoDbRecoveryManifestSha256"
        value = "#{variables.DynamoDbRecoveryManifestSha256}"
        type  = "PLAINTEXT"
      },
    ],
  ))
  app_source_preflight_command        = "APP_DEPLOYMENT_RECORD_PATH=app-deployment-record.json APP_AWS_ACCOUNT_ID=${var.aws_account_id} APP_AWS_REGION=${var.aws_region} APP_SOURCE_BRANCH=${var.source_branch} APP_SOURCE_REPOSITORY=${var.github_full_repository_id} APP_PIPELINE_NAME=${local.app_pipeline_name} node scripts/aws/write-app-source-preflight.mjs"
  app_recovery_prepare_command        = <<-EOT
	set -eu
	recovery_tfvars="infra/terraform/app/dynamodb-recovery.auto.tfvars.json"
	recovery_candidate=".tmp/dynamodb-recovery.revalidated.auto.tfvars.json"
	recovery_evidence="infra/terraform/app/evidence/dynamodb-recovery-selection.json"
	recovery_evidence_candidate=".tmp/dynamodb-recovery-selection.revalidated.json"
	mkdir -p .tmp infra/terraform/app/evidence
	case "$APP_DYNAMODB_RECOVERY_PHASE" in
	  primary_active|primary_quiesced|replacement_quiesced|replacement_active) ;;
	  *) echo "DynamoDB recovery phase is invalid." >&2; exit 1 ;;
	esac
	if [ "$DynamoDbRecoveryManifestKey" = "__DISABLED__" ] && [ "$DynamoDbRecoveryManifestVersionId" = "__DISABLED__" ] && [ "$DynamoDbRecoveryManifestSha256" = "__DISABLED__" ]; then
	  test "$APP_DYNAMODB_RECOVERY_PHASE" = "primary_active" || { echo "DynamoDB recovery transition phases require an exact recovery manifest." >&2; exit 1; }
	  printf '{"dynamodb_recovery_activation":null}\n' > "$recovery_candidate"
	elif [ "$DynamoDbRecoveryManifestKey" = "__DISABLED__" ] || [ "$DynamoDbRecoveryManifestVersionId" = "__DISABLED__" ] || [ "$DynamoDbRecoveryManifestSha256" = "__DISABLED__" ]; then
	  echo "DynamoDB recovery coordinates must all be enabled or all be disabled." >&2
	  exit 1
	else
	  test "$APP_DYNAMODB_RECOVERY_PHASE" != "primary_active" || { echo "primary_active must not select a DynamoDB recovery manifest." >&2; exit 1; }
	  aws s3api get-object --bucket "${local.app_pipeline_artifact_bucket_name}" --key "$DynamoDbRecoveryManifestKey" --version-id "$DynamoDbRecoveryManifestVersionId" --expected-bucket-owner "${var.aws_account_id}" .tmp/dynamodb-recovery-activation.json --output json --no-cli-pager > .tmp/dynamodb-recovery-activation.get-object.json
	  DYNAMODB_RECOVERY_GET_OBJECT_PATH=.tmp/dynamodb-recovery-activation.get-object.json DYNAMODB_RECOVERY_EXPECTED_VERSION_ID="$DynamoDbRecoveryManifestVersionId" node <<'NODE'
	const fs = require("node:fs");
	const response = JSON.parse(fs.readFileSync(process.env.DYNAMODB_RECOVERY_GET_OBJECT_PATH, "utf8"));
	if (response.VersionId !== process.env.DYNAMODB_RECOVERY_EXPECTED_VERSION_ID) {
	  throw new Error("DynamoDB recovery manifest GetObject VersionId does not match the selected immutable version.");
	}
	NODE
	  recovery_id="$(node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(".tmp/dynamodb-recovery-activation.json","utf8")).recoveryId; if (!/^[0-9a-f]{64}$/.test(value || "")) process.exit(1); process.stdout.write(value)')"
	  test "$DynamoDbRecoveryManifestKey" = "recovery-manifests/${var.account_alias}/${var.deployment_environment}/$recovery_id.json" || { echo "DynamoDB recovery manifest key does not match its canonical recoveryId." >&2; exit 1; }
	  pnpm tsx scripts/aws/prepare-dynamodb-recovery.ts --prepare-terraform --manifest .tmp/dynamodb-recovery-activation.json --expected-sha256 "$DynamoDbRecoveryManifestSha256" --expected-account-id "${var.aws_account_id}" --expected-region "${var.aws_region}" --expected-environment-alias "${var.account_alias}/${var.deployment_environment}" --write-tfvars "$recovery_candidate"
	fi
	DYNAMODB_RECOVERY_TFVARS="$recovery_candidate" DYNAMODB_RECOVERY_KEY="$DynamoDbRecoveryManifestKey" DYNAMODB_RECOVERY_VERSION_ID="$DynamoDbRecoveryManifestVersionId" DYNAMODB_RECOVERY_SHA256="$DynamoDbRecoveryManifestSha256" node <<'NODE' > "$recovery_evidence_candidate"
	const fs = require("node:fs");
	const phase = process.env.APP_DYNAMODB_RECOVERY_PHASE;
	const enabled = process.env.DYNAMODB_RECOVERY_KEY !== "__DISABLED__";
	const tfvarsPath = process.env.DYNAMODB_RECOVERY_TFVARS;
	const tfvars = JSON.parse(fs.readFileSync(tfvarsPath, "utf8"));
	tfvars.dynamodb_recovery_phase = phase;
	fs.writeFileSync(tfvarsPath, JSON.stringify(tfvars, null, 2) + "\n");
	process.stdout.write(JSON.stringify({
	  schemaVersion: "dynamodb-recovery-selection-v1",
	  phase: process.env.APP_DYNAMODB_RECOVERY_PHASE,
	  quiesced: phase.endsWith("_quiesced"),
	  servesReplacement: phase.startsWith("replacement_"),
	  enabled,
	  ...(enabled ? {
	    manifest: {
	      key: process.env.DYNAMODB_RECOVERY_KEY,
	      versionId: process.env.DYNAMODB_RECOVERY_VERSION_ID,
	      sha256: process.env.DYNAMODB_RECOVERY_SHA256,
	    },
	  } : {}),
	}, null, 2) + "\n");
	NODE
	if [ -f "$recovery_tfvars" ]; then
	  cmp "$recovery_tfvars" "$recovery_candidate" || { echo "Recovery activation changed after the reviewed plan." >&2; exit 1; }
	  rm -f "$recovery_candidate"
	else
	  mv "$recovery_candidate" "$recovery_tfvars"
	fi
	if [ -f "$recovery_evidence" ]; then
	  cmp "$recovery_evidence" "$recovery_evidence_candidate" || { echo "Recovery selection provenance changed after the reviewed plan." >&2; exit 1; }
	  rm -f "$recovery_evidence_candidate"
	else
	  mv "$recovery_evidence_candidate" "$recovery_evidence"
	fi
EOT
  app_target_lambda_artifacts_command = <<-EOT
	set -eu
	if [ "$APP_DEPLOYMENT_MODE" = "rollback" ]; then
	  node <<-'NODE'
	  const crypto = require("node:crypto");
	  const fs = require("node:fs");
	  const { execFileSync } = require("node:child_process");
	  const selected = JSON.parse(fs.readFileSync("selected-deployment-record.json", "utf8"));
	  const sourcePreflight = JSON.parse(fs.readFileSync("infra/terraform/app/evidence/source-preflight.json", "utf8"));
	  const retained = selected.retainedDeployables?.lambdaArtifacts;
	  const requiredNames = ["public_api", "finalization_writer", "proof_dispatcher", "verification_worker", "image_signature_gate", "semaphore_janitor"];
	  if (retained?.schemaVersion !== "target-lambda-artifacts-v1" || retained.sourceSha !== selected.sourceSha || requiredNames.some((name) => !retained.artifacts?.[name])) {
	    throw new Error("Rollback selection must retain all six Lambda artifacts for the selected source.");
	  }
	  function hcl(value) { return JSON.stringify(value); }
	  let tfvars = "\nlambda_artifacts = {\n";
	  for (const name of requiredNames) {
	    const artifact = retained.artifacts[name];
	    if (!artifact.s3_bucket || !artifact.s3_key || !artifact.s3_object_version || !artifact.source_code_hash || !/^[0-9a-f]{64}$/.test(artifact.sha256 || "")) {
	      throw new Error("Rollback Lambda artifact coordinates are incomplete for " + name + ".");
	    }
	    const path = ".tmp/rollback-" + name + ".zip";
	    const getObject = JSON.parse(execFileSync("aws", [
	      "s3api", "get-object", "--bucket", artifact.s3_bucket, "--key", artifact.s3_key,
	      "--version-id", artifact.s3_object_version,
	      "--expected-bucket-owner", "${var.aws_account_id}",
	      path, "--output", "json", "--no-cli-pager",
	    ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
	    if (getObject.VersionId !== artifact.s3_object_version) {
	      throw new Error("Rollback Lambda artifact VersionId mismatch for " + name + ".");
	    }
	    const actual = crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
	    if (actual !== artifact.sha256) throw new Error("Rollback Lambda artifact body checksum mismatch for " + name + ".");
	    tfvars += "  " + name + " = {\n";
	    tfvars += "    s3_bucket = " + hcl(artifact.s3_bucket) + "\n";
	    tfvars += "    s3_key = " + hcl(artifact.s3_key) + "\n";
	    tfvars += "    s3_object_version = " + hcl(artifact.s3_object_version) + "\n";
	    tfvars += "    source_code_hash = " + hcl(artifact.source_code_hash) + "\n";
	    tfvars += "  }\n";
	  }
	  tfvars += "}\n";
	  tfvars += "prover_image_uri = " + hcl(sourcePreflight.proverImageUri) + "\n";
	  tfvars += "expected_image_id = " + hcl(sourcePreflight.expectedImageId) + "\n";
	  const mapping = sourcePreflight.imageIdMappingEvidence;
	  tfvars += "image_id_mapping_evidence = {\n";
	  tfvars += "  mapping_path = " + hcl(mapping.mappingPath) + "\n";
	  tfvars += "  mapping_sha256 = " + hcl(mapping.mappingSha256) + "\n";
	  tfvars += "  current_method_version = " + mapping.currentMethodVersion + "\n";
	  tfvars += "  current_method_version_key = " + hcl(mapping.currentMethodVersionKey) + "\n";
	  tfvars += "  variant = " + hcl(mapping.variant) + "\n";
	  tfvars += "  field = " + hcl(mapping.field) + "\n";
	  tfvars += "  expected_image_id = " + hcl(mapping.expectedImageId) + "\n";
	  tfvars += "}\n";
	  tfvars += "prover_subnet_ids = " + JSON.stringify(sourcePreflight.proverSubnetIds) + "\n";
	  tfvars += "prover_security_group_ids = " + JSON.stringify(sourcePreflight.proverSecurityGroupIds) + "\n";
	  fs.appendFileSync("infra/terraform/app/pipeline.auto.tfvars", tfvars);
	  fs.writeFileSync("infra/terraform/app/evidence/target-lambda-artifacts.json", JSON.stringify(retained, null, 2) + "\n");
	NODE
	else
	corepack enable
	pnpm install --frozen-lockfile
	rust_toolchain="$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]\+\)".*/\1/p' rust-toolchain.toml | head -n 1)"
	test -n "$rust_toolchain"
	if ! command -v rustup >/dev/null 2>&1; then
	  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
	  export PATH="$HOME/.cargo/bin:$PATH"
	fi
	rustup toolchain install "$rust_toolchain" --profile minimal
	rustup default "$rust_toolchain"
	rustc --version | grep -E "^rustc $rust_toolchain( |$)"
	pnpm terraform:build-lambda:target-runtime
	node <<-'NODE'
	const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const manifest = JSON.parse(fs.readFileSync(".tmp/target-lambdas/manifest.json", "utf8"));
const sourcePreflight = JSON.parse(fs.readFileSync("infra/terraform/app/evidence/source-preflight.json", "utf8"));
const sourceSha = sourcePreflight.resolvedSourceSha;
const bucket = "${local.app_pipeline_artifact_bucket_name}";
const prefix = "lambda-artifacts/" + sourceSha;
const artifactEntries = {};

for (const [name, artifact] of Object.entries(manifest.artifacts)) {
  const key = prefix + "/" + artifact.fileName;
  let put;
  try {
    put = JSON.parse(execFileSync("aws", [
      "s3api", "put-object", "--bucket", bucket, "--key", key, "--body", artifact.path,
      "--metadata", "sourceSha=" + sourceSha + ",artifactName=" + name + ",sha256=" + artifact.sha256,
      "--if-none-match", "*", "--expected-bucket-owner", "${var.aws_account_id}",
      "--output", "json", "--no-cli-pager",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const stderr = String(error.stderr || "");
    if (!/\bPreconditionFailed\b|\b(?:HTTP|status code:)\s*412\b/i.test(stderr)) throw error;
    const existingPath = ".tmp/target-lambdas/existing-" + name + ".zip";
    execFileSync("aws", ["s3api", "get-object", "--bucket", bucket, "--key", key, "--expected-bucket-owner", "${var.aws_account_id}", existingPath, "--output", "json", "--no-cli-pager"], { stdio: ["ignore", "pipe", "inherit"] });
    const existingSha = require("node:crypto").createHash("sha256").update(fs.readFileSync(existingPath)).digest("hex");
    if (existingSha !== artifact.sha256) throw new Error("Retained Lambda artifact differs for the same source SHA: " + name + ".");
    put = JSON.parse(execFileSync("aws", ["s3api", "head-object", "--bucket", bucket, "--key", key, "--expected-bucket-owner", "${var.aws_account_id}", "--output", "json", "--no-cli-pager"], { encoding: "utf8" }));
  }
  if (!put.VersionId) {
    throw new Error("App artifact bucket versioning did not return a VersionId for " + name + ".");
  }
  artifactEntries[name] = {
    s3_bucket: bucket,
    s3_key: key,
    s3_object_version: put.VersionId,
    source_code_hash: artifact.sourceCodeHash,
    sha256: artifact.sha256,
  };
}

function hclString(value) {
  return JSON.stringify(value);
}

let tfvars = "\nlambda_artifacts = {\n";
for (const [name, artifact] of Object.entries(artifactEntries)) {
  tfvars += "  " + name + " = {\n";
  tfvars += "    s3_bucket = " + hclString(artifact.s3_bucket) + "\n";
  tfvars += "    s3_key = " + hclString(artifact.s3_key) + "\n";
  tfvars += "    s3_object_version = " + hclString(artifact.s3_object_version) + "\n";
  tfvars += "    source_code_hash = " + hclString(artifact.source_code_hash) + "\n";
  tfvars += "  }\n";
}
tfvars += "}\n";
tfvars += "prover_image_uri = " + hclString(sourcePreflight.proverImageUri) + "\n";
tfvars += "expected_image_id = " + hclString(sourcePreflight.expectedImageId) + "\n";
tfvars += "image_id_mapping_evidence = {\n";
tfvars += "  mapping_path = " + hclString(sourcePreflight.imageIdMappingEvidence.mappingPath) + "\n";
tfvars += "  mapping_sha256 = " + hclString(sourcePreflight.imageIdMappingEvidence.mappingSha256) + "\n";
tfvars += "  current_method_version = " + sourcePreflight.imageIdMappingEvidence.currentMethodVersion + "\n";
tfvars += "  current_method_version_key = " + hclString(sourcePreflight.imageIdMappingEvidence.currentMethodVersionKey) + "\n";
tfvars += "  variant = " + hclString(sourcePreflight.imageIdMappingEvidence.variant) + "\n";
tfvars += "  field = " + hclString(sourcePreflight.imageIdMappingEvidence.field) + "\n";
tfvars += "  expected_image_id = " + hclString(sourcePreflight.imageIdMappingEvidence.expectedImageId) + "\n";
tfvars += "}\n";
tfvars += "prover_subnet_ids = " + JSON.stringify(sourcePreflight.proverSubnetIds) + "\n";
tfvars += "prover_security_group_ids = " + JSON.stringify(sourcePreflight.proverSecurityGroupIds) + "\n";
fs.appendFileSync("infra/terraform/app/pipeline.auto.tfvars", tfvars);
fs.writeFileSync("infra/terraform/app/evidence/target-lambda-artifacts.json", JSON.stringify({
  schemaVersion: "target-lambda-artifacts-v1",
  sourceSha,
  bucket,
  prefix,
  artifacts: artifactEntries,
  proverImageUri: sourcePreflight.proverImageUri,
  expectedImageId: sourcePreflight.expectedImageId,
  imageIdMappingEvidence: sourcePreflight.imageIdMappingEvidence,
  proverSubnetIds: sourcePreflight.proverSubnetIds,
  proverSecurityGroupIds: sourcePreflight.proverSecurityGroupIds,
	}, null, 2) + "\n");
	NODE
	fi
EOT

}
