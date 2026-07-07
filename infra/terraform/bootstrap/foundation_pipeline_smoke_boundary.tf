data "aws_iam_policy_document" "foundation_smoke_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_deploy_permissions_boundary[0].json]

  statement {
    sid    = "FoundationSmokeAppRuntimeInventoryReadGuardrail"
    effect = "Allow"
    actions = [
      "apigateway:GET",
      "cloudfront:ListDistributions",
      "dynamodb:ListTables",
      "ecr:GetSigningConfiguration",
      "ecs:ListClusters",
      "lambda:ListFunctions",
      "s3:ListBucket",
      "sqs:ListQueues",
      "states:ListStateMachines",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "foundation_smoke_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  name   = local.foundation_smoke_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_smoke_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
