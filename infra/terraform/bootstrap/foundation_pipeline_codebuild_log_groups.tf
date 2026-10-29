locals {
  # A retired resolver's logs remain owned independently of active build authority.
  foundation_codebuild_log_group_project_names = concat(local.foundation_active_codebuild_project_names, [
    local.deployment_shared_names.foundationSigningResolverProject,
  ])
}

module "foundation_pipeline_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"

  depends_on = [



  ]

  project_names     = local.foundation_pipeline_enabled ? toset(local.foundation_codebuild_log_group_project_names) : toset([])
  retention_in_days = local.storage_retention.foundation_codebuild_log_days
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
