data "aws_iam_policy_document" "app_deployment_record" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "WriteAppDeploymentRecordLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.app_pipeline_codebuild[local.app_deployment_record_project_name].arn}:*",
    ]
  }

  statement {
    sid    = "UseAppDeploymentRecordPipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.app_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UseAppDeploymentRecordPipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }

  statement {
    sid    = "ReadAcceptedReleaseAuthority"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.app_toolchain_accepted_pointer_object_arn,
      local.app_prover_accepted_pointer_object_arn,
      local.app_foundation_networking_handoff_object_arn,
      local.app_toolchain_artifact_records_objects_arn,
      local.app_prover_release_records_objects_arn,
      local.app_deployment_record_objects_arn,
    ]
  }

  statement {
    sid    = "WriteGeneratedAppDeploymentRecords"
    effect = "Allow"

    actions = [
      "s3:PutObject",
    ]
    resources = [
      local.app_deployment_record_objects_arn,
    ]
  }
}

resource "aws_iam_role_policy" "app_deployment_record" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_deployment_record_role_name}-policy"
  role   = aws_iam_role.app_deployment_record[0].id
  policy = data.aws_iam_policy_document.app_deployment_record[0].json
}

data "aws_iam_policy_document" "app_codebuild_common" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSharedSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "WriteAppCodeBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      for log_group in aws_cloudwatch_log_group.app_pipeline_codebuild :
      "${log_group.arn}:*"
    ]
  }

  statement {
    sid    = "UseAppPipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.app_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.app_pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UseAppPipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

data "aws_iam_policy_document" "app_terraform_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ReadImmutableReleaseAuthority"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.app_toolchain_artifact_records_objects_arn,
      local.app_prover_release_records_objects_arn,
    ]
  }

  statement {
    sid    = "ReadSelectedReleaseImageDigests"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = local.app_release_image_repository_arns
  }

  statement {
    sid    = "ReadAppStateBackend"
    effect = "Allow"

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
  }

  statement {
    sid    = "UseAppStateLockfile"
    effect = "Allow"

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}.tflock"]
  }

  statement {
    sid    = "ListAppStatePrefix"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "stark-ballot-simulator/stark-dev/develop/app/",
        "stark-ballot-simulator/stark-dev/develop/app/*",
      ]
    }
  }

  statement {
    sid    = "UseAppStateKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
    ]
    resources = [aws_kms_key.state.arn]
  }

  statement {
    sid    = "ReadTargetDynamoDbResources"
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
    sid    = "ReadTargetKmsResources"
    effect = "Allow"

    actions = [
      "kms:DescribeKey",
      "kms:GetPublicKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
    ]
    resources = [local.app_data_kms_key_arn_pattern]
  }

  statement {
    sid       = "ListTargetKmsAliases"
    effect    = "Allow"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadTargetAlarms"
    effect = "Allow"

    actions = [
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource",
    ]
    resources = local.app_cloudwatch_alarm_arns
  }

  statement {
    sid    = "ReadTargetRuntimeConfigParameters"
    effect = "Allow"

    actions = [
      "ssm:GetParameter",
      "ssm:ListTagsForResource",
    ]
    resources = [local.app_runtime_ssm_parameter_arn]
  }

  statement {
    sid    = "ReadTargetRuntimeSecrets"
    effect = "Allow"

    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      local.app_expected_origin_verify_header_secret_arn,
      local.app_log_ip_hash_salt_secret_arn,
    ]
  }

  statement {
    sid    = "ReadTargetRuntimeRole"
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
    sid    = "ReadImageSignatureVerifierExecutionBoundary"
    effect = "Allow"

    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = [local.app_signature_verifier_execution_boundary_policy_arn]
  }

  statement {
    sid    = "ReadTargetRuntimeLogGroups"
    effect = "Allow"

    actions = [
      "logs:DescribeLogGroups",
      "logs:ListTagsForResource",
    ]
    resources = local.app_target_all_log_group_resource_arns
  }

  statement {
    sid    = "ReadTargetLambdaRuntime"
    effect = "Allow"

    actions = [
      "lambda:GetEventSourceMapping",
      "lambda:GetAlias",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetPolicy",
      "lambda:ListEventSourceMappings",
      "lambda:ListTags",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ReadTargetApiGatewayRuntime"
    effect = "Allow"

    actions   = ["apigateway:GET"]
    resources = concat(local.app_target_api_arns, local.app_target_api_tagging_arns)
  }

  statement {
    sid    = "ReadTargetAsyncRuntime"
    effect = "Allow"

    actions = [
      "sqs:GetQueueAttributes",
      "sqs:ListQueueTags",
      "states:DescribeStateMachine",
      "states:ListTagsForResource",
    ]
    resources = [local.app_target_queue_arn, local.app_target_state_machine_arn]
  }

  statement {
    sid       = "ReadTargetSemaphoreItem"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [local.app_target_prover_semaphore_table_arn]
  }

  statement {
    sid       = "ReadTargetSemaphoreItemKey"
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
  }

  statement {
    sid    = "ReadTargetEcsRuntime"
    effect = "Allow"

    actions = [
      "ecs:DescribeClusters",
      "ecs:DescribeTaskDefinition",
      "ecs:ListTagsForResource",
    ]
    resources = [
      local.app_target_ecs_cluster_arn,
      local.app_target_ecs_task_definition_arn,
      "*",
    ]
  }

  statement {
    sid    = "ReadTargetAppBuckets"
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
    ]
    resources = [
      local.app_target_proof_bucket_arn,
      local.app_target_frontend_bucket_arn,
    ]
  }

  statement {
    sid    = "ReadTargetCloudFrontRuntime"
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
    sid    = "ReadTargetCloudFrontGlobalRuntime"
    effect = "Allow"

    actions = [
      "cloudfront:GetKeyGroup",
      "cloudfront:GetPublicKey",
    ]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "app_terraform_plan_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadTargetMetricFilters"
    effect    = "Allow"
    actions   = ["logs:DescribeMetricFilters"]
    resources = local.app_target_all_log_group_resource_arns
  }

  statement {
    sid    = "ReadTargetObservabilityDashboard"
    effect = "Allow"

    actions = [
      "cloudwatch:GetDashboard",
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
    sid    = "ReadTargetInvariantNotificationTopic"
    effect = "Allow"

    actions = [
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
    ]
    resources = [local.app_invariant_sns_topic_arn]
  }

  statement {
    sid    = "ReadTargetInvariantEmailSubscription"
    effect = "Allow"

    actions = [
      "sns:GetSubscriptionAttributes",
    ]
    # GetSubscriptionAttributes has no resource-level IAM type.
    resources = ["*"]
  }

  statement {
    sid    = "ReadTargetInvariantEmailParameter"
    effect = "Allow"

    actions = ["ssm:GetParametersByPath"]
    resources = [
      local.app_invariant_email_parameter_path_arn,
      local.app_invariant_email_parameter_children_arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "ssm:Recursive"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DecryptTargetInvariantEmailParameter"
    effect = "Allow"

    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.app_invariant_email_parameter_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadTargetLogQueryDefinitions"
    effect    = "Allow"
    actions   = ["logs:DescribeQueryDefinitions"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadTargetSemaphoreJanitorEvents"
    effect = "Allow"

    actions = [
      "events:DescribeRule",
      "events:ListTagsForResource",
      "events:ListTargetsByRule",
    ]
    resources = local.app_target_event_rule_arns
  }

  statement {
    sid       = "ReadTargetRuntimeConfigParameterBatch"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = [local.app_runtime_ssm_parameter_arn]
  }

  statement {
    sid       = "ReadTargetRuntimeConfigParameterInventory"
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    sid       = "ValidateTargetStateMachineDefinition"
    effect    = "Allow"
    actions   = ["states:ValidateStateMachineDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadTargetStateMachineVersionInventory"
    effect    = "Allow"
    actions   = ["states:ListStateMachineVersions"]
    resources = [local.app_target_state_machine_arn]
  }

  statement {
    sid    = "ReadTargetLambdaVersionInventory"
    effect = "Allow"

    actions = [
      "lambda:ListVersionsByFunction",
    ]
    resources = local.app_target_lambda_version_inventory_arns
  }

  statement {
    sid       = "ReadTargetRuntimeLogGroupInventory"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadTargetAsyncQueueInventory"
    effect = "Allow"

    actions = [
      "sqs:GetQueueAttributes",
      "sqs:ListQueueTags",
    ]
    resources = local.app_target_async_queue_arns
  }
}

resource "aws_iam_policy" "app_codebuild_common" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name   = local.app_codebuild_common_policy_name
  policy = data.aws_iam_policy_document.app_codebuild_common[0].json
  tags   = local.common_tags

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.app_codebuild_common[0].json))) <= 6144
      error_message = "The shared app CodeBuild managed policy must remain within the IAM 6,144-character quota."
    }
  }
}

resource "aws_iam_role_policy_attachment" "app_codebuild_common_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_plan[0].name
  policy_arn = aws_iam_policy.app_codebuild_common[0].arn
}

resource "aws_iam_role_policy_attachment" "app_codebuild_common_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_codebuild_common[0].arn
}

resource "aws_iam_policy" "app_terraform_plan_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management]

  name   = local.app_terraform_plan_runtime_policy_name
  policy = data.aws_iam_policy_document.app_terraform_plan_runtime[0].json
  tags   = local.common_tags
}

resource "aws_iam_role_policy_attachment" "app_terraform_plan_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_plan[0].name
  policy_arn = aws_iam_policy.app_terraform_plan_runtime[0].arn
}

resource "aws_iam_role_policy_attachment" "app_terraform_apply_plan_runtime" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]

  role       = aws_iam_role.app_terraform_apply[0].name
  policy_arn = aws_iam_policy.app_terraform_plan_runtime[0].arn
}

resource "aws_iam_role_policy" "app_terraform_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_terraform_plan_role_name}-policy"
  role   = aws_iam_role.app_terraform_plan[0].id
  policy = data.aws_iam_policy_document.app_terraform_plan[0].json

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_plan[0].json))) <= 10240
      error_message = "The app Terraform plan inline policy must remain within the IAM 10,240-character role-policy quota."
    }
  }
}
