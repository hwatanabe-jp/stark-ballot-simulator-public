output "development_pipeline_name" {
  description = "Development saved-plan pipeline name when enabled."
  value       = var.enable_development_pipeline ? aws_codepipeline.development[0].name : null
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
  value       = local.app_static_fast_enabled ? aws_codepipeline.app_static_fast[0].name : null
}

output "development_app_github_trigger_role_arn" {
  description = "GitHub OIDC trigger role ARN for the development app pipeline when enabled."
  value       = var.enable_development_app_pipeline ? aws_iam_role.app_github_trigger[0].arn : null
}

output "development_app_retained_artifact_bucket_name" {
  description = "Encrypted retained App authority and build-cache bucket name when enabled."
  value       = var.enable_development_app_pipeline ? aws_s3_bucket.app_pipeline_artifacts[0].bucket : null
}

output "development_app_pipeline_execution_artifact_bucket_name" {
  description = "Encrypted full App CodePipeline execution artifact bucket name when enabled."
  value       = var.enable_development_app_pipeline ? aws_s3_bucket.app_pipeline_execution_artifacts[0].bucket : null
}

output "development_app_static_fast_execution_artifact_bucket_name" {
  description = "Encrypted static-fast CodePipeline execution artifact bucket name when enabled."
  value       = local.app_static_fast_enabled ? aws_s3_bucket.app_static_fast_execution_artifacts[0].bucket : null
}

output "development_app_release_manifest_bucket_name" {
  description = "Foundation release-manifest bucket name consumed by the development app pipeline when enabled."
  value       = var.enable_development_app_pipeline ? local.app_release_manifest_bucket_name : null
}

output "development_app_state_backend_key" {
  description = "Terraform remote state key for the development app lane."
  value       = local.app_state_backend_key
}

output "terraform_drift_report_prefix" {
  description = "Bounded-retention report-only Terraform drift prefix."
  value       = local.terraform_drift_report_prefix
}
