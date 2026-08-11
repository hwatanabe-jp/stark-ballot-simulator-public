data "aws_iam_policy_document" "target_lambda_runtime_references" {
  statement {
    sid    = "ReadRuntimeConfigParameters"
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
    ]
    resources = [
      for parameter in aws_ssm_parameter.runtime_config_names : parameter.arn
    ]
  }

  statement {
    sid    = "ReadTargetRuntimeReferences"
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
      "secretsmanager:GetSecretValue",
    ]
    resources = concat(
      local.runtime_reference_ssm_parameter_arns,
      local.runtime_reference_secrets_manager_arns,
    )
  }
}

data "aws_iam_policy_document" "target_lambda_observability_runtime" {
  statement {
    sid       = "ReadLogHashSalt"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.log_ip_hash_salt_secret_arn]
  }
}

data "aws_iam_policy_document" "target_lambda_session_store_runtime" {
  source_policy_documents = [data.aws_iam_policy_document.target_lambda_runtime_references.json]

  statement {
    sid    = "UseSessionTable"
    effect = "Allow"

    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Scan",
      "dynamodb:UpdateItem",
    ]
    resources = local.runtime_sessions_table_arns
  }

  statement {
    sid    = "UseVoteTable"
    effect = "Allow"

    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]
    resources = local.runtime_votes_table_arns
  }

  statement {
    sid    = "UseAppDataKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_data.arn]

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

data "aws_iam_policy_document" "target_lambda_store_runtime" {
  source_policy_documents = [data.aws_iam_policy_document.target_lambda_session_store_runtime.json]

  statement {
    sid    = "UseRateLimitEventsTable"
    effect = "Allow"

    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]
    resources = [aws_dynamodb_table.rate_limit_events.arn]
  }

  statement {
    sid    = "UseRateLimitCountersTable"
    effect = "Allow"

    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.rate_limit_counters.arn]
  }
}

data "aws_iam_policy_document" "target_lambda_logs" {
  for_each = local.target_application_lambda_names

  statement {
    sid    = "WriteLambdaLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.target_lambdas[each.key].arn}:*"]
  }
}

data "aws_iam_policy_document" "target_lambda_public_api" {
  source_policy_documents = [
    data.aws_iam_policy_document.target_lambda_store_runtime.json,
    data.aws_iam_policy_document.target_lambda_logs["public_api"].json,
  ]

  statement {
    sid       = "UseSessionConditionChecks"
    effect    = "Allow"
    actions   = ["dynamodb:ConditionCheckItem"]
    resources = local.runtime_sessions_table_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid       = "UseSessionDeletes"
    effect    = "Allow"
    actions   = ["dynamodb:DeleteItem"]
    resources = local.runtime_sessions_table_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid       = "UseVoteTtlUpdates"
    effect    = "Allow"
    actions   = ["dynamodb:UpdateItem"]
    resources = local.runtime_votes_table_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid    = "UseProofArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.proof_artifacts.arn}/${local.proof_artifact_prefix}*"]
  }

  statement {
    sid       = "PublishProverWork"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.prover_work.arn]
  }

  statement {
    sid       = "PublishVerificationWork"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.verification_work.arn]
  }

  statement {
    sid       = "ObserveAndStopTargetFinalization"
    effect    = "Allow"
    actions   = ["states:DescribeExecution", "states:StopExecution"]
    resources = [local.target_execution_arn]
  }

}

data "aws_iam_policy_document" "target_lambda_proof_dispatcher" {
  source_policy_documents = [
    data.aws_iam_policy_document.target_lambda_session_store_runtime.json,
    data.aws_iam_policy_document.target_lambda_logs["proof_dispatcher"].json,
  ]

  statement {
    sid    = "WriteProofArtifactInput"
    effect = "Allow"

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.proof_artifacts.arn}/${local.proof_artifact_prefix}*"]
  }

  statement {
    sid    = "ConsumeProverWork"
    effect = "Allow"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.prover_work.arn]
  }

  statement {
    sid       = "StartTargetFinalization"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = [local.target_state_machine_arn]
  }

  statement {
    sid       = "DescribeTargetFinalizationExecution"
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = [local.target_execution_arn]
  }
}

data "aws_iam_policy_document" "target_lambda_finalization_writer" {
  source_policy_documents = [
    data.aws_iam_policy_document.target_lambda_session_store_runtime.json,
    data.aws_iam_policy_document.target_lambda_logs["finalization_writer"].json,
  ]

  statement {
    sid       = "UseSessionConditionChecks"
    effect    = "Allow"
    actions   = ["dynamodb:ConditionCheckItem"]
    resources = local.runtime_sessions_table_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid       = "UseVoteTtlUpdates"
    effect    = "Allow"
    actions   = ["dynamodb:UpdateItem"]
    resources = local.runtime_votes_table_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid    = "ReadProofArtifactBundle"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${aws_s3_bucket.proof_artifacts.arn}/${local.proof_artifact_prefix}*"]
  }
}

data "aws_iam_policy_document" "target_lambda_verification_worker" {
  source_policy_documents = [
    data.aws_iam_policy_document.target_lambda_session_store_runtime.json,
    data.aws_iam_policy_document.target_lambda_logs["verification_worker"].json,
  ]

  statement {
    sid       = "UseSessionDeletes"
    effect    = "Allow"
    actions   = ["dynamodb:DeleteItem"]
    resources = local.runtime_sessions_table_arns

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "dynamodb:EnclosingOperation"
      values   = ["TransactWriteItems"]
    }
  }

  statement {
    sid    = "UseProofArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.proof_artifacts.arn}/${local.proof_artifact_prefix}*"]
  }

  statement {
    sid    = "ConsumeVerificationWork"
    effect = "Allow"

    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.verification_work.arn]
  }
}

data "aws_iam_policy_document" "image_signature_verifier" {
  statement {
    sid    = "WriteImageSignatureVerifierLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.image_signature_verifier.arn}:*"]
  }

  statement {
    sid    = "ReadExactProverImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImageSigningStatus",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [local.prover_image_repository_arn]
  }

  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid     = "CheckSignerRevocation"
    effect  = "Allow"
    actions = ["signer:GetRevocationStatus"]
    resources = [
      local.image_signature_signing_profile_arn,
      local.image_signature_signing_job_arn_pattern,
    ]
  }
}

resource "aws_iam_role_policy" "image_signature_verifier" {
  name   = "${local.image_signature_name_prefix}-image-signature-verifier"
  role   = aws_iam_role.image_signature_verifier.id
  policy = data.aws_iam_policy_document.image_signature_verifier.json
}

data "aws_iam_policy_document" "target_lambda_semaphore_janitor" {
  source_policy_documents = [
    data.aws_iam_policy_document.target_lambda_logs["semaphore_janitor"].json,
    data.aws_iam_policy_document.target_lambda_observability_runtime.json,
  ]

  statement {
    sid    = "WriteNormalizedOpsLedger"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.ops_ledger.arn}:*"]
  }

  statement {
    sid    = "UseProverSemaphore"
    effect = "Allow"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.prover_semaphore.arn]
  }

  statement {
    sid    = "UseProverSemaphoreKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_data.arn]

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
      values   = [aws_dynamodb_table.prover_semaphore.name]
    }
  }

  statement {
    sid       = "DescribeTargetFinalizationExecution"
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = [local.target_execution_arn]
  }
}

resource "aws_iam_role_policy" "target_lambda_public_api" {
  name   = "${local.name_prefix}-public-api"
  role   = aws_iam_role.target_lambda["public_api"].id
  policy = data.aws_iam_policy_document.target_lambda_public_api.json
}

resource "aws_iam_role_policy" "target_lambda_proof_dispatcher" {
  name   = "${local.name_prefix}-proof-dispatcher"
  role   = aws_iam_role.target_lambda["proof_dispatcher"].id
  policy = data.aws_iam_policy_document.target_lambda_proof_dispatcher.json
}

resource "aws_iam_role_policy" "target_lambda_finalization_writer" {
  name   = "${local.name_prefix}-finalization-writer"
  role   = aws_iam_role.target_lambda["finalization_writer"].id
  policy = data.aws_iam_policy_document.target_lambda_finalization_writer.json
}

resource "aws_iam_role_policy" "target_lambda_verification_worker" {
  name   = "${local.name_prefix}-verification-worker"
  role   = aws_iam_role.target_lambda["verification_worker"].id
  policy = data.aws_iam_policy_document.target_lambda_verification_worker.json
}

resource "aws_iam_role_policy" "target_lambda_semaphore_janitor" {
  name   = "${local.name_prefix}-semaphore-janitor"
  role   = aws_iam_role.target_lambda["semaphore_janitor"].id
  policy = data.aws_iam_policy_document.target_lambda_semaphore_janitor.json
}
