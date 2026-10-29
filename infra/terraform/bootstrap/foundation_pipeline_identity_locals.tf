locals {
  foundation_pipeline_enabled           = var.enable_development_foundation_pipeline
  foundation_pipeline_identity_approved = !local.foundation_pipeline_enabled || local.pipeline_enabled

  foundation_pipeline_name                 = local.foundation_lane_authority.names.pipeline
  foundation_pipeline_artifact_bucket_name = local.foundation_lane_authority.names.artifactBucket
  foundation_artifact_kms_alias            = local.foundation_lane_authority.names.artifactKmsAlias
  foundation_release_manifest_bucket_name  = local.deployment_shared_names.releaseManifestBucket
  foundation_release_manifest_bucket_arn   = "arn:aws:s3:::${local.foundation_release_manifest_bucket_name}"
  foundation_release_manifest_objects_arn  = "${local.foundation_release_manifest_bucket_arn}/*"
  foundation_risc0_toolchain_ecr_repository_arn = (
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.deployment_shared_names.toolchainRepository}"
  )
  foundation_risc0_toolchain_ecr_repository_name = local.deployment_shared_names.toolchainRepository
  foundation_prover_ecr_repository_arn = (
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.deployment_shared_names.proverRepository}"
  )
  foundation_prover_ecr_repository_name = local.deployment_shared_names.proverRepository
  foundation_ecr_repository_arns = [
    local.foundation_risc0_toolchain_ecr_repository_arn,
    local.foundation_prover_ecr_repository_arn,
  ]
  foundation_prover_candidate_records_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*"
  )
  foundation_prover_promotion_object_arn = "${local.foundation_release_manifest_bucket_arn}/promotions/prover/current.json"
  foundation_toolchain_candidate_records_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*"
  )
  foundation_toolchain_promotion_object_arn = (
    "${local.foundation_release_manifest_bucket_arn}/promotions/toolchain/current.json"
  )
  foundation_ecr_signing_profile_name = local.deployment_shared_names.signerProfile
  foundation_ecr_signing_profile_arn  = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-profiles/${local.foundation_ecr_signing_profile_name}"
  foundation_signing_job_arn_pattern  = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-jobs/*"
  foundation_ecr_signing_profile_arns = [
    local.foundation_ecr_signing_profile_arn,
    "${local.foundation_ecr_signing_profile_arn}/*",
  ]
  foundation_runtime_secret_arns = [
    "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.deployment_shared_names.runtimeSecretReferencePrefix}/*",
  ]
  foundation_runtime_ssm_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.deployment_shared_names.runtimeConfigReferencePrefix}/*",
  ]

  foundation_pipeline_role_name                                        = local.foundation_lane_authority.names.pipelineRole
  foundation_prover_release_candidate_build_role_name                  = local.deployment_shared_names.proverCandidateRole
  foundation_prover_release_toolchain_resolver_build_role_name         = local.deployment_shared_names.proverToolchainResolverRole
  foundation_prover_release_update_accepted_pointer_build_role_name    = local.deployment_shared_names.proverPointerRole
  foundation_toolchain_release_candidate_build_role_name               = local.deployment_shared_names.toolchainCandidateRole
  foundation_toolchain_release_update_accepted_pointer_build_role_name = local.deployment_shared_names.toolchainPointerRole
  foundation_terraform_plan_role_name                                  = local.foundation_lane_authority.names.terraformPlanRole
  foundation_terraform_apply_role_name                                 = local.foundation_lane_authority.names.terraformApplyRole
  foundation_terraform_smoke_role_name                                 = local.foundation_lane_authority.names.terraformSmokeRole
  foundation_terraform_smoke_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_smoke_role_name}"
  )

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

  foundation_terraform_apply_workload_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_terraform_apply_role_name}-workload"
  )

  foundation_terraform_plan_project_name                 = local.foundation_lane_authority.names.terraformPlanProject
  foundation_terraform_apply_project_name                = local.foundation_lane_authority.names.terraformApplyProject
  foundation_smoke_project_name                          = local.foundation_lane_authority.names.smokeProject
  prover_release_pipeline_name                           = local.prover_lane_authority.names.pipeline
  prover_release_toolchain_resolver_project_name         = local.deployment_shared_names.proverToolchainResolverProject
  prover_release_candidate_project_name                  = local.deployment_shared_names.proverCandidateProject
  prover_release_update_accepted_pointer_project_name    = local.deployment_shared_names.proverPointerProject
  toolchain_release_pipeline_name                        = local.toolchain_lane_authority.names.pipeline
  toolchain_release_candidate_project_name               = local.deployment_shared_names.toolchainCandidateProject
  toolchain_release_update_accepted_pointer_project_name = local.deployment_shared_names.toolchainPointerProject
  foundation_routine_codebuild_project_names = [
    local.foundation_terraform_plan_project_name,
    local.foundation_terraform_apply_project_name,
    local.foundation_smoke_project_name,
    local.prover_release_toolchain_resolver_project_name,
    local.prover_release_candidate_project_name,
    local.prover_release_update_accepted_pointer_project_name,
    local.toolchain_release_candidate_project_name,
    local.toolchain_release_update_accepted_pointer_project_name,
  ]
  foundation_active_codebuild_project_names            = local.foundation_routine_codebuild_project_names
  foundation_bootstrap_managed_codebuild_project_names = local.foundation_active_codebuild_project_names
  foundation_routine_codebuild_project_arns = [
    for name in local.foundation_routine_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  foundation_bootstrap_managed_codebuild_project_arns = [
    for name in local.foundation_bootstrap_managed_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  foundation_pipeline_arn        = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.foundation_pipeline_name}"
  prover_release_pipeline_arn    = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.prover_release_pipeline_name}"
  toolchain_release_pipeline_arn = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.toolchain_release_pipeline_name}"
  foundation_source_connection_arns = local.foundation_pipeline_enabled ? [
    aws_codeconnections_connection.source[0].arn,
    replace(aws_codeconnections_connection.source[0].arn, ":codeconnections:", ":codestar-connections:"),
  ] : []
  foundation_bootstrap_managed_codebuild_log_group_arns = [
    for name in local.foundation_codebuild_log_group_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  foundation_routine_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_toolchain_resolver_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_candidate_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_prover_release_update_accepted_pointer_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_toolchain_release_candidate_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_toolchain_release_update_accepted_pointer_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_smoke_role_name}",
  ]
  foundation_bootstrap_managed_role_name_arns = local.foundation_routine_role_name_arns
  foundation_pipeline_role_arn_pattern        = "arn:aws:iam::${var.aws_account_id}:role/*-${var.account_alias}-${var.deployment_environment}-foundation"

  foundation_state_backend_key = local.foundation_lane_authority.backendKey
}
