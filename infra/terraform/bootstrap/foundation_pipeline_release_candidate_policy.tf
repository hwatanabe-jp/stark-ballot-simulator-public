data "aws_iam_policy_document" "foundation_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseReleaseCandidateArtifacts"
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
    sid    = "UseReleaseCandidateArtifactKey"
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

  statement {
    sid    = "WriteReleaseCandidateBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      for name in [
        local.release_candidate_preflight_project_name,
      ] :
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}:*"
    ]
  }

}

resource "aws_iam_role_policy" "foundation_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_release_candidate_build[0].name}-policy"
  role   = aws_iam_role.foundation_release_candidate_build[0].id
  policy = data.aws_iam_policy_document.foundation_release_candidate_build[0].json
}
