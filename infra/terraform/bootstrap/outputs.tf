output "development_pipeline_artifact_bucket_name" {
  description = "Encrypted pipeline artifact bucket name when enabled."
  value       = var.enable_development_pipeline ? aws_s3_bucket.pipeline_artifacts[0].bucket : null
}

output "development_app_pipeline_name" {
  description = "Development app saved-plan pipeline name when enabled."
  value       = var.enable_development_app_pipeline ? aws_codepipeline.development_app[0].name : null
}

output "development_app_retained_artifact_bucket_name" {
  description = "Encrypted retained App authority and build-cache bucket name when enabled."
  value       = var.enable_development_app_pipeline ? aws_s3_bucket.app_pipeline_artifacts[0].bucket : null
}

output "development_app_pipeline_execution_artifact_bucket_name" {
  description = "Encrypted full App CodePipeline execution artifact bucket name when enabled."
  value       = var.enable_development_app_pipeline ? aws_s3_bucket.app_pipeline_execution_artifacts[0].bucket : null
}

output "development_app_release_manifest_bucket_name" {
  description = "Foundation release-manifest bucket name consumed by the development app pipeline when enabled."
  value       = var.enable_development_app_pipeline ? local.app_release_manifest_bucket_name : null
}

output "development_app_state_backend_key" {
  description = "Terraform remote state key for the development app lane."
  value       = local.app_state_backend_key
}
