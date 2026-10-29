locals {
  expected_state_backend_key = local.foundation_lane_authority.backendKey
  name_prefix                = local.deployment_shared_names.runtimeNamePrefix

  common_tags = {
    Project               = var.project_name
    AccountAlias          = var.account_alias
    DeploymentEnvironment = var.deployment_environment
    StateScope            = var.state_scope
    ManagedBy             = "terraform"
  }

  toolchain_repository_name = local.deployment_shared_names.toolchainRepository
  prover_repository_name    = local.deployment_shared_names.proverRepository
  ecr_signing_profile_name  = local.deployment_shared_names.signerProfile
  manifest_bucket_name      = local.deployment_shared_names.releaseManifestBucket
  release_authority_publisher_restrictions = {
    toolchain_candidates = {
      sid                 = "DenyToolchainCandidatesWritesOutsidePublisher"
      object_arns         = ["arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*"]
      publisher_role_arns = ["arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainCandidateRole}"]
    }
    toolchain_promotion = {
      sid                 = "DenyToolchainPromotionWritesOutsidePublisher"
      object_arns         = ["arn:aws:s3:::${local.manifest_bucket_name}/promotions/toolchain/current.json"]
      publisher_role_arns = ["arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainPointerRole}"]
    }
    prover_candidates = {
      sid                 = "DenyProverCandidatesWritesOutsidePublisher"
      object_arns         = ["arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*"]
      publisher_role_arns = ["arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverCandidateRole}"]
    }
    prover_promotion = {
      sid                 = "DenyProverPromotionWritesOutsidePublisher"
      object_arns         = ["arn:aws:s3:::${local.manifest_bucket_name}/promotions/prover/current.json"]
      publisher_role_arns = ["arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverPointerRole}"]
    }
  }
  ecr_signing_repository_filters = [
    local.prover_repository_name,
  ]

  runtime_reference_names = {
    SESSION_CAPABILITY_SECRET_REF      = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/session-capability-secret"
    VOTE_SECRET_ENCRYPTION_KEY_REF     = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/vote-secret-encryption-key"
    TURNSTILE_SECRET_KEY_REF           = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/turnstile-secret-key"
    EXPECTED_ORIGIN_VERIFY_HEADER_REF  = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/expected-origin-verify-header"
    LOG_IP_HASH_SALT_REF               = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/log-ip-hash-salt"
    SESSION_CAPABILITY_TTL_SECONDS_REF = "${local.deployment_shared_names.runtimeConfigReferencePrefix}/session-capability-ttl-seconds"
    VITE_TURNSTILE_SITE_KEY_REF        = "${local.deployment_shared_names.runtimeConfigReferencePrefix}/vite-turnstile-site-key"
  }
}
