data "aws_iam_policy_document" "foundation_image_signing_authority_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseFoundationSigningAuthorityResolverPipelineArtifacts"
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
    sid    = "UseFoundationSigningAuthorityResolverPipelineArtifactKey"
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
    sid    = "WriteFoundationSigningAuthorityResolverLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.foundation_image_signing_authority_resolver_project_name}:*",
    ]
  }

  statement {
    sid    = "ReadFoundationImageSigningAuthority"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [local.foundation_image_signing_authority_objects_arn]
  }
}

resource "aws_iam_role_policy" "foundation_image_signing_authority_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_image_signing_authority_resolver_build[0].name}-policy"
  role   = aws_iam_role.foundation_image_signing_authority_resolver_build[0].id
  policy = data.aws_iam_policy_document.foundation_image_signing_authority_resolver_build[0].json
}
