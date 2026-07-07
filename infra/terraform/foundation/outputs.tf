output "foundation_state_identity" {
  description = "Foundation Terraform state identity."
  value       = "${var.account_alias}/${var.deployment_environment}/${var.state_scope}"
}

output "foundation_state_backend_key" {
  description = "Expected backend key for foundation state."
  value       = local.expected_state_backend_key
}

output "target_image_authority" {
  description = "Target image authority repository names and policy summary."
  value = {
    toolchain_repository_name = aws_ecr_repository.toolchain.name
    toolchain_repository_url  = aws_ecr_repository.toolchain.repository_url
    prover_repository_name    = aws_ecr_repository.prover.name
    prover_repository_url     = aws_ecr_repository.prover.repository_url
    tag_mutability            = "IMMUTABLE"
    scan_on_push              = true
    signing_status_required   = "COMPLETE"
    signing_profile_name      = aws_signer_signing_profile.ecr.name
    signing_profile_arn       = aws_signer_signing_profile.ecr.arn
    signing_repository_filters = [
      for repository_name in local.ecr_signing_repository_filters : {
        filter     = repository_name
        filterType = "WILDCARD_MATCH"
      }
    ]
    retention_policy = "candidate-prefix-latest-200-images"
  }
}

output "release_manifest_authority" {
  description = "Encrypted versioned S3 authority for immutable release manifests."
  value = {
    bucket_name        = aws_s3_bucket.release_manifests.bucket
    versioning_enabled = true
    encryption         = "AES256"
    required_inputs    = ["ReleaseManifestKey", "ReleaseManifestVersionId", "ReleaseManifestSha256"]
  }
}

output "runtime_reference_names" {
  description = "Non-secret target runtime reference names created or reserved by foundation."
  value       = local.runtime_reference_names
}

output "prover_networking" {
  description = "Foundation-owned prover networking inputs for the app handoff."
  value = {
    vpc_id                  = aws_vpc.prover.id
    prover_subnet_ids       = aws_subnet.prover[*].id
    prover_security_groups  = [aws_security_group.prover.id]
    network_authority       = "foundation-owned"
    public_subnet_exception = "accepted-for-develop-prover-egress"
  }
}

output "public_hostname_disposition" {
  description = "Plan 02 public-hostname disposition carried into Plan 03."
  value = {
    disposition = var.public_hostname_disposition
  }
}
