module "bootstrap_pipeline_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"

  project_names     = local.pipeline_enabled ? toset(local.codebuild_project_names) : toset([])
  retention_in_days = local.storage_retention.bootstrap_codebuild_log_days
  tags              = local.common_tags
}

module "foundation_pipeline_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"

  depends_on = [
    aws_iam_policy.terraform_apply_artifact_management,
    aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_policy.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management,
    aws_iam_role_policy_attachment.terraform_apply_artifact_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  project_names     = local.foundation_pipeline_enabled ? toset(local.foundation_active_codebuild_project_names) : toset([])
  retention_in_days = local.storage_retention.foundation_codebuild_log_days
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

module "app_pipeline_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  project_names     = local.app_pipeline_enabled ? toset(local.app_codebuild_project_names) : toset([])
  retention_in_days = local.storage_retention.app_codebuild_log_days
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

module "terraform_drift_codebuild_log_groups" {
  source = "../../framework/terraform/modules/codebuild-log-groups"

  depends_on = [terraform_data.terraform_baseline_authority_storage_authorization_propagation]

  project_names = setunion(
    local.terraform_drift_enabled ? toset(local.terraform_drift_all_project_names) : toset([]),
    local.rollback_recovery_readiness_enabled ? toset(values(local.rollback_recovery_readiness_project_names)) : toset([]),
  )
  retention_in_days = local.storage_retention.terraform_drift_codebuild_log_days
  tags              = local.common_tags
}
