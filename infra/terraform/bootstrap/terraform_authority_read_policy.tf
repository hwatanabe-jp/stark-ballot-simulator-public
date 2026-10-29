# The same exact-key, S3-only decryption grant is shared by its consumers and
# their existing boundaries. Object reads remain separately scoped per role.
data "aws_iam_policy_document" "terraform_authority_decrypt" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  statement {
    sid       = "ObserveExactFoundationCheckpointVersion"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.terraform_authority_bucket_arn]
    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = ["deployment/${local.deployment_target.targetKey}/foundation/checkpoint.json"]
    }
    condition {
      test     = "NumericEquals"
      variable = "s3:max-keys"
      values   = ["1"]
    }
  }

  statement {
    sid       = "ReadTerraformAuthorityKeyIdentity"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

  statement {
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
