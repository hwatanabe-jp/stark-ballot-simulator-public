data "aws_iam_policy_document" "terraform_authority_key" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0
  statement {
    sid       = "EnableAccountRootAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }
  }
}

resource "aws_kms_key" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0


  description             = "Versioned deployment checkpoints, plan packages and protected local approvals"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.terraform_authority_key[0].json
  tags = merge(local.common_tags, {
    AuthorityType = "terraform-baseline"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  name          = local.terraform_authority_kms_alias
  target_key_id = aws_kms_key.terraform_authority[0].key_id
}

resource "aws_s3_bucket" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0


  bucket = local.terraform_authority_bucket_name
  tags = merge(local.common_tags, {
    AuthorityType = "terraform-baseline"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.terraform_authority[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket = aws_s3_bucket.terraform_authority[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket = aws_s3_bucket.terraform_authority[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_authority[0].arn
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_authority" {
  count  = local.terraform_baseline_authority_enabled ? 1 : 0
  bucket = aws_s3_bucket.terraform_authority[0].id
  rule {
    id     = "abort-incomplete-authority-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}
data "aws_iam_policy_document" "terraform_authority_bucket" {
  count                   = local.terraform_baseline_authority_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.deployment_record_storage["terraform"].json]
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [local.terraform_authority_bucket_arn, "${local.terraform_authority_bucket_arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid    = "DenyRetiredTerraformAuthorityDeletion"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${local.terraform_authority_bucket_arn}/${local.terraform_baseline_prefix}/*", "${local.terraform_authority_bucket_arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*"]
  }
  statement {
    sid    = "FreezeRetiredTerraformAuthority"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${local.terraform_authority_bucket_arn}/${local.terraform_baseline_prefix}/*", "${local.terraform_authority_bucket_arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*"]
  }
}
resource "aws_s3_bucket_policy" "terraform_authority" {
  count  = local.terraform_baseline_authority_enabled ? 1 : 0
  bucket = aws_s3_bucket.terraform_authority[0].id
  policy = data.aws_iam_policy_document.terraform_authority_bucket[0].json
}

check "terraform_authority_key_policy_size" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_authority_key[0].json))) <= 32768, false)
    )
    error_message = "The Terraform authority KMS key policy must remain within KMS's 32,768-character quota."
  }
}

check "terraform_authority_bucket_policy_size" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_authority_bucket[0].json))) <= 20480, false)
    )
    error_message = "The Terraform authority bucket policy must remain within S3's 20,480-character quota."
  }
}
