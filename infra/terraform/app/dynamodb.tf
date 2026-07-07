data "aws_iam_policy_document" "app_data_kms_key" {
  statement {
    sid    = "EnableAccountAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowDynamoDBServiceUse"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["dynamodb.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = local.dynamodb_table_names
    }
  }
}

resource "aws_kms_key" "app_data" {
  description             = "KMS key for ${local.name_prefix} DynamoDB application data"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.app_data_kms_key.json

  tags = local.common_tags
}

resource "aws_kms_alias" "app_data" {
  name          = "alias/${local.name_prefix}-app-data"
  target_key_id = aws_kms_key.app_data.key_id
}

resource "aws_dynamodb_table" "sessions" {
  name                        = local.dynamodb_tables.sessions.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = local.dynamodb_tables.sessions.hash_key
  deletion_protection_enabled = var.enable_dynamodb_deletion_protection

  attribute {
    name = local.dynamodb_tables.sessions.hash_key
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_data.arn
  }

  tags = merge(local.common_tags, {
    DataClass = "session-authority"
  })
}

resource "aws_dynamodb_table" "votes" {
  name                        = local.dynamodb_tables.votes.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = local.dynamodb_tables.votes.hash_key
  range_key                   = local.dynamodb_tables.votes.range_key
  deletion_protection_enabled = var.enable_dynamodb_deletion_protection

  attribute {
    name = local.dynamodb_tables.votes.hash_key
    type = "S"
  }

  attribute {
    name = local.dynamodb_tables.votes.range_key
    type = "N"
  }

  attribute {
    name = "voteId"
    type = "S"
  }

  global_secondary_index {
    name            = "voteId-index"
    projection_type = "KEYS_ONLY"

    key_schema {
      attribute_name = "voteId"
      key_type       = "HASH"
    }
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_data.arn
  }

  tags = merge(local.common_tags, {
    DataClass = "session-owned-votes"
  })
}

resource "aws_dynamodb_table" "rate_limit_events" {
  name                        = local.dynamodb_tables.rate_limit_events.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = local.dynamodb_tables.rate_limit_events.hash_key
  range_key                   = local.dynamodb_tables.rate_limit_events.range_key
  deletion_protection_enabled = var.enable_dynamodb_deletion_protection

  attribute {
    name = local.dynamodb_tables.rate_limit_events.hash_key
    type = "S"
  }

  attribute {
    name = local.dynamodb_tables.rate_limit_events.range_key
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_data.arn
  }

  tags = merge(local.common_tags, {
    DataClass = "rate-limit-events"
  })
}

resource "aws_dynamodb_table" "rate_limit_counters" {
  name                        = local.dynamodb_tables.rate_limit_counters.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = local.dynamodb_tables.rate_limit_counters.hash_key
  deletion_protection_enabled = var.enable_dynamodb_deletion_protection

  attribute {
    name = local.dynamodb_tables.rate_limit_counters.hash_key
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_data.arn
  }

  tags = merge(local.common_tags, {
    DataClass = "rate-limit-counters"
  })
}

resource "aws_dynamodb_table" "prover_semaphore" {
  name                        = local.prover_semaphore_table_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = local.dynamodb_tables.prover_semaphore.hash_key
  deletion_protection_enabled = var.enable_dynamodb_deletion_protection

  attribute {
    name = local.dynamodb_tables.prover_semaphore.hash_key
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_data.arn
  }

  tags = merge(local.common_tags, {
    DataClass = "prover-concurrency-semaphore"
  })
}

resource "aws_dynamodb_table_item" "prover_semaphore" {
  table_name = aws_dynamodb_table.prover_semaphore.name
  hash_key   = aws_dynamodb_table.prover_semaphore.hash_key

  item = jsonencode({
    LockName = {
      S = local.prover_semaphore_lock_name
    }
    currentLockCount = {
      N = "0"
    }
    limit = {
      N = tostring(var.prover_max_concurrent_provers)
    }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
