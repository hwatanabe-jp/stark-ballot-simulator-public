locals {
  foundation_pipeline_enabled = var.enable_development_foundation_pipeline
  foundation_pipeline_identity_approved = (
    var.enable_development_foundation_pipeline == false
    || (
      var.enable_development_pipeline
      && var.account_alias == local.deployment_target.accountLabel
      && var.deployment_environment == local.deployment_target.environmentId
      && var.state_scope == local.bootstrap_lane_authority.scope
      && var.source_branch == local.deployment_target.sourceBranch
    )
  )

  foundation_pipeline_name                 = local.foundation_lane_authority.names.pipeline
  foundation_pipeline_artifact_bucket_name = local.foundation_lane_authority.names.artifactBucket
  foundation_artifact_kms_alias            = local.foundation_lane_authority.names.artifactKmsAlias
  foundation_artifact_kms_alias_arn        = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.foundation_artifact_kms_alias}"
  foundation_runtime_name_prefix           = local.deployment_shared_names.runtimeNamePrefix
  foundation_release_manifest_bucket_name  = local.deployment_shared_names.releaseManifestBucket
  foundation_release_manifest_bucket_arn   = "arn:aws:s3:::${local.foundation_release_manifest_bucket_name}"
  foundation_release_manifest_objects_arn  = "${local.foundation_release_manifest_bucket_arn}/*"
  foundation_app_networking_key            = local.deployment_shared_names.foundationAppNetworkingKey
  foundation_app_networking_object_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.foundation_app_networking_key}"
  )
  foundation_image_signing_authority_prefix = local.deployment_shared_names.foundationSigningAuthorityPrefix
  foundation_image_signing_authority_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.foundation_image_signing_authority_prefix}/*"
  )
  foundation_risc0_toolchain_ecr_repository_arn = (
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.deployment_shared_names.toolchainRepository}"
  )
  foundation_risc0_toolchain_ecr_repository_name = local.deployment_shared_names.toolchainRepository
  foundation_prover_ecr_repository_arn = (
    "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.deployment_shared_names.proverRepository}"
  )
  foundation_ecr_repository_arns = [
    local.foundation_risc0_toolchain_ecr_repository_arn,
    local.foundation_prover_ecr_repository_arn,
  ]
  foundation_ecr_retention_function_name  = local.deployment_shared_names.ecrRetentionFunction
  foundation_ecr_retention_function_arn   = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.foundation_ecr_retention_function_name}"
  foundation_ecr_retention_log_group_name = local.deployment_shared_names.ecrRetentionLogGroup
  foundation_ecr_retention_log_group_arn  = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${local.foundation_ecr_retention_log_group_name}"
  foundation_ecr_retention_role_name      = local.deployment_shared_names.ecrRetentionRole
  foundation_ecr_retention_role_arn       = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_ecr_retention_role_name}"
  foundation_ecr_retention_schedule_name  = local.deployment_shared_names.ecrRetentionSchedule
  foundation_ecr_retention_schedule_arn   = "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.foundation_ecr_retention_schedule_name}"
  foundation_ecr_retention_pipeline_arns = [
    local.app_pipeline_arn,
    local.foundation_pipeline_arn,
    local.prover_release_pipeline_arn,
    local.toolchain_release_pipeline_arn,
  ]
  foundation_ecr_retention_state_machine_arn = (
    "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.deployment_shared_names.finalizationStateMachine}"
  )
  foundation_ecr_retention_ecs_cluster_arn = (
    "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/${local.deployment_shared_names.proverEcsCluster}"
  )
  foundation_ecr_retention_app_authority_bucket_arn = (
    "arn:aws:s3:::${local.deployment_shared_names.appRetainedArtifactBucket}"
  )
  foundation_ecr_retention_app_authority_object_arns = [
    "${local.foundation_ecr_retention_app_authority_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPointerKey}",
    "${local.foundation_ecr_retention_app_authority_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*",
  ]
  foundation_ecr_retention_release_authority_object_arns = [
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainAcceptedPointerKey}",
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.proverAcceptedPointerKey}",
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/*",
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/*",
  ]
  foundation_prover_release_records_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/*"
  )
  foundation_prover_accepted_pointer_object_arn = "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.proverAcceptedPointerKey}"
  foundation_toolchain_artifact_records_objects_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/*"
  )
  foundation_toolchain_accepted_pointer_object_arn = (
    "${local.foundation_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainAcceptedPointerKey}"
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
  foundation_image_signing_authority_resolver_build_role_name          = local.deployment_shared_names.foundationSigningResolverRole
  foundation_prover_release_candidate_build_role_name                  = local.deployment_shared_names.proverCandidateRole
  foundation_prover_release_toolchain_resolver_build_role_name         = local.deployment_shared_names.proverToolchainResolverRole
  foundation_prover_release_update_accepted_pointer_build_role_name    = local.deployment_shared_names.proverPointerRole
  foundation_toolchain_release_candidate_build_role_name               = local.deployment_shared_names.toolchainCandidateRole
  foundation_toolchain_release_update_accepted_pointer_build_role_name = local.deployment_shared_names.toolchainPointerRole
  foundation_terraform_plan_role_name                                  = local.foundation_lane_authority.names.terraformPlanRole
  foundation_terraform_apply_role_name                                 = local.foundation_lane_authority.names.terraformApplyRole
  foundation_terraform_smoke_role_name                                 = local.foundation_lane_authority.names.terraformSmokeRole

  foundation_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-foundation-deploy-boundary-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_apply_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-foundation-apply-deploy-boundary-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_smoke_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-foundation-smoke-deploy-boundary-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_ecr_retention_boundary_policy_name = (
    local.deployment_shared_names.ecrRetentionPermissionsBoundary
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
  foundation_ecr_retention_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.foundation_ecr_retention_boundary_policy_name}"
  )
  foundation_deploy_permissions_boundary_policy_arns = [
    local.foundation_deploy_permissions_boundary_policy_arn,
    local.foundation_apply_deploy_permissions_boundary_policy_arn,
    local.foundation_smoke_deploy_permissions_boundary_policy_arn,
    local.foundation_ecr_retention_boundary_policy_arn,
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

  foundation_validate_project_name                         = local.foundation_lane_authority.names.validateProject
  foundation_terraform_plan_project_name                   = local.foundation_lane_authority.names.terraformPlanProject
  foundation_terraform_apply_project_name                  = local.foundation_lane_authority.names.terraformApplyProject
  foundation_smoke_project_name                            = local.foundation_lane_authority.names.smokeProject
  foundation_image_signing_authority_resolver_project_name = local.deployment_shared_names.foundationSigningResolverProject
  foundation_image_signing_authority_resolver_project_arn = (
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.foundation_image_signing_authority_resolver_project_name}"
  )
  prover_release_pipeline_name                           = local.prover_lane_authority.names.pipeline
  prover_release_toolchain_resolver_project_name         = local.deployment_shared_names.proverToolchainResolverProject
  prover_release_candidate_project_name                  = local.deployment_shared_names.proverCandidateProject
  prover_release_update_accepted_pointer_project_name    = local.deployment_shared_names.proverPointerProject
  toolchain_release_pipeline_name                        = local.toolchain_lane_authority.names.pipeline
  toolchain_release_candidate_project_name               = local.deployment_shared_names.toolchainCandidateProject
  toolchain_release_update_accepted_pointer_project_name = local.deployment_shared_names.toolchainPointerProject
  foundation_routine_codebuild_project_names = [
    local.foundation_validate_project_name,
    local.foundation_terraform_plan_project_name,
    local.foundation_terraform_apply_project_name,
    local.foundation_smoke_project_name,
    local.foundation_image_signing_authority_resolver_project_name,
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
  foundation_pipeline_arn                = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.foundation_pipeline_name}"
  prover_release_pipeline_arn            = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.prover_release_pipeline_name}"
  foundation_pipeline_action_arn_pattern = "${local.foundation_pipeline_arn}*"
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
  foundation_bootstrap_managed_codebuild_log_group_arns = [
    for name in local.foundation_bootstrap_managed_codebuild_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  foundation_bootstrap_managed_codebuild_log_group_arn_patterns = [
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.foundation_pipeline_name}-*",
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.foundation_image_signing_authority_resolver_project_name}",
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.prover_release_pipeline_name}-*",
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.toolchain_release_pipeline_name}-*",
  ]
  foundation_bootstrap_managed_codebuild_log_group_resource_arn_patterns = concat(
    local.foundation_bootstrap_managed_codebuild_log_group_arn_patterns,
    [
      for arn in local.foundation_bootstrap_managed_codebuild_log_group_arn_patterns :
      "${arn}:*"
    ],
  )
  foundation_routine_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_image_signing_authority_resolver_build_role_name}",
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
  foundation_bootstrap_managed_role_arn_patterns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_lane_authority.names.pipelineRole}",
    "arn:aws:iam::${var.aws_account_id}:role/sbs-*-${var.account_alias}-${var.deployment_environment}",
    "arn:aws:iam::${var.aws_account_id}:role/stark-ballot-sim-tf-*-${var.account_alias}-${var.deployment_environment}-foundation",
    "arn:aws:iam::${var.aws_account_id}:role/${var.project_name}-release-candidate-build-${var.account_alias}-${var.deployment_environment}",
  ]
  foundation_pipeline_role_arn_pattern = "arn:aws:iam::${var.aws_account_id}:role/*-${var.account_alias}-${var.deployment_environment}-foundation"

  foundation_state_backend_key = local.foundation_lane_authority.backendKey
}
