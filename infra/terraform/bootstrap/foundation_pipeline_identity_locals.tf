locals {
  foundation_pipeline_enabled = var.enable_development_foundation_pipeline
  foundation_pipeline_identity_approved = (
    var.enable_development_foundation_pipeline == false
    || (
      var.enable_development_pipeline
      && var.account_alias == "stark-dev"
      && var.deployment_environment == "develop"
      && var.state_scope == "bootstrap"
      && var.source_branch == "develop"
    )
  )

  foundation_pipeline_name = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-foundation"
  foundation_pipeline_artifact_bucket_name = coalesce(
    var.foundation_pipeline_artifact_bucket_name,
    "sbs-fdn-pipeline-artifacts-${var.account_alias}-${var.deployment_environment}-${var.aws_account_id}",
  )
  foundation_artifact_kms_alias     = "alias/${local.foundation_pipeline_name}-artifacts"
  foundation_artifact_kms_alias_arn = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.foundation_artifact_kms_alias}"
  foundation_runtime_name_prefix    = "${var.project_name}-${var.account_alias}-${var.deployment_environment}"
  foundation_release_manifest_bucket_name = coalesce(
    var.foundation_release_manifest_bucket_name,
    "${local.foundation_runtime_name_prefix}-release-manifests",
  )
  foundation_release_manifest_bucket_arn  = "arn:aws:s3:::${local.foundation_release_manifest_bucket_name}"
  foundation_release_manifest_objects_arn = "${local.foundation_release_manifest_bucket_arn}/*"
  foundation_risc0_toolchain_ecr_repository_arn = (
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.foundation_runtime_name_prefix}/risc0-toolchain"
  )
  foundation_prover_ecr_repository_arn = (
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.foundation_runtime_name_prefix}/prover"
  )
  foundation_ecr_repository_arns = [
    local.foundation_risc0_toolchain_ecr_repository_arn,
    local.foundation_prover_ecr_repository_arn,
  ]
  foundation_prover_release_candidate_metadata_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/artifacts/prover/candidates/*"
  )
  foundation_prover_release_records_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/artifacts/prover/*"
  )
  foundation_prover_release_promotion_evidence_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/promotions/develop/prover/*"
  )
  foundation_prover_accepted_pointer_object_arn = "${local.foundation_release_manifest_bucket_arn}/channels/develop/prover/accepted.json"
  foundation_toolchain_artifact_records_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/artifacts/toolchain/*"
  )
  foundation_toolchain_accepted_pointer_object_arn = (
    "${local.foundation_release_manifest_bucket_arn}/channels/develop/toolchain/accepted.json"
  )
  # Candidate metadata deliberately lives outside artifacts/toolchain/, the
  # prefix the prover resolver trusts for pinned/accepted artifact records.
  foundation_toolchain_release_candidate_metadata_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/candidates/toolchain/*"
  )
  foundation_toolchain_release_promotion_evidence_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/promotions/develop/toolchain/*"
  )
  foundation_ecr_signing_profile_name = "${replace(local.foundation_runtime_name_prefix, "-", "_")}_ecr"
  foundation_ecr_signing_profile_arn  = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-profiles/${local.foundation_ecr_signing_profile_name}"
  foundation_ecr_signing_profile_arns = [
    local.foundation_ecr_signing_profile_arn,
    "${local.foundation_ecr_signing_profile_arn}/*",
  ]
  foundation_runtime_secret_arns = [
    "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/*",
  ]
  foundation_runtime_ssm_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/config/*",
  ]

  foundation_pipeline_role_name = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-foundation"
  foundation_release_candidate_build_role_name = (
    "${var.project_name}-release-candidate-build-${var.account_alias}-${var.deployment_environment}"
  )
  foundation_prover_release_candidate_build_role_name          = "sbs-prover-candidate-${var.account_alias}-${var.deployment_environment}"
  foundation_prover_release_toolchain_resolver_build_role_name = "sbs-prover-tc-resolver-${var.account_alias}-${var.deployment_environment}"
  foundation_prover_release_promotion_evidence_build_role_name = "sbs-prover-evidence-${var.account_alias}-${var.deployment_environment}"
  foundation_prover_release_update_accepted_pointer_build_role_name = (
    "sbs-prover-pointer-${var.account_alias}-${var.deployment_environment}"
  )
  foundation_toolchain_release_candidate_build_role_name          = "sbs-toolchain-candidate-${var.account_alias}-${var.deployment_environment}"
  foundation_toolchain_release_promotion_evidence_build_role_name = "sbs-toolchain-evidence-${var.account_alias}-${var.deployment_environment}"
  foundation_toolchain_release_update_accepted_pointer_build_role_name = (
    "sbs-toolchain-pointer-${var.account_alias}-${var.deployment_environment}"
  )
  foundation_terraform_plan_role_name  = "stark-ballot-sim-tf-plan-${var.account_alias}-${var.deployment_environment}-foundation"
  foundation_terraform_apply_role_name = "stark-ballot-sim-tf-apply-${var.account_alias}-${var.deployment_environment}-foundation"
  foundation_terraform_smoke_role_name = "stark-ballot-sim-tf-smoke-${var.account_alias}-${var.deployment_environment}-foundation"

  foundation_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-foundation-deploy-boundary-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_apply_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-foundation-apply-deploy-boundary-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_smoke_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-foundation-smoke-deploy-boundary-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_deploy_permissions_boundary_policy_name}"
  )
  foundation_apply_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_apply_deploy_permissions_boundary_policy_name}"
  )
  foundation_smoke_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_smoke_deploy_permissions_boundary_policy_name}"
  )
  foundation_deploy_permissions_boundary_policy_arns = [
    local.foundation_deploy_permissions_boundary_policy_arn,
    local.foundation_apply_deploy_permissions_boundary_policy_arn,
    local.foundation_smoke_deploy_permissions_boundary_policy_arn,
  ]

  foundation_lane_pipeline_management_policy_name = (
    "${var.project_name}-bootstrap-foundation-lane-pipeline-${var.account_alias}-${var.deployment_environment}"
  )
  foundation_lane_iam_management_policy_name = (
    "${var.project_name}-bootstrap-foundation-lane-iam-${var.account_alias}-${var.deployment_environment}"
  )
  foundation_lane_artifacts_management_policy_name = (
    "${var.project_name}-bootstrap-foundation-lane-artifacts-${var.account_alias}-${var.deployment_environment}"
  )
  foundation_lane_management_policy_arns = [
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_lane_pipeline_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_lane_iam_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_lane_artifacts_management_policy_name}",
  ]
  foundation_terraform_apply_workload_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_terraform_apply_role_name}-workload"
  )

  foundation_validate_project_name        = "${local.foundation_pipeline_name}-validate"
  foundation_terraform_plan_project_name  = "${local.foundation_pipeline_name}-terraform-plan"
  foundation_terraform_apply_project_name = "${local.foundation_pipeline_name}-terraform-apply"
  foundation_smoke_project_name           = "${local.foundation_pipeline_name}-smoke"
  release_candidate_pipeline_name         = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-release-candidate"
  release_candidate_preflight_project_name = (
    "${local.release_candidate_pipeline_name}-preflight"
  )
  prover_release_pipeline_name = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-prover-release"
  prover_release_toolchain_resolver_project_name = (
    "${local.prover_release_pipeline_name}-toolchain-resolver"
  )
  prover_release_candidate_project_name = (
    "${local.prover_release_pipeline_name}-candidate"
  )
  prover_release_promotion_evidence_project_name = (
    "${local.prover_release_pipeline_name}-promotion-evidence"
  )
  prover_release_update_accepted_pointer_project_name = (
    "${local.prover_release_pipeline_name}-update-accepted-pointer"
  )
  toolchain_release_pipeline_name = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-toolchain-release"
  toolchain_release_candidate_project_name = (
    "${local.toolchain_release_pipeline_name}-candidate"
  )
  toolchain_release_promotion_evidence_project_name = (
    "${local.toolchain_release_pipeline_name}-promotion-evidence"
  )
  toolchain_release_update_accepted_pointer_project_name = (
    "${local.toolchain_release_pipeline_name}-update-accepted-pointer"
  )
  foundation_codebuild_project_names = [
    local.foundation_validate_project_name,
    local.foundation_terraform_plan_project_name,
    local.foundation_terraform_apply_project_name,
    local.foundation_smoke_project_name,
    local.release_candidate_preflight_project_name,
    local.prover_release_toolchain_resolver_project_name,
    local.prover_release_candidate_project_name,
    local.prover_release_promotion_evidence_project_name,
    local.prover_release_update_accepted_pointer_project_name,
    local.toolchain_release_candidate_project_name,
    local.toolchain_release_promotion_evidence_project_name,
    local.toolchain_release_update_accepted_pointer_project_name,
  ]
  foundation_codebuild_project_arns = [
    for name in local.foundation_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  foundation_pipeline_arn                = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.foundation_pipeline_name}"
  release_candidate_pipeline_arn         = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.release_candidate_pipeline_name}"
  prover_release_pipeline_arn            = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.prover_release_pipeline_name}"
  foundation_pipeline_action_arn_pattern = "${local.foundation_pipeline_arn}*"
  release_candidate_pipeline_action_arn_pattern = (
    "${local.release_candidate_pipeline_arn}*"
  )
  prover_release_pipeline_action_arn_pattern = (
    "${local.prover_release_pipeline_arn}*"
  )
  toolchain_release_pipeline_arn = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.toolchain_release_pipeline_name}"
  toolchain_release_pipeline_action_arn_pattern = (
    "${local.toolchain_release_pipeline_arn}*"
  )
  foundation_pipeline_artifact_bucket_arn = "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}"
  foundation_source_connection_arns = [
    aws_codeconnections_connection.source[0].arn,
    replace(aws_codeconnections_connection.source[0].arn, ":codeconnections:", ":codestar-connections:"),
  ]
  foundation_codebuild_log_group_arns = [
    for name in local.foundation_codebuild_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  foundation_pipeline_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_release_candidate_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_toolchain_resolver_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_candidate_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_promotion_evidence_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_update_accepted_pointer_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_toolchain_release_candidate_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_toolchain_release_promotion_evidence_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_toolchain_release_update_accepted_pointer_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_smoke_role_name}",
  ]
  foundation_pipeline_role_arn_pattern = "arn:aws:iam::${var.aws_account_id}:role/*-${var.account_alias}-${var.deployment_environment}-foundation"

  foundation_state_backend_key = "${var.project_name}/${var.account_alias}/${var.deployment_environment}/foundation/terraform.tfstate"
  foundation_backend_config_content = join("\n", [
    "bucket       = \"${aws_s3_bucket.state.bucket}\"",
    "key          = \"${local.foundation_state_backend_key}\"",
    "region       = \"${var.aws_region}\"",
    "encrypt      = true",
    "kms_key_id   = \"${var.state_kms_alias}\"",
    "use_lockfile = true",
  ])
  foundation_pipeline_tfvars_content = join("\n", [
    "account_alias          = \"stark-dev\"",
    "aws_account_id         = \"${var.aws_account_id}\"",
    "aws_region             = \"${var.aws_region}\"",
    "deployment_environment = \"develop\"",
    "project_name           = \"${var.project_name}\"",
    "state_backend_key      = \"${local.foundation_state_backend_key}\"",
    "state_scope            = \"foundation\"",
  ])
  foundation_backend_config_command = "printf '%s' '${base64encode(local.foundation_backend_config_content)}' | base64 -d > infra/terraform/foundation/backend.pipeline.hcl"
  foundation_tfvars_command         = "printf '%s' '${base64encode(local.foundation_pipeline_tfvars_content)}' | base64 -d > infra/terraform/foundation/pipeline.auto.tfvars"
  foundation_guard_env_prefix       = "TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV=${var.aws_account_id} TERRAFORM_WORKING_DIR=infra/terraform/foundation TERRAFORM_APP_BACKEND_BUCKET=${aws_s3_bucket.state.bucket} TERRAFORM_APP_BACKEND_REGION=${var.aws_region} TERRAFORM_APP_BACKEND_KMS_KEY_ID=${var.state_kms_alias}"
  foundation_guard_init_command     = "${local.foundation_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/foundation init -backend-config=backend.pipeline.hcl"
  foundation_guard_validate_command = "${local.foundation_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/foundation validate"
  foundation_guard_plan_command     = "${local.foundation_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/foundation plan -out=tfplan -var-file=pipeline.auto.tfvars"
  foundation_guard_apply_command    = "${local.foundation_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/foundation apply -auto-approve tfplan"
  foundation_guard_smoke_command    = "${local.foundation_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/foundation smoke"
  foundation_absence_smoke_command = <<-EOT
node <<'NODE'
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");

const stateBucket = "${aws_s3_bucket.state.bucket}";
const appStateKey = "${local.app_state_backend_key}";
const appNamePrefix = "${local.app_runtime_name_prefix}";
const cloudFrontComment = appNamePrefix + " static frontend";
const expectedSigningProfileArn = "${local.foundation_ecr_signing_profile_arn}";
const expectedSigningRepositoryFilters = ${jsonencode([
  format("%s/risc0-toolchain", local.foundation_runtime_name_prefix),
  format("%s/prover", local.foundation_runtime_name_prefix),
])};
const appBuckets = [
  "${local.app_target_proof_bucket_name}",
  "${local.app_target_frontend_bucket_name}",
];

function awsJson(args) {
  const output = execFileSync("aws", [...args, "--output", "json", "--no-cli-pager"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output || "{}");
}

function countAppStateObjects() {
  const result = awsJson([
    "s3api",
    "list-objects-v2",
    "--bucket",
    stateBucket,
    "--prefix",
    appStateKey,
    "--max-keys",
    "1",
  ]);
  return Array.isArray(result.Contents) ? result.Contents.length : 0;
}

function countHeadBucketExists(bucket) {
  const result = spawnSync("aws", ["s3api", "head-bucket", "--bucket", bucket, "--no-cli-pager"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return 1;
  }
  if (/(404|Not Found|NoSuchBucket)/i.test(result.stderr || "")) {
    return 0;
  }
  throw new Error("Unable to prove S3 bucket absence for " + bucket + ": " + (result.stderr || result.status));
}

function verifyEcrSigningConfiguration() {
  const result = awsJson(["ecr", "get-signing-configuration"]);
  const signingConfiguration = result.signingConfiguration || result.SigningConfiguration || {};
  const rules = signingConfiguration.rules || signingConfiguration.Rules || result.rules || result.Rules || [];
  if (!Array.isArray(rules)) {
    throw new Error("Foundation ECR signing configuration mismatch: rules missing");
  }
  const matchingRule = rules.find((rule) => {
    const signingProfileArn = String(rule.signingProfileArn || rule.SigningProfileArn || "");
    return signingProfileArn === expectedSigningProfileArn;
  });
  if (!matchingRule) {
    throw new Error("Foundation ECR signing configuration mismatch: expected signing profile not configured");
  }
  const repositoryFilters = matchingRule.repositoryFilters || matchingRule.RepositoryFilters || [];
  const configuredFilters = new Set(
    Array.isArray(repositoryFilters)
      ? repositoryFilters
          .filter((filter) => String(filter.filterType || filter.FilterType || "") === "WILDCARD_MATCH")
          .map((filter) => String(filter.filter || filter.Filter || ""))
      : [],
  );
  const missingFilters = expectedSigningRepositoryFilters.filter((filter) => !configuredFilters.has(filter));
  if (missingFilters.length > 0) {
    throw new Error("Foundation ECR signing configuration mismatch: " + JSON.stringify({ missingFilters }));
  }
}

verifyEcrSigningConfiguration();

const checks = [
  {
    id: "app_tfstate_absent",
    count: countAppStateObjects(),
  },
  {
    id: "api_gateway_absent",
    count: (awsJson(["apigatewayv2", "get-apis"]).Items || []).filter((item) =>
      String(item.Name || "").startsWith(appNamePrefix),
    ).length,
  },
  {
    id: "lambda_absent",
    count: (awsJson(["lambda", "list-functions"]).Functions || []).filter((item) =>
      String(item.FunctionName || "").startsWith(appNamePrefix),
    ).length,
  },
  {
    id: "dynamodb_absent",
    count: (awsJson(["dynamodb", "list-tables"]).TableNames || []).filter((name) =>
      String(name).startsWith(appNamePrefix),
    ).length,
  },
  {
    id: "sqs_absent",
    count: (awsJson(["sqs", "list-queues", "--queue-name-prefix", appNamePrefix]).QueueUrls || []).length,
  },
  {
    id: "step_functions_absent",
    count: (awsJson(["stepfunctions", "list-state-machines"]).stateMachines || []).filter((item) =>
      String(item.name || "").startsWith(appNamePrefix),
    ).length,
  },
  {
    id: "ecs_absent",
    count: (awsJson(["ecs", "list-clusters"]).clusterArns || []).filter((arn) =>
      String(arn).includes(":cluster/" + appNamePrefix + "-prover"),
    ).length,
  },
  {
    id: "cloudfront_absent",
    count: (((awsJson(["cloudfront", "list-distributions"]).DistributionList || {}).Items) || []).filter(
      (item) => String(item.Comment || "") === cloudFrontComment,
    ).length,
  },
  ...appBuckets.map((bucket) => ({
    id: "s3_bucket_absent:" + bucket,
    count: countHeadBucketExists(bucket),
  })),
];

const failingChecks = checks.filter((check) => check.count !== 0);
const evidence = {
  schemaVersion: "foundation-saved-plan-evidence-v1",
  manifestType: "foundation-smoke",
  stateIdentity: "stark-dev/develop/foundation",
  sourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION,
  appRuntimeResourcesCreated: failingChecks.length > 0,
  evidenceClass: "FoundationStateAbsenceOfAppRuntime",
  acceptedMarkerPath: "${local.foundation_accepted_marker_path}",
  appStateKey,
  appNamePrefix,
  checks,
};
fs.writeFileSync(
  "infra/terraform/foundation/evidence/foundation-smoke.json",
  JSON.stringify(evidence, null, 2) + "\\n",
);
if (failingChecks.length > 0) {
  throw new Error("Foundation smoke found app state or runtime resources: " + JSON.stringify(failingChecks));
}
NODE
EOT
foundation_accepted_marker_path = "accepted-deployments/stark-dev/develop/foundation"
}
