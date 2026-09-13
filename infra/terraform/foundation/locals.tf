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

  toolchain_repository_name     = local.deployment_shared_names.toolchainRepository
  prover_repository_name        = local.deployment_shared_names.proverRepository
  ecr_signing_profile_name      = local.deployment_shared_names.signerProfile
  manifest_bucket_name          = local.deployment_shared_names.releaseManifestBucket
  foundation_app_networking_key = local.deployment_shared_names.foundationAppNetworkingKey
  foundation_app_networking_object_arn = (
    "arn:aws:s3:::${local.manifest_bucket_name}/${local.foundation_app_networking_key}"
  )
  foundation_image_signing_authority_prefix = local.deployment_shared_names.foundationSigningAuthorityPrefix
  foundation_image_signing_authority_objects_arn = (
    "arn:aws:s3:::${local.manifest_bucket_name}/${local.foundation_image_signing_authority_prefix}/*"
  )
  release_authority_publisher_restrictions = {
    toolchain_candidates = {
      sid = "DenyToolchainCandidateWritesOutsidePublisher"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainCandidateRole}",
      ]
    }
    toolchain_releases = {
      sid = "DenyToolchainReleaseWritesOutsidePublisher"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.toolchainArtifactPrefix}/releases/*",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainPointerRole}",
      ]
    }
    prover_candidates = {
      sid = "DenyProverCandidateWritesOutsidePublisher"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverCandidateRole}",
      ]
    }
    prover_releases = {
      sid = "DenyProverReleaseWritesOutsidePublisher"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.proverReleasePrefix}/releases/*",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverPointerRole}",
      ]
    }
    candidate_records = {
      sid = "DenyCandidateRecordWritesOutsidePublishers"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/candidates/*",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainCandidateRole}",
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverCandidateRole}",
      ]
    }
    promotion_records = {
      sid = "DenyPromotionRecordWritesOutsidePublishers"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/promotions/*",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainPointerRole}",
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverPointerRole}",
      ]
    }
    toolchain_pointer = {
      sid = "DenyToolchainPointerWritesOutsidePublisher"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.toolchainAcceptedPointerKey}",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.toolchainPointerRole}",
      ]
    }
    prover_pointer = {
      sid = "DenyProverPointerWritesOutsidePublisher"
      object_arns = [
        "arn:aws:s3:::${local.manifest_bucket_name}/${local.deployment_shared_names.proverAcceptedPointerKey}",
      ]
      publisher_role_arns = [
        "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.proverPointerRole}",
      ]
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
