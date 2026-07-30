output "state_bucket_name" {
  description = "Terraform remote state bucket name for this bootstrap scope."
  value       = aws_s3_bucket.state.bucket
}

output "state_backend_key" {
  description = "Terraform remote state key for this bootstrap scope."
  value       = var.state_backend_key
}

output "state_kms_key_arn" {
  description = "KMS key ARN for Terraform state encryption."
  value       = aws_kms_key.state.arn
}

output "state_kms_alias" {
  description = "KMS alias used by the Terraform backend."
  value       = aws_kms_alias.state.name
}

output "development_pipeline_name" {
  description = "Development saved-plan pipeline name when enabled."
  value       = var.enable_development_pipeline ? aws_codepipeline.development[0].name : null
}

output "development_codeconnection_arn" {
  description = "CodeConnections connection ARN for the development saved-plan pipeline when enabled."
  value       = var.enable_development_pipeline ? aws_codeconnections_connection.source[0].arn : null
}

output "development_github_trigger_role_arn" {
  description = "GitHub OIDC trigger role ARN for the development saved-plan pipeline when enabled."
  value       = var.enable_development_pipeline ? aws_iam_role.github_trigger[0].arn : null
}

output "development_pipeline_artifact_bucket_name" {
  description = "Encrypted pipeline artifact bucket name when enabled."
  value       = var.enable_development_pipeline ? aws_s3_bucket.pipeline_artifacts[0].bucket : null
}

output "development_app_pipeline_name" {
  description = "Development app saved-plan pipeline name when enabled."
  value       = var.enable_development_app_pipeline ? aws_codepipeline.development_app[0].name : null
}

output "development_app_static_fast_pipeline_name" {
  description = "Development app static fast-lane pipeline name when enabled."
  value       = var.enable_development_app_pipeline ? aws_codepipeline.app_static_fast[0].name : null
}

output "development_app_github_trigger_role_arn" {
  description = "GitHub OIDC trigger role ARN for the development app pipeline when enabled."
  value       = var.enable_development_app_pipeline ? aws_iam_role.app_github_trigger[0].arn : null
}

output "development_app_pipeline_artifact_bucket_name" {
  description = "Encrypted app pipeline artifact bucket name when enabled."
  value       = var.enable_development_app_pipeline ? aws_s3_bucket.app_pipeline_artifacts[0].bucket : null
}

output "development_app_release_manifest_bucket_name" {
  description = "Foundation release-manifest bucket name consumed by the development app pipeline when enabled."
  value       = var.enable_development_app_pipeline ? local.app_release_manifest_bucket_name : null
}

output "development_app_state_backend_key" {
  description = "Terraform remote state key for the development app lane."
  value       = local.app_state_backend_key
}

output "development_foundation_pipeline_name" {
  description = "Development foundation saved-plan pipeline name when enabled."
  value       = var.enable_development_foundation_pipeline ? aws_codepipeline.development_foundation[0].name : null
}

output "development_prover_release_pipeline_name" {
  description = "Development prover release pipeline name when enabled."
  value       = var.enable_development_foundation_pipeline ? aws_codepipeline.development_prover_release[0].name : null
}

output "development_toolchain_release_pipeline_name" {
  description = "Development RISC Zero toolchain release candidate and promotion pipeline name when enabled."
  value       = var.enable_development_foundation_pipeline ? aws_codepipeline.development_toolchain_release[0].name : null
}

output "development_foundation_pipeline_artifact_bucket_name" {
  description = "Encrypted foundation pipeline artifact bucket name when enabled."
  value       = var.enable_development_foundation_pipeline ? aws_s3_bucket.foundation_pipeline_artifacts[0].bucket : null
}

output "development_foundation_state_backend_key" {
  description = "Terraform remote state key for the development foundation lane."
  value       = local.foundation_state_backend_key
}
