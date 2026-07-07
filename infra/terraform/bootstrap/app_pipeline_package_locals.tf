locals {
  app_codebuild_source_env_variables = jsonencode([
    {
      name  = "APP_RELEASE_MANIFEST_KEY"
      value = "#{variables.ReleaseManifestKey}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_RELEASE_MANIFEST_VERSION_ID"
      value = "#{variables.ReleaseManifestVersionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_RELEASE_MANIFEST_SHA256"
      value = "#{variables.ReleaseManifestSha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
  ])
  app_source_preflight_command        = "APP_RELEASE_MANIFEST_BUCKET=${local.app_release_manifest_bucket_name} APP_AWS_ACCOUNT_ID=${var.aws_account_id} APP_AWS_REGION=${var.aws_region} APP_SOURCE_BRANCH=${var.source_branch} APP_SOURCE_REPOSITORY=${var.github_full_repository_id} APP_PIPELINE_NAME=${local.app_pipeline_name} node scripts/aws/write-app-source-preflight.mjs"
  app_target_lambda_artifacts_command = <<-EOT
	set -eu
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
	node <<'NODE'
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
  const put = JSON.parse(execFileSync("aws", [
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    key,
    "--body",
    artifact.path,
    "--metadata",
    "sourceSha=" + sourceSha + ",artifactName=" + name + ",sha256=" + artifact.sha256,
    "--output",
    "json",
    "--no-cli-pager",
  ], { encoding: "utf8" }));
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
EOT

}
