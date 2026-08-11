data "aws_iam_policy_document" "app_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:PassConnection",
      "codeconnections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
      "codestar-connections:PassConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "RunAppCodeBuildProjects"
    effect = "Allow"

    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
    ]
    resources = local.app_full_pipeline_codebuild_project_arns
  }

  statement {
    sid    = "UseAppPipelineArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.app_pipeline_execution_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_execution_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UseAppPipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "app_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_pipeline_role_name}-policy"
  role   = aws_iam_role.app_pipeline[0].id
  policy = data.aws_iam_policy_document.app_pipeline[0].json
}
