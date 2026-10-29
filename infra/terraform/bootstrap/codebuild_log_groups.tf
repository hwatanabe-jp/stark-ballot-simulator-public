locals {
  # Retired execution projects keep their original Terraform-owned log history.
  app_codebuild_log_group_project_names = concat(local.app_codebuild_project_names, [
    local.deployment_shared_names.appExecutionAuthorityProject,
    ], local.deployment_target.environmentId == "main" ? [
    local.deployment_shared_names.retainedAppSignaturePreflightApplyProject,
    local.deployment_shared_names.retainedAppSignaturePreflightPlanProject,
    local.deployment_shared_names.retainedAppSignaturePreflightVerifyProject,
  ] : [])
}

module "bootstrap_pipeline_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"

  project_names     = local.pipeline_enabled ? toset(local.codebuild_project_names) : toset([])
  retention_in_days = local.storage_retention.bootstrap_codebuild_log_days
  tags              = local.common_tags
}

module "app_pipeline_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"


  project_names     = local.app_pipeline_enabled ? toset(local.app_codebuild_log_group_project_names) : toset([])
  retention_in_days = local.storage_retention.app_codebuild_log_days
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

module "terraform_drift_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"


  project_names     = local.terraform_drift_enabled ? toset(local.terraform_drift_all_project_names) : toset([])
  retention_in_days = local.storage_retention.terraform_drift_codebuild_log_days
  tags              = local.common_tags
}
