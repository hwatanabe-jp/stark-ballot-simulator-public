data "aws_iam_policy_document" "app_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "AppOwnedS3Guardrail"
    effect = "Allow"

    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${local.app_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.app_pipeline_artifact_bucket_name}/*",
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
    resources = [
      local.app_toolchain_accepted_pointer_object_arn,
      local.app_prover_accepted_pointer_object_arn,
      local.app_toolchain_artifact_records_objects_arn,
      local.app_prover_release_records_objects_arn,
      local.app_deployment_record_objects_arn,
    ]
  }

  statement {
    sid     = "AppGeneratedReleaseAuthorityWriteGuardrail"
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
    sid       = "AppStatePrefixList"
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
    sid    = "AppSourceConnectionGuardrail"
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
    sid    = "AppSelectedReleaseImageReadGuardrail"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = local.app_release_image_repository_arns
  }

  statement {
    sid       = "AppTargetEventBridgeGuardrail"
    effect    = "Allow"
    actions   = ["events:*"]
    resources = local.app_target_event_rule_arns
  }

  statement {
    sid    = "AppRuntimeSecretReadGuardrail"
    effect = "Allow"

    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]
    resources = [local.app_expected_origin_verify_header_secret_arn]
  }

  statement {
    sid    = "AppIamGuardrail"
    effect = "Allow"

    actions = ["iam:*"]
    resources = [
      local.app_pipeline_role_arn_pattern,
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_runtime_name_prefix}-*",
    ]
  }
}

resource "aws_iam_policy" "app_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management,
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
