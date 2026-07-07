data "aws_iam_policy_document" "app_github_trigger" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "TriggerAndObserveDevelopmentAppPipelines"
    effect = "Allow"

    actions = [
      "codepipeline:GetPipelineExecution",
      "codepipeline:GetPipelineState",
      "codepipeline:ListPipelineExecutions",
      "codepipeline:StartPipelineExecution",
    ]

    resources = [
      aws_codepipeline.app_static_fast[0].arn,
    ]
  }
}

resource "aws_iam_role_policy" "app_github_trigger" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_github_trigger_role_name}-policy"
  role   = aws_iam_role.app_github_trigger[0].id
  policy = data.aws_iam_policy_document.app_github_trigger[0].json
}
