locals {
  expected_state_backend_key = "${var.project_name}/${var.account_alias}/${var.deployment_environment}/${var.state_scope}/terraform.tfstate"
  name_prefix                = "${var.project_name}-${var.account_alias}-${var.deployment_environment}"

  common_tags = {
    Project               = var.project_name
    AccountAlias          = var.account_alias
    DeploymentEnvironment = var.deployment_environment
    StateScope            = var.state_scope
    ManagedBy             = "terraform"
  }

  toolchain_repository_name     = "${local.name_prefix}/risc0-toolchain"
  prover_repository_name        = "${local.name_prefix}/prover"
  ecr_signing_profile_name      = "${replace(local.name_prefix, "-", "_")}_ecr"
  manifest_bucket_name          = coalesce(var.release_manifest_bucket_name, "${local.name_prefix}-release-manifests")
  foundation_app_networking_key = "channels/develop/foundation/app-networking.json"
  foundation_app_networking_object_arn = (
    "arn:aws:s3:::${local.manifest_bucket_name}/${local.foundation_app_networking_key}"
  )
  foundation_image_signing_authority_prefix = "artifacts/foundation/image-signing"
  foundation_image_signing_authority_objects_arn = (
    "arn:aws:s3:::${local.manifest_bucket_name}/${local.foundation_image_signing_authority_prefix}/*"
  )
  foundation_app_networking_publisher_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/stark-ballot-sim-tf-smoke-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  foundation_image_signing_authority_publisher_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/stark-ballot-sim-tf-smoke-${var.account_alias}-${var.deployment_environment}-foundation"
  )
  ecr_signing_repository_filters = [
    local.prover_repository_name,
  ]

  runtime_reference_names = {
    SESSION_CAPABILITY_SECRET_REF      = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/session-capability-secret"
    VOTE_SECRET_ENCRYPTION_KEY_REF     = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/vote-secret-encryption-key"
    TURNSTILE_SECRET_KEY_REF           = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/turnstile-secret-key"
    EXPECTED_ORIGIN_VERIFY_HEADER_REF  = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/expected-origin-verify-header"
    LOG_IP_HASH_SALT_REF               = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/log-ip-hash-salt"
    SESSION_CAPABILITY_TTL_SECONDS_REF = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/config/session-capability-ttl-seconds"
    VITE_TURNSTILE_SITE_KEY_REF        = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/config/vite-turnstile-site-key"
  }
}
