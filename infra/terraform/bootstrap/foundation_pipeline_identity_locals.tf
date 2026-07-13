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

const expectedSigningProfileArn = "${local.foundation_ecr_signing_profile_arn}";
const expectedSigningRepositoryFilters = ${jsonencode([
  format("%s/risc0-toolchain", local.foundation_runtime_name_prefix),
  format("%s/prover", local.foundation_runtime_name_prefix),
  ])};
const expectedImageRepositories = ${jsonencode([
  format("%s/risc0-toolchain", local.foundation_runtime_name_prefix),
  format("%s/prover", local.foundation_runtime_name_prefix),
])};
const releaseManifestBucket = "${local.foundation_release_manifest_bucket_name}";
const releaseManifestBucketArn = "${local.foundation_release_manifest_bucket_arn}";
const expectedFoundationApplyRoleName = "${local.foundation_terraform_apply_role_name}";
const expectedFoundationApplyBoundaryArn = "${local.foundation_apply_deploy_permissions_boundary_policy_arn}";
const expectedFoundationApplyWorkloadPolicyArn = "${local.foundation_terraform_apply_workload_policy_arn}";
const expectedImageRepositoryArns = ${jsonencode(local.foundation_ecr_repository_arns)};

function awsJson(args) {
  const output = execFileSync("aws", [...args, "--output", "json", "--no-cli-pager"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output || "{}");
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

function asSet(value) {
  return new Set(Array.isArray(value) ? value : [value]);
}

function requireExactConditionalWriteDeny(statements, sid, label, expectedResources, expectedConditionKeys) {
  const missingPrefix =
    label === "Accepted pointer"
      ? "Accepted pointer conditional-write deny is missing"
      : label + " conditional-write deny is missing";
  const statement = statements.find((candidate) => candidate.Sid === sid);
  if (!statement || statement.Effect !== "Deny") {
    throw new Error("Release authority bucket is missing " + sid);
  }
  const principal = statement.Principal;
  const principalAws = principal && typeof principal === "object" ? principal.AWS : undefined;
  const principalKeys = principal && typeof principal === "object" ? Object.keys(principal) : [];
  const principalValues = Array.isArray(principalAws) ? principalAws : [principalAws];
  const exactWildcardPrincipal =
    principal === "*" ||
    (principalKeys.length === 1 &&
      principalKeys[0] === "AWS" &&
      principalValues.length === 1 &&
      principalValues[0] === "*");
  if (!exactWildcardPrincipal || statement.NotPrincipal !== undefined) {
    throw new Error(
      label === "Accepted pointer"
        ? "Accepted pointer conditional-write deny must apply to Principal *"
        : label + " conditional-write deny must apply to Principal *",
    );
  }
  if (statement.NotAction !== undefined || statement.NotResource !== undefined) {
    throw new Error(label + " conditional-write deny must use exact Action and Resource fields");
  }
  const actions = asSet(statement.Action);
  if (actions.size !== 1 || !actions.has("s3:PutObject")) {
    throw new Error(missingPrefix + " exact s3:PutObject authority");
  }
  const resources = asSet(statement.Resource);
  if (
    resources.size !== expectedResources.length ||
    expectedResources.some((resource) => !resources.has(resource))
  ) {
    throw new Error(missingPrefix + " an exact protected resource");
  }
  const condition = statement.Condition;
  const conditionOperators = condition && typeof condition === "object" ? Object.keys(condition) : [];
  if (conditionOperators.length !== 1 || conditionOperators[0] !== "Null") {
    throw new Error(label + " conditional-write deny has unexpected condition operators");
  }
  const nullConditions = condition.Null;
  const conditionKeys = nullConditions && typeof nullConditions === "object" ? Object.keys(nullConditions).sort() : [];
  const sortedExpectedConditionKeys = [...expectedConditionKeys].sort();
  if (
    conditionKeys.length !== sortedExpectedConditionKeys.length ||
    conditionKeys.some((key, index) => key !== sortedExpectedConditionKeys[index])
  ) {
    throw new Error(label + " conditional-write deny has unexpected condition keys");
  }
  for (const key of sortedExpectedConditionKeys) {
    const values = Array.isArray(nullConditions[key]) ? nullConditions[key] : [nullConditions[key]];
    if (values.length !== 1 || (values[0] !== true && values[0] !== "true")) {
      throw new Error(missingPrefix + " " + key);
    }
  }
}

function verifyReleaseAuthorityRetention() {
  for (const repository of expectedImageRepositories) {
    const result = spawnSync(
      "aws",
      ["ecr", "get-lifecycle-policy", "--repository-name", repository, "--no-cli-pager"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) {
      throw new Error("Automatic ECR lifecycle expiry remains configured for " + repository);
    }
    if (!/LifecyclePolicyNotFoundException/i.test(result.stderr || "")) {
      throw new Error("Unable to prove ECR lifecycle absence for " + repository + ": " + (result.stderr || result.status));
    }
  }

  const bucketLifecycle = spawnSync(
    "aws",
    ["s3api", "get-bucket-lifecycle-configuration", "--bucket", releaseManifestBucket, "--no-cli-pager"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (bucketLifecycle.status === 0) {
    throw new Error("Automatic release authority S3 lifecycle remains configured");
  }
  if (!/NoSuchLifecycleConfiguration/i.test(bucketLifecycle.stderr || "")) {
    throw new Error(
      "Unable to prove release authority S3 lifecycle absence: " +
        (bucketLifecycle.stderr || bucketLifecycle.status),
    );
  }

  const bucketPolicyResult = awsJson(["s3api", "get-bucket-policy", "--bucket", releaseManifestBucket]);
  const bucketPolicy = JSON.parse(String(bucketPolicyResult.Policy || "{}"));
  const statements = Array.isArray(bucketPolicy.Statement) ? bucketPolicy.Statement : [];
  const retentionDeny = statements.find((statement) => statement.Sid === "DenyImmutableReleaseAuthorityDeletion");
  if (!retentionDeny || retentionDeny.Effect !== "Deny") {
    throw new Error("Release authority bucket is missing DenyImmutableReleaseAuthorityDeletion");
  }
  const principal = retentionDeny.Principal;
  const principalAws = principal && typeof principal === "object" ? principal.AWS : undefined;
  const appliesToEveryone =
    principal === "*" ||
    principalAws === "*" ||
    (Array.isArray(principalAws) && principalAws.includes("*"));
  if (!appliesToEveryone || retentionDeny.NotPrincipal !== undefined) {
    throw new Error("Release authority deletion deny must apply to Principal *");
  }
  if (retentionDeny.Condition !== undefined) {
    throw new Error("Release authority deletion deny must be unconditional");
  }
  const actions = new Set(Array.isArray(retentionDeny.Action) ? retentionDeny.Action : [retentionDeny.Action]);
  for (const action of ["s3:DeleteObject", "s3:DeleteObjectVersion"]) {
    if (!actions.has(action)) {
      throw new Error("Release authority deletion deny is missing " + action);
    }
  }
  const resources = new Set(
    Array.isArray(retentionDeny.Resource) ? retentionDeny.Resource : [retentionDeny.Resource],
  );
  for (const prefix of ["artifacts", "promotions", "deployments", "rollbacks"]) {
    const expected = "arn:aws:s3:::" + releaseManifestBucket + "/" + prefix + "/*";
    if (!resources.has(expected)) {
      throw new Error("Release authority deletion deny is missing " + expected);
    }
  }

  requireExactConditionalWriteDeny(
    statements,
    "DenyUnconditionalImmutableReleaseAuthorityWrites",
    "Release authority create-only",
    ["artifacts", "promotions", "deployments", "rollbacks"].map(
      (prefix) => releaseManifestBucketArn + "/" + prefix + "/*",
    ),
    ["s3:if-none-match"],
  );
  requireExactConditionalWriteDeny(
    statements,
    "DenyUnconditionalAcceptedPointerWrites",
    "Accepted pointer",
    ["toolchain", "prover"].map(
      (channel) => releaseManifestBucketArn + "/channels/develop/" + channel + "/accepted.json",
    ),
    ["s3:if-none-match", "s3:if-match"],
  );
}

function requireUnconditionalBoundaryDeny(statements, sid, expectedActions, expectedResources) {
  const statement = statements.find((candidate) => candidate.Sid === sid);
  if (!statement || statement.Effect !== "Deny") {
    throw new Error("Foundation apply boundary is missing " + sid);
  }
  if (
    statement.Condition !== undefined ||
    statement.NotAction !== undefined ||
    statement.NotResource !== undefined
  ) {
    throw new Error("Foundation apply boundary deny must be unconditional: " + sid);
  }
  const actions = asSet(statement.Action);
  for (const action of expectedActions) {
    if (!actions.has(action)) {
      throw new Error("Foundation apply boundary " + sid + " is missing action " + action);
    }
  }
  const resources = asSet(statement.Resource);
  for (const resource of expectedResources) {
    if (!resources.has(resource)) {
      throw new Error("Foundation apply boundary " + sid + " is missing resource " + resource);
    }
  }
}

function verifyFoundationApplyBoundary() {
  const roleResult = awsJson(["iam", "get-role", "--role-name", expectedFoundationApplyRoleName]);
  const appliedBoundaryArn = String(
    (((roleResult.Role || {}).PermissionsBoundary || {}).PermissionsBoundaryArn) || "",
  );
  if (appliedBoundaryArn !== expectedFoundationApplyBoundaryArn) {
    throw new Error("Foundation apply role permissions boundary mismatch");
  }

  const policyResult = awsJson(["iam", "get-policy", "--policy-arn", expectedFoundationApplyBoundaryArn]);
  const defaultVersionId = String(((policyResult.Policy || {}).DefaultVersionId) || "");
  if (!defaultVersionId) {
    throw new Error("Foundation apply boundary default version is missing");
  }
  const versionResult = awsJson([
    "iam",
    "get-policy-version",
    "--policy-arn",
    expectedFoundationApplyBoundaryArn,
    "--version-id",
    defaultVersionId,
  ]);
  const policyDocument = (versionResult.PolicyVersion || {}).Document || {};
  const statements = Array.isArray(policyDocument.Statement) ? policyDocument.Statement : [];
  requireUnconditionalBoundaryDeny(
    statements,
    "DenyDeletingRetainedFoundationImages",
    ["ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:PutLifecyclePolicy"],
    expectedImageRepositoryArns,
  );
  requireUnconditionalBoundaryDeny(
    statements,
    "DenyDeletingImmutableReleaseAuthority",
    ["s3:DeleteObject", "s3:DeleteObjectVersion"],
    ["artifacts", "promotions", "deployments", "rollbacks"].map(
      (prefix) => releaseManifestBucketArn + "/" + prefix + "/*",
    ),
  );
  requireUnconditionalBoundaryDeny(
    statements,
    "DenyAddingReleaseAuthorityLifecycle",
    ["s3:PutLifecycleConfiguration"],
    [releaseManifestBucketArn],
  );
}

function verifyFoundationApplyWorkloadPolicy() {
  const attachedResult = awsJson([
    "iam", "list-attached-role-policies", "--role-name", expectedFoundationApplyRoleName,
  ]);
  const attachedPolicies = Array.isArray(attachedResult.AttachedPolicies) ? attachedResult.AttachedPolicies : [];
  if (!attachedPolicies.some((policy) => policy.PolicyArn === expectedFoundationApplyWorkloadPolicyArn)) {
    throw new Error("Foundation apply workload policy must be attached to the apply role");
  }

  const policyResult = awsJson([
    "iam",
    "get-policy",
    "--policy-arn",
    expectedFoundationApplyWorkloadPolicyArn,
  ]);
  const policy = policyResult.Policy || {};
  const defaultVersionId = String(policy.DefaultVersionId || "");
  if (policy.Arn !== expectedFoundationApplyWorkloadPolicyArn || !defaultVersionId) {
    throw new Error("Foundation apply workload policy default version is missing or mismatched");
  }
  const versionResult = awsJson([
    "iam",
    "get-policy-version",
    "--policy-arn",
    expectedFoundationApplyWorkloadPolicyArn,
    "--version-id",
    defaultVersionId,
  ]);
  const policyDocument = (versionResult.PolicyVersion || {}).Document || {};
  const statements = Array.isArray(policyDocument.Statement) ? policyDocument.Statement : [];
  const manifestStatements = statements.filter(
    (statement) => statement.Sid === "ManageFoundationManifestStorage",
  );
  if (manifestStatements.length !== 1) {
    throw new Error("Foundation apply workload policy must define one ManageFoundationManifestStorage statement");
  }
  const manifestStatement = manifestStatements[0];
  const manifestActions = asSet(manifestStatement.Action);
  const manifestResources = asSet(manifestStatement.Resource);
  if (
    manifestStatement.Effect !== "Allow" ||
    manifestStatement.Condition !== undefined ||
    manifestStatement.NotAction !== undefined ||
    manifestStatement.NotResource !== undefined ||
    manifestActions.size !== 1 ||
    !manifestActions.has("s3:*") ||
    manifestResources.size !== 1 ||
    !manifestResources.has(releaseManifestBucketArn)
  ) {
    throw new Error("Foundation manifest storage authority must be bucket-only");
  }

  for (const statement of statements) {
    if (statement.Effect !== "Allow") continue;
    const actions = asSet(statement.Action);
    const resources = asSet(statement.Resource);
    const canAffectS3 =
      statement.NotAction !== undefined ||
      [...actions].some((action) => action === "*" || (typeof action === "string" && action.startsWith("s3:")));
    const reachesReleaseObjects = [...resources].some(
      (resource) =>
        resource === "*" ||
        (typeof resource === "string" && resource.startsWith(releaseManifestBucketArn + "/")),
    );
    if (canAffectS3 && reachesReleaseObjects) {
      throw new Error("Foundation manifest storage authority must be bucket-only");
    }
  }
}

verifyEcrSigningConfiguration();
verifyReleaseAuthorityRetention();
verifyFoundationApplyBoundary();
verifyFoundationApplyWorkloadPolicy();

const stateOwnership = JSON.parse(
  fs.readFileSync("infra/terraform/foundation/evidence/foundation-state-ownership.json", "utf8"),
);
const checks = Array.isArray(stateOwnership.checks) ? stateOwnership.checks : [];
const failingChecks = checks.filter((check) => check.count !== 0);
if (
  stateOwnership.schemaVersion !== "foundation-state-ownership-v1" ||
  stateOwnership.stateIdentity !== "stark-dev/develop/foundation" ||
  stateOwnership.sourceSha !== process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ||
  stateOwnership.appRuntimeResourcesCreated !== false ||
  failingChecks.length > 0
) {
  throw new Error("Foundation state ownership evidence is invalid.");
}
const evidence = {
  schemaVersion: "foundation-saved-plan-evidence-v1",
  manifestType: "foundation-smoke",
  stateIdentity: "stark-dev/develop/foundation",
  sourceSha: process.env.CODEBUILD_RESOLVED_SOURCE_VERSION,
  appRuntimeResourcesCreated: false,
  evidenceClass: "FoundationStateAbsenceOfAppRuntime",
  stateOwnershipVerified: true,
  releaseAuthorityRetentionProtected: true,
  acceptedMarkerPath: "${local.foundation_accepted_marker_path}",
  stateOwnership,
  checks,
};
fs.writeFileSync(
  "infra/terraform/foundation/evidence/foundation-smoke.json",
  JSON.stringify(evidence, null, 2) + "\\n",
);
NODE
EOT
foundation_accepted_marker_path = "accepted-deployments/stark-dev/develop/foundation"
}
