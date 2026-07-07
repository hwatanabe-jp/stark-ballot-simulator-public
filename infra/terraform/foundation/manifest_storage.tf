resource "aws_s3_bucket" "release_manifests" {
  bucket = local.manifest_bucket_name
  tags   = local.common_tags
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
