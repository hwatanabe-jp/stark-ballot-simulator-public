data "aws_iam_policy_document" "app_apply_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json]

  statement {
    sid    = "AppStateApplyWrite"
    effect = "Allow"

    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/${local.app_state_backend_key}"]
  }
}

resource "aws_iam_policy" "app_apply_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  name   = local.app_apply_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.app_apply_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

check "app_apply_deploy_permissions_boundary_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_apply_deploy_permissions_boundary[0].json))) <= 6144, false)
    )
    error_message = "The app apply deploy permissions boundary must remain within the IAM 6,144-character quota."
  }
}
