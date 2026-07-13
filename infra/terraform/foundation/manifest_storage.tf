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

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.release_manifests.arn,
      "${aws_s3_bucket.release_manifests.arn}/*",
    ]

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

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/artifacts/*",
      "${aws_s3_bucket.release_manifests.arn}/promotions/*",
      "${aws_s3_bucket.release_manifests.arn}/deployments/*",
      "${aws_s3_bucket.release_manifests.arn}/rollbacks/*",
    ]
  }

  statement {
    sid    = "DenyUnconditionalImmutableReleaseAuthorityWrites"
    effect = "Deny"

    # Immutable record creation must carry S3 If-None-Match. Channel pointers
    # have a separate policy below because they allow first-create or CAS.

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/artifacts/*",
      "${aws_s3_bucket.release_manifests.arn}/promotions/*",
      "${aws_s3_bucket.release_manifests.arn}/deployments/*",
      "${aws_s3_bucket.release_manifests.arn}/rollbacks/*",
    ]

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyUnconditionalAcceptedPointerWrites"
    effect = "Deny"

    # IAM combines these Null conditions with AND. First publication may use
    # If-None-Match, while every later pointer promotion must use If-Match.

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/channels/develop/toolchain/accepted.json",
      "${aws_s3_bucket.release_manifests.arn}/channels/develop/prover/accepted.json",
    ]

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["true"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["true"]
    }
  }
}

resource "aws_s3_bucket_policy" "release_manifests" {
  bucket = aws_s3_bucket.release_manifests.id
  policy = data.aws_iam_policy_document.release_manifests.json
}
