data "aws_iam_policy_document" "foundation_pipeline" {
  count = local.foundation_pipeline_enabled ? 1 : 0

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
    resources = local.foundation_source_connection_arns
  }

  statement {
    sid    = "RunFoundationCodeBuildProjects"
    effect = "Allow"

    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
    ]
    resources = local.foundation_routine_codebuild_project_arns
  }

  statement {
    sid    = "UseFoundationPipelineArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.foundation_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.foundation_pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UseFoundationPipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.foundation_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "foundation_pipeline" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_pipeline_role_name}-policy"
  role   = aws_iam_role.foundation_pipeline[0].id
  policy = data.aws_iam_policy_document.foundation_pipeline[0].json
}

check "foundation_pipeline_inline_policy_size" {
  assert {
    condition = (
      !local.foundation_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_pipeline[0].json))) <= 10240, false)
    )
    error_message = "The Foundation pipeline inline policy must remain within IAM's 10,240-character role-policy quota."
  }
}
