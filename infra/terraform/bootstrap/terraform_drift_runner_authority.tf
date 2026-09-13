data "aws_iam_policy_document" "terraform_drift_runner_boundary" {
  for_each = local.terraform_drift_runner_roles

  statement {
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  statement {
    effect = "Deny"
    not_actions = distinct(flatten([
      for document in local.terraform_drift_runner_identity_policy_documents[each.key] : [
        for statement in jsondecode(document).Statement : statement.Action
      ]
    ]))
    resources = ["*"]
  }

  statement {
    effect        = "Deny"
    actions       = ["s3:PutObject"]
    not_resources = [local.terraform_drift_runner_report_object_arns[each.key]]
  }

  statement {
    effect  = "Deny"
    actions = ["s3:GetObject"]
    not_resources = concat(
      [local.terraform_drift_runner_state_object_arns[each.key]],
      local.terraform_drift_runner_authority_object_arns[each.key],
    )
  }

  statement {
    effect        = "Deny"
    actions       = ["s3:GetObjectVersion"]
    not_resources = local.terraform_drift_runner_authority_object_arns[each.key]
  }

  dynamic "statement" {
    for_each = (
      each.key == "app" || length(local.terraform_drift_runner_secret_read_arns[each.key]) == 0
      ? []
      : [1]
    )

    content {
      effect = "Deny"
      actions = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:GetSecretValue",
      ]
      not_resources = local.terraform_drift_runner_secret_read_arns[each.key]
    }
  }

  dynamic "statement" {
    for_each = (
      each.key == "app" || length(local.terraform_drift_runner_parameter_read_arns[each.key]) == 0
      ? []
      : [1]
    )

    content {
      effect = "Deny"
      actions = [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:ListTagsForResource",
      ]
      not_resources = local.terraform_drift_runner_parameter_read_arns[each.key]
    }
  }

  dynamic "statement" {
    for_each = each.key == "app" ? [1] : []

    content {
      effect = "Deny"
      actions = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:GetSecretValue",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:ListTagsForResource",
        "dynamodb:GetItem",
      ]
      not_resources = concat(
        local.terraform_drift_runner_secret_read_arns[each.key],
        local.terraform_drift_runner_parameter_read_arns[each.key],
        [local.app_target_prover_semaphore_table_arn],
      )
    }
  }

  statement {
    effect = "Deny"
    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:GetPublicKey",
      "kms:ListResourceTags",
    ]
    not_resources = local.terraform_drift_runner_kms_read_arns[each.key]
  }

  statement {
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "kms:ViaService"
      values   = local.terraform_drift_runner_kms_decrypt_services[each.key]
    }
  }

  statement {
    effect = "Deny"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    not_resources = [local.terraform_drift_runner_log_stream_arns[each.key]]
  }

  statement {
    effect = "Deny"
    actions = [
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    not_resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

}

resource "aws_iam_policy" "terraform_drift_runner_boundary" {
  for_each = local.terraform_drift_runner_roles

  depends_on = [aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management]

  name   = local.terraform_drift_runner_boundary_policy_names[each.key]
  policy = data.aws_iam_policy_document.terraform_drift_runner_boundary[each.key].json
  tags   = local.common_tags
}

check "terraform_drift_runner_boundary_policy_size" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || try(alltrue([
        for document in values(data.aws_iam_policy_document.terraform_drift_runner_boundary) :
        length(jsonencode(jsondecode(document.json))) <= 6144
      ]), false)
    )
    error_message = "The Terraform drift runner permissions boundary must remain within the IAM 6,144-character managed-policy quota."
  }
}

resource "aws_iam_role" "terraform_drift_runner" {
  for_each = local.terraform_drift_runner_roles

  name                 = each.value.roleName
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.terraform_drift_runner_boundary[each.key].arn
  tags                 = merge(local.common_tags, { StateScope = each.key })
}

data "aws_iam_policy_document" "terraform_drift_runner" {
  for_each = local.terraform_drift_runner_roles

  statement {
    sid       = "ReadRunnerAccountIdentity"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid     = "ReadExactInstalledRunnerProject"
    effect  = "Allow"
    actions = ["codebuild:BatchGetProjects"]
    resources = [
      "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${each.value.projectName}"
    ]
  }

  statement {
    sid       = "ReadExactTerraformState"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/${each.value.backendKey}"]
  }

  statement {
    sid       = "ListExactTerraformStatePrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [dirname(each.value.backendKey), "${dirname(each.value.backendKey)}/*"]
    }
  }

  statement {
    sid       = "DescribeTerraformStateKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.state.arn]
  }

  statement {
    sid       = "DecryptTerraformStateThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.state.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.state.arn]
    }
  }

  statement {
    sid    = "ReadAcceptedTerraformAuthority"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = local.terraform_drift_runner_authority_object_arns[each.key]
  }

  statement {
    sid     = "PublishConditionalTerraformDriftReport"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_drift_report_prefix}/${each.key}/*"
    ]

    condition {
      test     = "StringEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid       = "DescribeTerraformAuthorityKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

  dynamic "statement" {
    for_each = each.key == "app" ? [1] : []

    content {
      sid       = "DescribeAppAcceptanceKey"
      effect    = "Allow"
      actions   = ["kms:DescribeKey"]
      resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "app" ? [1] : []

    content {
      sid       = "DecryptAppAcceptanceThroughS3"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:CallerAccount"
        values   = [var.aws_account_id]
      }

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${var.aws_region}.amazonaws.com"]
      }

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:aws:s3:arn"
        values   = [local.app_retained_artifact_bucket_arn]
      }
    }
  }

  statement {
    sid    = "UseTerraformAuthorityKeyThroughS3"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.terraform_authority_bucket_arn]
    }
  }

  statement {
    sid    = "UseSourceConnection"
    effect = "Allow"
    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
    ]
    resources = [aws_codeconnections_connection.source[0].arn]
  }

  statement {
    sid    = "WriteTerraformDriftLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${module.terraform_drift_codebuild_log_groups.log_groups[each.value.projectName].arn}:*"
    ]
  }
}

resource "aws_iam_role_policy" "terraform_drift_runner" {
  for_each = local.terraform_drift_runner_roles

  name   = "${each.value.roleName}-policy"
  role   = aws_iam_role.terraform_drift_runner[each.key].id
  policy = data.aws_iam_policy_document.terraform_drift_runner[each.key].json
}

data "aws_iam_policy_document" "terraform_drift_runner_bootstrap_provider" {
  for_each = local.terraform_drift_bootstrap_provider_policy_configuration

  dynamic "statement" {
    for_each = each.value.statements

    content {
      sid       = statement.value.sid
      effect    = "Allow"
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_policy" "terraform_drift_runner_bootstrap_provider" {
  for_each = local.terraform_drift_bootstrap_provider_policy_configuration

  depends_on = [aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management]

  name   = each.value.name
  policy = data.aws_iam_policy_document.terraform_drift_runner_bootstrap_provider[each.key].json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "terraform_drift_runner_bootstrap_provider" {
  for_each = local.terraform_drift_bootstrap_provider_policy_configuration

  role       = aws_iam_role.terraform_drift_runner["bootstrap"].name
  policy_arn = aws_iam_policy.terraform_drift_runner_bootstrap_provider[each.key].arn
}

check "terraform_drift_runner_bootstrap_provider_managed_policy_sizes" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || try(alltrue([
        for document in values(data.aws_iam_policy_document.terraform_drift_runner_bootstrap_provider) :
        length(jsonencode(jsondecode(document.json))) <= 6144
      ]), false)
    )
    error_message = "Each exact Bootstrap drift provider-read policy must remain within IAM's 6,144-character managed-policy quota."
  }
}

check "terraform_drift_runner_bootstrap_managed_policy_attachment_quota" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || length(local.terraform_drift_bootstrap_provider_policy_arns) <= 10
    )
    error_message = "The Bootstrap Terraform drift runner must remain within IAM's ten managed-policy attachment quota."
  }
}

data "aws_iam_policy_document" "terraform_drift_runner_foundation_provider" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid       = "ReadExactFoundationProviderResources"
    effect    = "Allow"
    actions   = local.terraform_drift_foundation_provider_scoped_read_actions
    resources = local.terraform_drift_foundation_provider_resource_arns
  }

  statement {
    sid       = "ReadFoundationGlobalProviderInventory"
    effect    = "Allow"
    actions   = local.terraform_drift_foundation_provider_global_read_actions
    resources = ["*"]
  }

  statement {
    sid    = "ReadExactFoundationEcrRetentionRole"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = [local.foundation_ecr_retention_role_arn]
  }

  statement {
    sid    = "ReadExactFoundationEcrRetentionBoundary"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.foundation_ecr_retention_boundary_policy_arn]
  }

  statement {
    sid    = "ReadExactFoundationEcrRetentionLambda"
    effect = "Allow"
    actions = [
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConcurrency",
      "lambda:GetPolicy",
      "lambda:GetRuntimeManagementConfig",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
    ]
    resources = [local.foundation_ecr_retention_function_arn]
  }

  statement {
    sid    = "ReadExactFoundationEcrRetentionSchedule"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
    ]
    resources = [local.foundation_ecr_retention_schedule_arn]
  }

  statement {
    sid       = "ReadExactFoundationEcrRetentionLogGroupTags"
    effect    = "Allow"
    actions   = ["logs:ListTagsForResource"]
    resources = [local.foundation_ecr_retention_log_group_arn]
  }

  statement {
    sid       = "ReadExactFoundationEcrRetentionAuthorityKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
  }
}

resource "aws_iam_role_policy" "terraform_drift_runner_foundation_provider" {
  count = local.terraform_drift_enabled ? 1 : 0

  name   = "${local.terraform_drift_runner_role_names.foundation}-provider-read"
  role   = aws_iam_role.terraform_drift_runner["foundation"].id
  policy = data.aws_iam_policy_document.terraform_drift_runner_foundation_provider[0].json
}

data "aws_iam_policy_document" "terraform_drift_runner_app_provider_core" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid    = "ReadExactAppDynamoDbResources"
    effect = "Allow"
    actions = [
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:ListTagsOfResource",
    ]
    resources = [
      local.app_dynamodb_table_arn_pattern,
      local.app_dynamodb_index_arn_pattern,
    ]
  }

  statement {
    sid    = "ReadExactAppKmsResources"
    effect = "Allow"
    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:GetPublicKey",
      "kms:ListResourceTags",
    ]
    resources = [local.app_data_kms_key_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/StateScope"
      values   = ["app"]
    }
  }

  statement {
    sid       = "ReadAwsManagedDynamoDbKeyMetadata"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [local.app_data_kms_key_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "kms:RequestAlias"
      values   = ["alias/aws/dynamodb"]
    }
  }

  statement {
    sid    = "ReadExactAppIamResources"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = local.app_target_runtime_role_resource_arns
  }

  statement {
    sid       = "ReadExactAppSignatureBoundary"
    effect    = "Allow"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = [local.app_signature_verifier_execution_boundary_policy_arn]
  }

  statement {
    sid    = "ReadExactAppLogGroups"
    effect = "Allow"
    actions = [
      "logs:DescribeMetricFilters",
      "logs:ListTagsForResource",
    ]
    resources = local.app_target_all_log_group_resource_arns
  }

  statement {
    sid       = "ReadExactAppDashboard"
    effect    = "Allow"
    actions   = ["cloudwatch:GetDashboard"]
    resources = [local.app_observability_dashboard_arn]
  }

  statement {
    sid    = "ReadExactAppAlarms"
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource",
    ]
    resources = local.app_cloudwatch_alarm_arns
  }

  statement {
    sid       = "ReadExactAppApiGatewayRuntime"
    effect    = "Allow"
    actions   = ["apigateway:GET"]
    resources = concat(local.app_target_api_arns, local.app_target_api_tagging_arns)
  }
}

data "aws_iam_policy_document" "terraform_drift_runner_app_provider_runtime" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid    = "ReadExactAppAsyncRuntime"
    effect = "Allow"
    actions = [
      "sqs:GetQueueAttributes",
      "sqs:ListQueueTags",
      "states:DescribeStateMachine",
      "states:ListStateMachineVersions",
      "states:ListTagsForResource",
    ]
    resources = concat(local.app_target_async_queue_arns, [local.app_target_state_machine_arn])
  }

  statement {
    sid    = "ReadExactAppEcsRuntime"
    effect = "Allow"
    actions = [
      "ecs:DescribeClusters",
      "ecs:ListTagsForResource",
    ]
    resources = [
      local.app_target_ecs_cluster_arn,
      local.app_target_ecs_task_definition_arn,
    ]
  }

  statement {
    sid    = "ReadExactAppBuckets"
    effect = "Allow"
    actions = [
      "s3:GetAccelerateConfiguration",
      "s3:GetBucketAcl",
      "s3:GetBucketCORS",
      "s3:GetBucketLocation",
      "s3:GetBucketLogging",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetBucketWebsite",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
      "s3:ListTagsForResource",
    ]
    resources = [
      local.app_target_proof_bucket_arn,
      local.app_target_frontend_bucket_arn,
    ]
  }

  statement {
    sid    = "ReadExactAppCloudFrontRuntime"
    effect = "Allow"
    actions = [
      "cloudfront:DescribeFunction",
      "cloudfront:GetCachePolicy",
      "cloudfront:GetDistribution",
      "cloudfront:GetFunction",
      "cloudfront:GetOriginAccessControl",
      "cloudfront:GetOriginRequestPolicy",
      "cloudfront:GetResponseHeadersPolicy",
      "cloudfront:ListTagsForResource",
    ]
    resources = local.app_target_cloudfront_read_resource_arns
  }

  statement {
    sid    = "ReadExactAppObservabilityNotificationTopics"
    effect = "Allow"
    actions = [
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
    ]
    resources = local.app_observability_sns_topic_arns
  }

  statement {
    sid    = "ReadExactAppEventRules"
    effect = "Allow"
    actions = [
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
    ]
    resources = local.app_target_event_rule_arns
  }

  statement {
    sid       = "ReadExactAppLambdaVersions"
    effect    = "Allow"
    actions   = ["lambda:ListVersionsByFunction"]
    resources = local.app_target_lambda_version_inventory_arns
  }

  statement {
    sid    = "ReadExactAppLambdaRuntime"
    effect = "Allow"
    actions = [
      "lambda:GetAlias",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetPolicy",
      "lambda:ListTags",
    ]
    resources = concat(
      [local.app_target_lambda_arn_pattern, "${local.app_target_lambda_arn_pattern}:*"],
      local.app_signature_verifier_alias_arns,
    )
  }

  statement {
    sid    = "ReadExactAppLambdaEventSourceMappings"
    effect = "Allow"
    actions = [
      "lambda:GetEventSourceMapping",
      "lambda:ListTags",
    ]
    resources = [local.app_target_lambda_event_source_mapping_arn_pattern]
  }

  statement {
    sid    = "ReadAppGlobalProviderInventory"
    effect = "Allow"
    actions = [
      "cloudfront:GetKeyGroup",
      "cloudfront:GetPublicKey",
      "cloudwatch:ListDashboards",
      "ecs:DescribeTaskDefinition",
      "kms:ListAliases",
      "lambda:ListEventSourceMappings",
      "logs:DescribeLogGroups",
      "logs:DescribeQueryDefinitions",
      "sns:GetSubscriptionAttributes",
      "ssm:DescribeParameters",
      "states:ValidateStateMachineDefinition",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "terraform_drift_runner_app_provider" {
  for_each = local.terraform_drift_runner_app_provider_policy_configuration

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name = each.value.name
  policy = {
    core    = data.aws_iam_policy_document.terraform_drift_runner_app_provider_core[0].json
    runtime = data.aws_iam_policy_document.terraform_drift_runner_app_provider_runtime[0].json
  }[each.key]
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "terraform_drift_runner_app_provider" {
  for_each = local.terraform_drift_runner_app_provider_policy_configuration

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.terraform_drift_runner["app"].name
  policy_arn = aws_iam_policy.terraform_drift_runner_app_provider[each.key].arn
}

check "terraform_drift_runner_app_provider_managed_policy_sizes" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_provider_core[0].json))) <= 6144
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_provider_runtime[0].json))) <= 6144,
        false,
      )
    )
    error_message = "Each App Terraform drift provider-read managed policy must remain within IAM's 6,144-character quota."
  }
}

data "aws_iam_policy_document" "terraform_drift_runner_foundation_exact" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid    = "ReadExactFoundationSecretMetadata"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
    ]
    resources = local.foundation_runtime_secret_arns
  }

  statement {
    sid    = "ReadExactFoundationParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:ListTagsForResource",
    ]
    resources = local.foundation_runtime_ssm_parameter_arns
  }
}

resource "aws_iam_role_policy" "terraform_drift_runner_foundation_exact" {
  count = local.terraform_drift_enabled ? 1 : 0

  name   = "${local.terraform_drift_runner_role_names.foundation}-exact-read"
  role   = aws_iam_role.terraform_drift_runner["foundation"].id
  policy = data.aws_iam_policy_document.terraform_drift_runner_foundation_exact[0].json
}

data "aws_iam_policy_document" "terraform_drift_runner_app_sensitive" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid    = "ReadExactAppSecretMetadata"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
    ]
    resources = [
      local.app_expected_origin_verify_header_secret_arn,
      local.app_log_ip_hash_salt_secret_arn,
    ]
  }

  statement {
    sid       = "ReadExactAppOriginSecretValue"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.app_expected_origin_verify_header_secret_arn]
  }

  statement {
    sid    = "ReadExactAppRuntimeParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:ListTagsForResource",
    ]
    resources = [local.app_runtime_ssm_parameter_arn]
  }

  statement {
    sid     = "ReadExactAppObservabilityEmailParameters"
    effect  = "Allow"
    actions = ["ssm:GetParametersByPath"]
    resources = concat(
      local.app_observability_email_parameter_path_arns,
      local.app_observability_email_parameter_children_arns,
    )

    condition {
      test     = "StringEquals"
      variable = "ssm:Recursive"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DecryptExactAppObservabilityEmailParameters"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = local.app_observability_email_parameter_arns
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadExactAppSemaphoreItem"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [local.app_target_prover_semaphore_table_arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = [local.app_target_prover_semaphore_lock_name]
    }
  }

  statement {
    sid       = "DecryptExactAppSemaphoreItem"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [local.app_data_kms_key_arn_pattern]

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
      values   = [local.app_target_prover_semaphore_table_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/StateScope"
      values   = ["app"]
    }
  }
}

resource "aws_iam_role_policy" "terraform_drift_runner_app_sensitive" {
  count = local.terraform_drift_enabled ? 1 : 0

  name   = "${local.terraform_drift_runner_role_names.app}-sensitive-read"
  role   = aws_iam_role.terraform_drift_runner["app"].id
  policy = data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json
}

check "terraform_drift_runner_role_inline_policy_quotas" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner["bootstrap"].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner["foundation"].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_foundation_provider[0].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_foundation_exact[0].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner["app"].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json))) <= 10240,
        false,
      )
    )
    error_message = "Each Terraform drift runner role must remain within IAM's aggregate 10,240-character inline-policy quota."
  }
}

resource "aws_codebuild_project" "terraform_drift_bootstrap" {
  count = local.terraform_drift_enabled ? 1 : 0

  depends_on = [terraform_data.terraform_report_only_execution_authorization_propagation]

  name                   = local.terraform_drift_runner_project_names.bootstrap
  service_role           = aws_iam_role.terraform_drift_runner["bootstrap"].arn
  build_timeout          = 30
  concurrent_build_limit = 1
  source_version         = var.control_source_sha

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_SOURCE_CONNECTION_ARN"
      value = aws_codeconnections_connection.source[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_TARGET_KEY"
      value = local.deployment_target.targetKey
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_ROOT"
      value = "bootstrap"
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_BUCKET"
      value = local.terraform_authority_bucket_name
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_KMS_KEY_ARN"
      value = aws_kms_key.terraform_authority[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_REPORT_PREFIX"
      value = local.terraform_drift_report_prefix
    }
    environment_variable {
      name  = "TERRAFORM_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_KEY_ARN"
      value = aws_kms_key.state.arn
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_ALIAS"
      value = var.state_kms_alias
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.terraform_drift_codebuild_log_groups.log_groups[local.terraform_drift_runner_project_names.bootstrap].name
      stream_name = "bootstrap"
    }
  }

  source {
    type                = "GITHUB"
    location            = local.deployment_target.repositoryUrl
    git_clone_depth     = 0
    insecure_ssl        = false
    report_build_status = false
    buildspec           = "infra/framework/buildspecs/terraform-drift-runner.yml"

    git_submodules_config {
      fetch_submodules = false
    }

    auth {
      type     = "CODECONNECTIONS"
      resource = aws_codeconnections_connection.source[0].arn
    }
  }

  tags = local.common_tags
}

resource "aws_codebuild_project" "terraform_drift_foundation" {
  count = local.terraform_drift_enabled ? 1 : 0

  depends_on = [terraform_data.terraform_report_only_execution_authorization_propagation]

  name                   = local.terraform_drift_runner_project_names.foundation
  service_role           = aws_iam_role.terraform_drift_runner["foundation"].arn
  build_timeout          = 30
  concurrent_build_limit = 1
  source_version         = var.control_source_sha

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_SOURCE_CONNECTION_ARN"
      value = aws_codeconnections_connection.source[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_TARGET_KEY"
      value = local.deployment_target.targetKey
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_ROOT"
      value = "foundation"
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_BUCKET"
      value = local.terraform_authority_bucket_name
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_KMS_KEY_ARN"
      value = aws_kms_key.terraform_authority[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_REPORT_PREFIX"
      value = local.terraform_drift_report_prefix
    }
    environment_variable {
      name  = "TERRAFORM_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_KEY_ARN"
      value = aws_kms_key.state.arn
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_ALIAS"
      value = var.state_kms_alias
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.terraform_drift_codebuild_log_groups.log_groups[local.terraform_drift_runner_project_names.foundation].name
      stream_name = "foundation"
    }
  }

  source {
    type                = "GITHUB"
    location            = local.deployment_target.repositoryUrl
    git_clone_depth     = 0
    insecure_ssl        = false
    report_build_status = false
    buildspec           = "infra/framework/buildspecs/terraform-drift-runner.yml"

    git_submodules_config {
      fetch_submodules = false
    }

    auth {
      type     = "CODECONNECTIONS"
      resource = aws_codeconnections_connection.source[0].arn
    }
  }

  tags = merge(local.common_tags, { StateScope = "foundation" })
}

resource "aws_codebuild_project" "terraform_drift_app" {
  count = local.terraform_drift_enabled ? 1 : 0

  depends_on = [terraform_data.terraform_report_only_execution_authorization_propagation]

  name                   = local.terraform_drift_runner_project_names.app
  service_role           = aws_iam_role.terraform_drift_runner["app"].arn
  build_timeout          = 30
  concurrent_build_limit = 1
  source_version         = var.control_source_sha

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_SOURCE_CONNECTION_ARN"
      value = aws_codeconnections_connection.source[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_TARGET_KEY"
      value = local.deployment_target.targetKey
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_ROOT"
      value = "app"
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_BUCKET"
      value = local.terraform_authority_bucket_name
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_KMS_KEY_ARN"
      value = aws_kms_key.terraform_authority[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_DRIFT_REPORT_PREFIX"
      value = local.terraform_drift_report_prefix
    }
    environment_variable {
      name  = "TERRAFORM_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_KEY_ARN"
      value = aws_kms_key.state.arn
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_ALIAS"
      value = var.state_kms_alias
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.terraform_drift_codebuild_log_groups.log_groups[local.terraform_drift_runner_project_names.app].name
      stream_name = "app"
    }
  }

  source {
    type                = "GITHUB"
    location            = local.deployment_target.repositoryUrl
    git_clone_depth     = 0
    insecure_ssl        = false
    report_build_status = false
    buildspec           = "infra/framework/buildspecs/terraform-drift-runner.yml"

    git_submodules_config {
      fetch_submodules = false
    }

    auth {
      type     = "CODECONNECTIONS"
      resource = aws_codeconnections_connection.source[0].arn
    }
  }

  tags = merge(local.common_tags, { StateScope = "app" })
}
