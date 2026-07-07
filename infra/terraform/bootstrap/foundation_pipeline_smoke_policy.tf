data "aws_iam_policy_document" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_codebuild_common[0].json]

  statement {
    sid       = "ListAppStatePrefixForAbsenceSmoke"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "stark-ballot-simulator/stark-dev/develop/app/",
        "stark-ballot-simulator/stark-dev/develop/app/*",
      ]
    }
  }

  statement {
    sid    = "ReadAppRuntimeInventoryForAbsenceSmoke"
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

resource "aws_iam_role_policy" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_smoke_role_name}-policy"
  role   = aws_iam_role.foundation_terraform_smoke[0].id
  policy = data.aws_iam_policy_document.foundation_terraform_smoke[0].json
}
