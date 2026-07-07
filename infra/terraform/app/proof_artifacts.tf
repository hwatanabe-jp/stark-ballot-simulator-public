resource "aws_s3_bucket" "proof_artifacts" {
  bucket = local.proof_artifact_bucket_name

  tags = merge(local.common_tags, {
    DataClass = "private-proof-artifacts"
  })
}

resource "aws_s3_bucket_public_access_block" "proof_artifacts" {
  bucket                  = aws_s3_bucket.proof_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "proof_artifacts" {
  bucket = aws_s3_bucket.proof_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "proof_artifacts" {
  bucket = aws_s3_bucket.proof_artifacts.id

  rule {
    id     = "expire-private-proof-artifacts"
    status = "Enabled"

    filter {
      prefix = local.proof_artifact_prefix
    }

    expiration {
      days = var.proof_artifact_lifecycle_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.proof_artifact_lifecycle_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "proof_artifacts" {
  bucket = aws_s3_bucket.proof_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
