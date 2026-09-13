resource "aws_iam_role" "app_signature_preflight_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_signature_preflight_plan_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_signature_preflight_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_signature_preflight_apply_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_apply_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_signature_preflight_invoker" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_signature_preflight_invoker_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}
