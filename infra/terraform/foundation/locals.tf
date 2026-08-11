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
  foundation_app_networking_publisher_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_lane_authority.names.terraformSmokeRole}"
  )
  foundation_image_signing_authority_publisher_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_lane_authority.names.terraformSmokeRole}"
  )
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
