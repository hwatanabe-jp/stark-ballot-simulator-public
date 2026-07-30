data "aws_iam_policy_document" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_deploy_permissions_boundary[0].json]

  statement {
    sid       = "FoundationStateApplyWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}"]
  }

  statement {
    sid    = "DenyDeletingRetainedFoundationImages"
    effect = "Deny"
    actions = [
      "ecr:BatchDeleteImage",
      "ecr:DeleteRepository",
      "ecr:PutLifecyclePolicy",
    ]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    sid    = "DenyDeletingImmutableReleaseAuthority"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      "${local.foundation_release_manifest_bucket_arn}/artifacts/*",
      "${local.foundation_release_manifest_bucket_arn}/candidates/*",
      "${local.foundation_release_manifest_bucket_arn}/promotions/*",
      "${local.foundation_release_manifest_bucket_arn}/deployments/*",
      "${local.foundation_release_manifest_bucket_arn}/rollbacks/*",
      "${local.foundation_release_manifest_bucket_arn}/reissue/*",
      local.foundation_toolchain_accepted_pointer_object_arn,
      local.foundation_prover_accepted_pointer_object_arn,
    ]
  }

  statement {
    sid       = "DenyAddingReleaseAuthorityLifecycle"
    effect    = "Deny"
    actions   = ["s3:PutLifecycleConfiguration"]
    resources = [local.foundation_release_manifest_bucket_arn]
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
