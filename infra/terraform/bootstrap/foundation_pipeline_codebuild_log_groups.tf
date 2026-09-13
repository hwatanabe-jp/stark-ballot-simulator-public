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
