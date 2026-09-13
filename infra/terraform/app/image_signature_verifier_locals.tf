locals {
  common_tags = {
    Project      = var.project_name
    AccountAlias = var.account_alias
    Environment  = var.deployment_environment
    ManagedBy    = "Terraform"
    StateScope   = var.state_scope
  }

  image_signature_name_prefix        = local.deployment_shared_names.signatureRuntimeNamePrefix
  image_signature_verifier_name      = local.deployment_shared_names.targetLambdaFunctions.imageSignatureVerifier
  image_signature_verifier_role_name = "${local.image_signature_name_prefix}-image-signature-verifier-role"

  prover_image_uri_pattern             = "^${var.aws_account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com\\/[A-Za-z0-9._\\/-]+@sha256:[0-9a-f]{64}$"
  prover_image_repo_uri                = split("@", var.prover_image_uri)[0]
  prover_image_repo_parts              = split("/", local.prover_image_repo_uri)
  prover_image_repository              = join("/", slice(local.prover_image_repo_parts, 1, length(local.prover_image_repo_parts)))
  prover_image_digest                  = split("@", var.prover_image_uri)[1]
  prover_image_repository_arn          = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.prover_image_repository}"
  image_signature_signing_profile_name = local.deployment_shared_names.signerProfile
  image_signature_signing_profile_arn  = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-profiles/${local.image_signature_signing_profile_name}"
  image_signature_signing_job_arn_pattern = (
    "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-jobs/*"
  )
}
