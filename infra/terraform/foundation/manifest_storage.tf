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
      "${aws_s3_bucket.release_manifests.arn}/candidates/*",
      "${aws_s3_bucket.release_manifests.arn}/promotions/*",
      "${aws_s3_bucket.release_manifests.arn}/deployments/*",
      "${aws_s3_bucket.release_manifests.arn}/rollbacks/*",
      "${aws_s3_bucket.release_manifests.arn}/reissue/*",
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.toolchainAcceptedPointerKey}",
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.proverAcceptedPointerKey}",
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
      "${aws_s3_bucket.release_manifests.arn}/candidates/*",
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
    sid    = "DenyFutureReleaseAuthorityReissueWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.release_manifests.arn}/reissue/*"]
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
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.toolchainAcceptedPointerKey}",
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.proverAcceptedPointerKey}",
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

  statement {
    sid    = "DenyFoundationImageSigningAuthorityWritesOutsidePublisher"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.foundation_image_signing_authority_objects_arn]

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.foundation_image_signing_authority_publisher_role_arn]
    }
  }

  statement {
    sid    = "DenyFoundationAppNetworkingDeletion"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [local.foundation_app_networking_object_arn]
  }

  statement {
    sid    = "DenyUnconditionalFoundationAppNetworkingWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.foundation_app_networking_object_arn]

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

  statement {
    sid    = "DenyFoundationAppNetworkingWritesOutsidePublisher"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.foundation_app_networking_object_arn]

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.foundation_app_networking_publisher_role_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "release_manifests" {
  bucket = aws_s3_bucket.release_manifests.id
  policy = data.aws_iam_policy_document.release_manifests.json
}
