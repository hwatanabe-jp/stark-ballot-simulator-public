data "aws_iam_policy_document" "app_terraform_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_terraform_plan[0].json]

  statement {
    sid       = "ReadAppApprovalActionExecution"
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = [aws_codepipeline.development_app[0].arn]
  }
}

data "aws_iam_policy_document" "app_terraform_apply_state_backend" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "WriteAppStateBackend"
    effect = "Allow"

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
  }
}

data "aws_iam_policy_document" "app_terraform_apply_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["dynamodb:*"]
    resources = [
      local.app_dynamodb_table_arn_pattern,
      local.app_dynamodb_index_arn_pattern,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["ssm:*"]
    resources = [local.app_runtime_ssm_parameter_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["cloudwatch:*"]
    resources = local.app_cloudwatch_alarm_arns
  }

  statement {
    effect    = "Allow"
    actions   = ["iam:*"]
    resources = [local.app_target_runtime_role_arn_pattern]
  }

  statement {
    effect    = "Allow"
    actions   = ["logs:*"]
    resources = local.app_target_all_log_group_resource_arns
  }

  statement {
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"

    actions = [
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:DescribeResourcePolicies",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:UpdateLogDelivery",
    ]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["lambda:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["apigateway:*"]
    resources = concat(local.app_target_api_arns, local.app_target_api_tagging_arns)
  }

  statement {
    effect = "Allow"

    actions = [
      "sqs:*",
      "states:*",
    ]
    resources = concat(local.app_target_async_queue_arns, [local.app_target_state_machine_arn])
  }

  statement {
    sid       = "ManageTargetSemaphoreJanitorEvents"
    effect    = "Allow"
    actions   = ["events:*"]
    resources = local.app_target_event_rule_arns
  }

  statement {
    effect    = "Allow"
    actions   = ["states:ValidateStateMachineDefinition"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["ecs:*"]
    resources = [local.app_target_ecs_cluster_arn, local.app_target_ecs_task_definition_arn, "*"]
  }

  statement {
    effect = "Allow"

    actions   = ["iam:PassRole"]
    resources = [local.app_target_runtime_role_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "ecs-tasks.amazonaws.com",
        "lambda.amazonaws.com",
        "states.amazonaws.com",
      ]
    }
  }

  statement {
    effect = "Allow"

    actions = ["s3:*"]
    resources = [
      local.app_target_proof_bucket_arn,
      local.app_target_frontend_bucket_arn,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["cloudfront:*"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "app_terraform_apply_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name   = local.app_terraform_apply_runtime_policy_name
  policy = data.aws_iam_policy_document.app_terraform_apply_runtime[0].json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_apply_runtime[0].arn
}

data "aws_iam_policy_document" "app_terraform_apply_runtime_kms" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    sid    = "CreateTargetOperatorGateSigningKeys"
    effect = "Allow"

    actions   = ["kms:CreateKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["Terraform"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values   = ["app"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:KeyUsage"
      values   = ["SIGN_VERIFY"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:KeySpec"
      values   = ["RSA_2048"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Project", "AccountAlias", "Environment", "ManagedBy", "StateScope"]
    }
  }

  statement {
    effect = "Allow"

    actions   = ["kms:CreateKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["Terraform"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values   = ["app"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:KeyUsage"
      values   = ["ENCRYPT_DECRYPT"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:KeySpec"
      values   = ["SYMMETRIC_DEFAULT"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Project", "AccountAlias", "Environment", "ManagedBy", "StateScope"]
    }
  }

  statement {
    effect = "Allow"

    actions   = ["kms:CreateGrant"]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }

  statement {
    sid    = "ManageTargetKmsResources"
    effect = "Allow"

    actions = [
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:DescribeKey",
      "kms:DisableKey",
      "kms:EnableKey",
      "kms:EnableKeyRotation",
      "kms:GetPublicKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
    ]
    resources = [
      local.app_data_kms_alias_arn,
      local.app_operator_gate_kms_alias_arn_pattern,
      "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*",
    ]
  }

  statement {
    effect = "Allow"

    actions   = ["kms:Decrypt"]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

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
      test     = "ForAnyValue:StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = local.app_dynamodb_table_names
    }
  }
}

resource "aws_iam_policy" "app_terraform_apply_runtime_kms" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name   = local.app_terraform_apply_runtime_kms_policy_name
  policy = data.aws_iam_policy_document.app_terraform_apply_runtime_kms[0].json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_runtime_kms" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_apply_runtime_kms[0].arn
}

resource "aws_iam_role_policy" "app_terraform_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_terraform_apply_role_name}-policy"
  role   = aws_iam_role.app_terraform_apply[0].id
  policy = data.aws_iam_policy_document.app_terraform_apply[0].json
}

resource "aws_iam_policy" "app_terraform_apply_state_backend" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name   = local.app_terraform_apply_state_backend_policy_name
  policy = data.aws_iam_policy_document.app_terraform_apply_state_backend[0].json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_state_backend" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_apply_state_backend[0].arn
}
