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

  attribute {
    name = "itemType"
    type = "S"
  }

  attribute {
    name = "expiresAt"
    type = "N"
  }

  global_secondary_index {
    name               = "finalization-expiry-index"
    projection_type    = "INCLUDE"
    non_key_attributes = ["ownerSessionId", "finalizationId"]

    key_schema {
      attribute_name = "itemType"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "expiresAt"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled                 = true
    recovery_period_in_days = local.storage_retention.dynamodb_point_in_time_recovery_days
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
    enabled                 = true
    recovery_period_in_days = local.storage_retention.dynamodb_point_in_time_recovery_days
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
    enabled                 = true
    recovery_period_in_days = local.storage_retention.dynamodb_point_in_time_recovery_days
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
    enabled                 = true
    recovery_period_in_days = local.storage_retention.dynamodb_point_in_time_recovery_days
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.app_data.arn
  }

  tags = merge(local.common_tags, {
    DataClass = "rate-limit-counters"
  })
}
