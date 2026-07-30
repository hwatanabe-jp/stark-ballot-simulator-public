resource "aws_cloudwatch_log_group" "app_pipeline_codebuild" {
  for_each = local.app_pipeline_enabled ? toset(local.app_codebuild_project_names) : toset([])

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  name              = "/aws/codebuild/${each.key}"
  retention_in_days = local.storage_retention.app_codebuild_log_days
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
