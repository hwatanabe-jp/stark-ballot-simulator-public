locals {
  app_pipeline_identity_approved = !local.app_pipeline_enabled || local.pipeline_enabled

  app_pipeline_execution_artifact_bucket_name = local.app_lane_authority.names.artifactBucket
  app_artifact_bucket_names_are_distinct = length(toset(compact([
    local.app_retained_artifact_bucket_name,
    local.app_pipeline_execution_artifact_bucket_name,
  ]))) == 2
  app_release_manifest_bucket_name = local.deployment_shared_names.releaseManifestBucket
  app_artifact_kms_alias           = local.app_lane_authority.names.artifactKmsAlias
  app_toolchain_promotion_object_arn = (
    "${local.app_release_manifest_bucket_arn}/promotions/toolchain/current.json"
  )
  app_prover_promotion_object_arn = (
    "${local.app_release_manifest_bucket_arn}/promotions/prover/current.json"
  )
  app_toolchain_candidate_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*"
  )
  app_prover_candidate_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*"
  )
  app_terraform_smoke_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_smoke_role_name}"
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
  app_release_image_repository_arns = [
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.app_runtime_name_prefix}/prover",
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.app_runtime_name_prefix}/risc0-toolchain",
  ]
  app_full_pipeline_codebuild_project_names = [

    local.app_terraform_plan_project_name,
    local.app_terraform_apply_project_name,
    local.app_static_deploy_project_name,
    local.app_smoke_project_name,
    local.foundation_app_status_publisher_project_name,
  ]

  app_full_pipeline_codebuild_project_arns = [
    for name in local.app_full_pipeline_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  app_pipeline_execution_artifact_bucket_arn = (
    "arn:aws:s3:::${local.app_pipeline_execution_artifact_bucket_name}"
  )
  app_retained_lambda_artifact_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*"
  )
  app_retained_image_signature_verifier_package_objects_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*/image-signature-verifier.zip"
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
  app_release_manifest_bucket_arn = "arn:aws:s3:::${local.app_release_manifest_bucket_name}"
  app_source_connection_arns = local.app_pipeline_enabled ? [
    aws_codeconnections_connection.source[0].arn,
    replace(aws_codeconnections_connection.source[0].arn, ":codeconnections:", ":codestar-connections:"),
  ] : []
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
}
