resource "aws_s3_bucket" "release_manifests" {
  bucket = local.manifest_bucket_name
  tags   = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "release_manifests" {
  bucket                  = aws_s3_bucket.release_manifests.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "release_manifests" {
  bucket = aws_s3_bucket.release_manifests.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "release_manifests" {
  bucket = aws_s3_bucket.release_manifests.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "release_manifests" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.release_manifests.arn, "${aws_s3_bucket.release_manifests.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid    = "DenyImmutableReleaseAuthorityDeletion"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.release_manifests.arn}/*"]
  }
  statement {
    sid    = "DenyReleaseAuthorityExpiration"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutLifecycleConfiguration"]
    resources = [aws_s3_bucket.release_manifests.arn]
  }
  statement {
    sid    = "DenyUnconditionalCandidateWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*",
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*",
    ]
    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
  # No new writes to historical records, pointers, signing/networking handoffs,
  # or unregistered namespaces. Existing versions remain delete protected.
  statement {
    sid    = "DenyRetiredReleaseAuthorityWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:PutObject"]
    not_resources = [
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*",
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*",
      "${aws_s3_bucket.release_manifests.arn}/promotions/toolchain/current.json",
      "${aws_s3_bucket.release_manifests.arn}/promotions/prover/current.json",
    ]
  }
  dynamic "statement" {
    for_each = local.release_authority_publisher_restrictions
    content {
      sid    = statement.value.sid
      effect = "Deny"
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      actions   = ["s3:PutObject"]
      resources = statement.value.object_arns
      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = statement.value.publisher_role_arns
      }
    }
  }
  statement {
    sid    = "DenyUnconditionalPromotionWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/promotions/toolchain/current.json",
      "${aws_s3_bucket.release_manifests.arn}/promotions/prover/current.json",
    ]
    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["true"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
  statement {
    sid    = "DenyAmbiguousPromotionWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/promotions/toolchain/current.json",
      "${aws_s3_bucket.release_manifests.arn}/promotions/prover/current.json",
    ]
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "release_manifests" {
  bucket = aws_s3_bucket.release_manifests.id
  policy = data.aws_iam_policy_document.release_manifests.json
}
