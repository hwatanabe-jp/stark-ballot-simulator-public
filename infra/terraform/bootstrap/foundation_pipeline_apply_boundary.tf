data "aws_iam_policy_document" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_deploy_permissions_boundary[0].json]

  statement {
    sid       = "FoundationStateApplyWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}"]
  }
}

resource "aws_iam_policy" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  name   = local.foundation_apply_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
