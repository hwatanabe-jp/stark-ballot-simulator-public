resource "aws_s3_bucket" "proof_bundles" {
  bucket = local.proof_bundle_bucket_name

  tags = {
    Name = local.proof_bundle_bucket_name
  }
}

resource "aws_s3_bucket_versioning" "proof_bundles" {
  bucket = aws_s3_bucket.proof_bundles.id

  versioning_configuration {
    status = "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "proof_bundles" {
  bucket = aws_s3_bucket.proof_bundles.id

  rule {
    blocked_encryption_types = ["NONE"]
    bucket_key_enabled       = false

    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "proof_bundles" {
  bucket                  = aws_s3_bucket.proof_bundles.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "proof_bundles" {
  count  = length(var.s3_cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.proof_bundles.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.s3_cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Type", "Content-Disposition"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "proof_bundles" {
  bucket = aws_s3_bucket.proof_bundles.id

  rule {
    id     = "delete-old-bundles"
    status = "Enabled"

    filter {}

    expiration {
      days = local.current_environment_settings.s3_lifecycle_days
    }
  }
}
