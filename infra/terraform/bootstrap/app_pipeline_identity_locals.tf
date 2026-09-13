locals {
  protected_production_app_source_branch          = "main"
  protected_production_app_account_alias          = "stark-prod"
  protected_production_app_deployment_environment = "main"
  protected_production_app_state_scope            = "app"
  protected_production_app_aws_account_id         = coalesce(var.protected_production_aws_account_id, "999999999999")
  app_pipeline_identity_approved = (
    var.enable_development_app_pipeline == false
    || (
      var.enable_development_pipeline
      && var.account_alias == local.deployment_target.accountLabel
      && var.deployment_environment == local.deployment_target.environmentId
      && var.state_scope == local.bootstrap_lane_authority.scope
      && var.source_branch == local.deployment_target.sourceBranch
    )
  )

  app_pipeline_execution_artifact_bucket_name    = local.app_lane_authority.names.artifactBucket
  app_static_fast_execution_artifact_bucket_name = local.app_static_fast_available ? local.static_fast_lane_authority.names.artifactBucket : null
  app_artifact_bucket_names_are_distinct = length(toset(compact([
    local.app_retained_artifact_bucket_name,
    local.app_pipeline_execution_artifact_bucket_name,
    local.app_static_fast_execution_artifact_bucket_name,
  ]))) == (local.app_static_fast_available ? 3 : 2)
  app_release_manifest_bucket_name = local.deployment_shared_names.releaseManifestBucket
  app_artifact_kms_alias           = local.app_lane_authority.names.artifactKmsAlias
  app_artifact_kms_alias_arn       = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.app_artifact_kms_alias}"
  app_toolchain_accepted_pointer_object_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainAcceptedPointerKey}"
  )
  app_prover_accepted_pointer_object_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.proverAcceptedPointerKey}"
  )
  app_foundation_acceptance_pointer_object_arn  = local.terraform_foundation_acceptance_pointer_object_arn
  app_foundation_acceptance_records_objects_arn = local.terraform_foundation_acceptance_object_arn_pattern
  app_toolchain_candidate_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*"
  )
  app_toolchain_release_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/releases/*"
  )
  app_prover_candidate_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*"
  )
  app_prover_release_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/releases/*"
  )
  app_execution_authority_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${local.app_execution_authority_role_name}"
  app_terraform_smoke_role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_smoke_role_name}"
  app_target_application_lambda_names = [
    local.deployment_shared_names.targetLambdaFunctions.publicApi,
    local.deployment_shared_names.targetLambdaFunctions.finalizationWriter,
    local.deployment_shared_names.targetLambdaFunctions.proofDispatcher,
    local.deployment_shared_names.targetLambdaFunctions.verificationWorker,
    local.deployment_shared_names.targetLambdaFunctions.semaphoreJanitor,
  ]
  app_target_lambda_names = concat(local.app_target_application_lambda_names, [
    local.app_signature_verifier_lambda_name,
  ])
  app_target_application_lambda_arns = [
    for name in local.app_target_application_lambda_names :
    "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${name}"
  ]
  app_target_lambda_arns = [
    for name in local.app_target_lambda_names :
    "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${name}"
  ]
  app_target_async_queue_arn_pattern = (
    "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.app_runtime_name_prefix}-*"
  )
  app_data_kms_alias     = "alias/${local.app_runtime_name_prefix}-app-data"
  app_data_kms_alias_arn = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.app_data_kms_alias}"
  app_operator_gate_kms_alias_arn_pattern = (
    "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:alias/${local.app_runtime_name_prefix}-operator-gate-*"
  )
  app_dynamodb_table_names = [
    "${local.app_runtime_name_prefix}-sessions",
    "${local.app_runtime_name_prefix}-votes",
    "${local.app_runtime_name_prefix}-rate-limit-events",
    "${local.app_runtime_name_prefix}-rate-limit-counters",
    "${local.app_runtime_name_prefix}-prover-semaphore",
  ]
  app_dynamodb_table_arns = [
    for name in local.app_dynamodb_table_names :
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${name}"
  ]
  app_dynamodb_index_arns = [
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-votes/index/*",
  ]
  app_dynamodb_recovery_table_arn_patterns = [
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-sessions-recovery-*",
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-votes-recovery-*",
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-votes-recovery-*/index/*",
  ]
  app_dynamodb_recovery_table_name_patterns = [
    "${local.app_runtime_name_prefix}-sessions-recovery-*",
    "${local.app_runtime_name_prefix}-votes-recovery-*",
  ]
  app_release_image_repository_arns = [
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.app_runtime_name_prefix}/prover",
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.app_runtime_name_prefix}/risc0-toolchain",
  ]
  app_browser_public_config_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.deployment_shared_names.runtimeConfigReferencePrefix}/vite-turnstile-site-key",
  ]
  app_plan_managed_policy_arns = [
    local.app_codebuild_common_policy_arn,
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_plan_runtime_policy_name}",
  ]
  app_full_pipeline_codebuild_project_names = [
    local.app_execution_authority_project_name,
    local.app_terraform_plan_project_name,
    local.app_terraform_apply_project_name,
    local.app_signature_preflight_plan_project_name,
    local.app_signature_preflight_apply_project_name,
    local.app_signature_preflight_invoke_project_name,
    local.app_static_deploy_project_name,
    local.app_smoke_project_name,
    local.foundation_app_status_publisher_project_name,
  ]
  app_static_fast_codebuild_project_names = compact([
    local.app_static_fast_available ? local.app_static_fast_gate_project_name : null,
    local.app_static_fast_available ? local.app_static_fast_static_deploy_project_name : null,
    local.app_static_fast_available ? local.app_static_fast_smoke_project_name : null,
  ])

  app_full_pipeline_codebuild_project_arns = [
    for name in local.app_full_pipeline_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  app_static_fast_codebuild_project_arns = [
    for name in local.app_static_fast_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  app_pipeline_action_arn_pattern = "${local.app_pipeline_arn}*"
  app_static_fast_action_arn_pattern = (
    local.app_static_fast_available ? "${local.app_static_fast_pipeline_arn}*" : null
  )
  app_pipeline_execution_artifact_bucket_arn = (
    "arn:aws:s3:::${local.app_pipeline_execution_artifact_bucket_name}"
  )
  app_static_fast_execution_artifact_bucket_arn = (
    local.app_static_fast_available ? "arn:aws:s3:::${local.app_static_fast_execution_artifact_bucket_name}" : null
  )
  app_retained_accepted_deployment_pointer_object_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPointerKey}"
  )
  app_retained_acceptance_record_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/acceptances/*"
  )
  app_retained_acceptance_attempt_evidence_object_arns = [
    for basename in ["deployment-identity.json", "apply-outputs.json", "app-smoke-report.json"] :
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*/attempts/*/${basename}"
  ]
  app_retained_approval_evidence_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*"
  )
  app_retained_lambda_artifact_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*"
  )
  app_retained_image_signature_verifier_package_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*/image-signature-verifier.zip"
  )
  app_retained_recovery_manifest_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.recoveryManifestPrefix}/*"
  )
  app_operator_role_arn_pattern = (
    "arn:aws:iam::${var.aws_account_id}:role/aws-reserved/sso.amazonaws.com/${var.aws_region}/AWSReservedSSO_${local.deployment_target.operatorPermissionSetName}_*"
  )
  app_retained_signature_preflight_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.signaturePreflightPrefix}/*"
  )
  app_retained_static_frontend_artifact_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.staticFrontendArtifactPrefix}/*"
  )
  app_plan_codebuild_cache_prefixes = [
    "codebuild-cache/${local.app_terraform_plan_project_name}",
  ]
  app_plan_codebuild_cache_object_arns = [
    for prefix in local.app_plan_codebuild_cache_prefixes :
    "${local.app_retained_artifact_bucket_arn}/${prefix}/*"
  ]
  app_signature_preflight_alias_arn = "${local.app_signature_verifier_lambda_arn}:preflight"
  app_signature_preflight_evidence_object_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.signaturePreflightPrefix}/executions/*/attempts/*/verification.json"
  )
  app_release_manifest_bucket_arn = "arn:aws:s3:::${local.app_release_manifest_bucket_name}"
  app_source_connection_arns = local.app_pipeline_enabled ? [
    aws_codeconnections_connection.source[0].arn,
    replace(aws_codeconnections_connection.source[0].arn, ":codeconnections:", ":codestar-connections:"),
  ] : []
  app_codebuild_project_arn_pattern = (
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_pipeline_name}-*"
  )
  app_codebuild_log_group_arn_pattern = (
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.app_pipeline_name}-*"
  )
  app_pipeline_role_arn_patterns = [
    local.app_acceptance_publisher_role_arn,
    local.app_execution_authority_role_arn,
    local.foundation_app_status_publisher_role_arn,
    "arn:aws:iam::${var.aws_account_id}:role/${var.project_name}-*-${var.account_alias}-${var.deployment_environment}-app",
    "arn:aws:iam::${var.aws_account_id}:role/stark-ballot-sim-*-${var.account_alias}-${var.deployment_environment}-app",
    "arn:aws:iam::${var.aws_account_id}:role/sbs-*-${var.account_alias}-${var.deployment_environment}-app",
  ]
  app_pipeline_role_arn_pattern = "arn:aws:iam::${var.aws_account_id}:role/*-${var.account_alias}-${var.deployment_environment}-app"

  app_backend_config_content = join("\n", [
    "bucket       = \"${aws_s3_bucket.state.bucket}\"",
    "key          = \"${local.app_lane_authority.backendKey}\"",
    "region       = \"${local.deployment_target.region}\"",
    "encrypt      = true",
    "kms_key_id   = \"${var.state_kms_alias}\"",
    "use_lockfile = true",
  ])
  app_public_hostname_disposition = var.development_app_cloudfront_acm_certificate_arn == null ? "generated-cloudfront-hostname" : "external-dns-acm"
  app_pipeline_tfvars_content = join("\n", [
    "account_alias          = \"${local.deployment_target.accountLabel}\"",
    "aws_account_id         = \"${local.deployment_target.accountId}\"",
    "aws_region             = \"${local.deployment_target.region}\"",
    var.development_app_cloudfront_acm_certificate_arn == null ? "cloudfront_acm_certificate_arn = null" : "cloudfront_acm_certificate_arn = \"${var.development_app_cloudfront_acm_certificate_arn}\"",
    "deployment_environment = \"${local.deployment_target.environmentId}\"",
    "develop_operator_gate_enabled = ${local.deployment_target.environmentId == "develop"}",
    "image_signature_verifier_permissions_boundary_arn = \"${local.app_signature_verifier_execution_boundary_policy_arn}\"",
    "project_name           = \"${local.deployment_target.projectId}\"",
    "public_hostname             = \"${var.development_app_public_hostname}\"",
    "verifier_public_base_url    = \"https://${var.development_app_public_hostname}\"",
    "public_hostname_disposition = \"${local.app_public_hostname_disposition}\"",
    "state_backend_key      = \"${local.app_lane_authority.backendKey}\"",
    "state_scope            = \"${local.app_lane_authority.scope}\"",
  ])
  protected_production_app_state_backend_key = (
    "${var.project_name}/${local.protected_production_app_account_alias}/${local.protected_production_app_deployment_environment}/${local.protected_production_app_state_scope}/terraform.tfstate"
  )
  protected_production_app_backend_config_content = join("\n", [
    "bucket       = \"${aws_s3_bucket.state.bucket}\"",
    "key          = \"${local.protected_production_app_state_backend_key}\"",
    "region       = \"${var.aws_region}\"",
    "encrypt      = true",
    "kms_key_id   = \"${var.state_kms_alias}\"",
    "use_lockfile = true",
  ])
  protected_production_app_pipeline_tfvars_content = join("\n", [
    "account_alias          = \"${local.protected_production_app_account_alias}\"",
    "aws_account_id         = \"${local.protected_production_app_aws_account_id}\"",
    "aws_region             = \"${var.aws_region}\"",
    "deployment_environment = \"${local.protected_production_app_deployment_environment}\"",
    "develop_operator_gate_enabled = false",
    "project_name           = \"${var.project_name}\"",
    "image_signature_verifier_permissions_boundary_arn = \"arn:aws:iam::${local.protected_production_app_aws_account_id}:policy/${var.project_name}-image-signature-verifier-boundary-${local.protected_production_app_account_alias}-${local.protected_production_app_deployment_environment}\"",
    "state_backend_key      = \"${local.protected_production_app_state_backend_key}\"",
    "state_scope            = \"${local.protected_production_app_state_scope}\"",
  ])
  protected_production_app_lane_contract_content = join("\n", [
    "source_branch          = \"main\"",
    "account_alias          = \"stark-prod\"",
    "aws_account_id         = \"${local.protected_production_app_aws_account_id}\"",
    "deployment_environment = \"main\"",
    "state_scope            = \"app\"",
  ])
  protected_production_app_guard_env_prefix = (
    "TERRAFORM_AWS_ACCOUNT_ID_STARK_PROD=${local.protected_production_app_aws_account_id} TERRAFORM_WORKING_DIR=infra/terraform/app TERRAFORM_APP_BACKEND_BUCKET=${aws_s3_bucket.state.bucket} TERRAFORM_APP_BACKEND_REGION=${var.aws_region} TERRAFORM_APP_BACKEND_KMS_KEY_ID=${var.state_kms_alias}"
  )
  protected_production_app_guard_init_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app init -backend-config=backend.pipeline.hcl"
  )
  protected_production_app_guard_validate_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app validate"
  )
  protected_production_app_guard_plan_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app plan -out=tfplan -var-file=pipeline.auto.tfvars"
  )
  protected_production_app_guard_apply_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app apply -auto-approve tfplan"
  )
  protected_production_app_guard_smoke_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app smoke"
  )
}
