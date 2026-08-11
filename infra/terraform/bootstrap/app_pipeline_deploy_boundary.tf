data "aws_iam_policy_document" "app_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    effect = "Allow"

    actions = ["s3:*"]
    resources = [
      local.app_retained_artifact_bucket_arn,
      "${local.app_retained_artifact_bucket_arn}/*",
      local.app_pipeline_execution_artifact_bucket_arn,
      "${local.app_pipeline_execution_artifact_bucket_arn}/*",
      local.app_static_fast_execution_artifact_bucket_arn,
      "${local.app_static_fast_execution_artifact_bucket_arn}/*",
      local.app_target_proof_bucket_arn,
      "${local.app_target_proof_bucket_arn}/*",
      local.app_target_frontend_bucket_arn,
      "${local.app_target_frontend_bucket_arn}/*",
    ]
  }

  statement {
    sid    = "AppReleaseManifestReadGuardrail"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [local.app_release_manifest_bucket_objects_arn]
  }

  statement {
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      local.app_deployment_record_objects_arn,
    ]
  }

  statement {
    sid    = "AppStateRead"
    effect = "Allow"

    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/${local.app_state_backend_key}"]
  }

  statement {
    sid    = "AppStateLockfileAccess"
    effect = "Allow"

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/${local.app_state_backend_key}.tflock"]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}"]
  }

  statement {
    sid    = "AppKmsGuardrail"
    effect = "Allow"

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AppPipelineGuardrail"
    effect = "Allow"

    actions = [
      "codebuild:*",
      "codepipeline:*",
      "logs:*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    effect = "Allow"

    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:PassConnection",
      "codeconnections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
      "codestar-connections:PassConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "AppRuntimeGuardrail"
    effect = "Allow"

    actions = [
      "apigateway:*",
      "cloudfront:*",
      "cloudwatch:*",
      "dynamodb:*",
      "ecs:*",
      "lambda:*",
      "sqs:*",
      "ssm:*",
      "states:*",
    ]
    resources = ["*"]
  }

  statement {
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
    effect = "Allow"

    actions = [
      "sns:GetSubscriptionAttributes",
      "sns:SetSubscriptionAttributes",
      "sns:Unsubscribe",
    ]
    # These APIs do not expose a resource-level IAM type. The attached apply
    # role remains restricted to this exact lifecycle action set.
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = local.app_release_image_repository_arns
  }

  statement {
    effect    = "Allow"
    actions   = ["events:*"]
    resources = local.app_target_event_rule_arns
  }

  statement {
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
    sid    = "AppIamGuardrail"
    effect = "Allow"

    actions = ["iam:*"]
    resources = [
      local.app_pipeline_role_arn_pattern,
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_runtime_name_prefix}-*",
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_verifier_role_name}",
    ]
  }

  statement {
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = [local.app_signature_verifier_execution_boundary_policy_arn]
  }
}

resource "aws_iam_policy" "app_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

  name   = local.app_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

check "app_deploy_permissions_boundary_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json))) <= 6144, false)
    )
    error_message = "The app deploy permissions boundary must remain within the IAM 6,144-character quota."
  }
}

data "aws_iam_policy_document" "app_signature_verifier_execution_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "WriteImageSignatureVerifierLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.app_signature_verifier_lambda_name}:*",
    ]
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
    resources = [local.foundation_prover_ecr_repository_arn]
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
      local.foundation_ecr_signing_profile_arn,
      local.foundation_signing_job_arn_pattern,
    ]
  }
}

resource "aws_iam_policy" "app_signature_verifier_execution_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
  ]

  name   = local.app_signature_verifier_execution_boundary_policy_name
  policy = data.aws_iam_policy_document.app_signature_verifier_execution_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
