data "aws_iam_policy_document" "app_terraform_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [
    data.aws_iam_policy_document.app_terraform_plan[0].json,
  ]

  statement {
    sid    = "UseRetainedApprovalEvidenceForAppApply"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.app_retained_approval_evidence_objects_arn]
  }

}

data "aws_iam_policy_document" "app_terraform_apply_state_backend" {
  count                   = local.app_pipeline_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.saved_plan_approval_apply_read["app_terraform"].json]

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
    sid    = "ManageTargetObservabilityDashboard"
    effect = "Allow"

    actions = [
      "cloudwatch:DeleteDashboards",
      "cloudwatch:GetDashboard",
      "cloudwatch:PutDashboard",
    ]
    resources = [local.app_observability_dashboard_arn]
  }

  statement {
    sid       = "ListTargetObservabilityDashboards"
    effect    = "Allow"
    actions   = ["cloudwatch:ListDashboards"]
    resources = ["*"]
  }

  statement {
    sid    = "ManageTargetObservabilityNotificationTopics"
    effect = "Allow"

    actions = [
      "sns:CreateTopic",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
      "sns:TagResource",
      "sns:UntagResource",
    ]
    resources = local.app_observability_sns_topic_arns
  }

  statement {
    sid    = "ManageTargetObservabilityEmailSubscriptions"
    effect = "Allow"

    actions = [
      "sns:GetSubscriptionAttributes",
      "sns:SetSubscriptionAttributes",
      "sns:Unsubscribe",
    ]
    # SNS subscription APIs do not support resource-level ARNs. This dedicated
    # app apply role receives only the three lifecycle actions Terraform needs.
    resources = ["*"]
  }

  statement {
    # The verifier role is owned by the isolated reviewed preflight apply.
    sid       = "ManageTargetApplicationRuntimeRoles"
    effect    = "Allow"
    actions   = ["iam:*"]
    resources = [local.app_target_runtime_role_arn_pattern]
  }

  statement {
    effect    = "Allow"
    actions   = ["logs:*"]
    resources = local.app_target_application_log_group_resource_arns
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
      "logs:DeleteQueryDefinition",
      "logs:DescribeQueryDefinitions",
      "logs:PutQueryDefinition",
    ]
    resources = ["*"]
  }

  statement {
    # Keep verifier function code/configuration outside the full App apply role.
    sid     = "ManageTargetApplicationLambdas"
    effect  = "Allow"
    actions = ["lambda:*"]
    resources = [
      local.app_target_lambda_arn_pattern,
      local.app_target_lambda_event_source_mapping_arn_pattern,
    ]
  }

  statement {
    # Lambda does not support resource ARNs for CreateEventSourceMapping, so
    # constrain its required "*" resource with the exact non-verifier functions.
    sid       = "CreateTargetApplicationEventSourceMappings"
    effect    = "Allow"
    actions   = ["lambda:CreateEventSourceMapping"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "lambda:FunctionArn"
      values   = local.app_target_application_lambda_arns
    }
  }

  statement {
    # Full normal/rollback plans may only move the two reviewed qualified aliases.
    sid    = "ManageReviewedVerifierAliases"
    effect = "Allow"
    actions = [
      "lambda:CreateAlias",
      "lambda:DeleteAlias",
      "lambda:GetAlias",
      "lambda:UpdateAlias",
    ]
    resources = local.app_signature_verifier_alias_arns
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
    resources = [local.app_target_async_queue_arn_pattern, local.app_target_state_machine_arn]
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

check "app_terraform_apply_runtime_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_apply_runtime[0].json))) <= 6144, false)
    )
    error_message = "The app Terraform apply runtime managed policy must remain within the IAM 6,144-character quota."
  }
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_apply_runtime[0].arn
}

data "aws_iam_policy_document" "app_terraform_apply_events" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ManageTargetAppEventRules"
    effect    = "Allow"
    actions   = ["events:*"]
    resources = local.app_target_event_rule_arns
  }
}

resource "aws_iam_policy" "app_terraform_apply_events" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  name   = local.app_terraform_apply_events_policy_name
  policy = data.aws_iam_policy_document.app_terraform_apply_events[0].json
  tags   = local.common_tags
}

check "app_terraform_apply_events_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_apply_events[0].json))) <= 6144, false)
    )
    error_message = "The app Terraform apply EventBridge managed policy must remain within the IAM 6,144-character quota."
  }
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_events" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_apply_events[0].arn
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

  depends_on = [
    aws_codepipeline.development_app,
    aws_iam_role_policy_attachment.app_terraform_apply_state_backend,
  ]

  name   = "${local.app_terraform_apply_role_name}-policy"
  role   = aws_iam_role.app_terraform_apply[0].id
  policy = data.aws_iam_policy_document.app_terraform_apply[0].json

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_apply[0].json))) <= 10240
      error_message = "The app Terraform apply inline policy must remain within the IAM 10,240-character role-policy quota."
    }
  }
}

resource "aws_iam_policy" "app_terraform_apply_state_backend" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name   = local.app_terraform_apply_state_backend_policy_name
  policy = data.aws_iam_policy_document.app_terraform_apply_state_backend[0].json
  tags   = local.common_tags
}

check "app_terraform_apply_state_backend_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_apply_state_backend[0].json))) <= 6144, false)
    )
    error_message = "The app Terraform Apply state and approval managed policy must remain within IAM's 6,144-character quota."
  }
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_state_backend" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_apply_state_backend[0].arn
}
