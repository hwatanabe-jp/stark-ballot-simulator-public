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
    ]

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "DenyAppHistoryPrefixWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/deployments/*",
      "${aws_s3_bucket.release_manifests.arn}/rollbacks/*",
    ]
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
    sid    = "DenyObsoleteToolchainManifestWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/*/manifest.json",
    ]
  }

  statement {
    sid    = "DenyObsoleteProverManifestWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.release_manifests.arn}/${local.deployment_shared_names.proverReleasePrefix}/*/manifest.json",
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
    sid    = "DenyUnconditionalAcceptedPointerWrites"
    effect = "Deny"

    # First publication must use the exact If-None-Match wildcard. Every later
    # pointer promotion must use If-Match, and a separate deny rejects a request
    # that ambiguously supplies both headers.

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
    sid    = "DenyAmbiguousAcceptedPointerWrites"
    effect = "Deny"

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
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyRetiredFoundationImageSigningAuthorityWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.foundation_image_signing_authority_objects_arn]
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
    sid    = "DenyRetiredFoundationAppNetworkingWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.foundation_app_networking_object_arn]
  }
}

resource "aws_s3_bucket_policy" "release_manifests" {
  bucket = aws_s3_bucket.release_manifests.id
  policy = data.aws_iam_policy_document.release_manifests.json
}
