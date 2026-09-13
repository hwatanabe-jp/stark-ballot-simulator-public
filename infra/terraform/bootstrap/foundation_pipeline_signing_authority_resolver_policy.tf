data "aws_iam_policy_document" "foundation_image_signing_authority_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadExactSigningResolverProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.foundation_image_signing_authority_resolver_project_arn]
  }

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
    sid    = "ReadCurrentFoundationAcceptance"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.terraform_foundation_acceptance_pointer_object_arn,
      local.terraform_foundation_acceptance_object_arn_pattern,
    ]
  }

  statement {
    sid       = "DescribeCurrentFoundationAcceptanceKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

  statement {
    sid       = "DecryptCurrentFoundationAcceptance"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.terraform_authority_bucket_arn]
    }
  }
}

resource "aws_iam_role_policy" "foundation_image_signing_authority_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_image_signing_authority_resolver_build[0].name}-policy"
  role   = aws_iam_role.foundation_image_signing_authority_resolver_build[0].id
  policy = data.aws_iam_policy_document.foundation_image_signing_authority_resolver_build[0].json
}
