data "aws_iam_policy_document" "app_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.terraform_authority_decrypt[0].json]

  statement {
    effect = "Allow"

    actions = ["s3:*"]
    resources = compact([
      local.app_retained_artifact_bucket_arn,
      "${local.app_retained_artifact_bucket_arn}/*",
      local.app_pipeline_execution_artifact_bucket_arn,
      "${local.app_pipeline_execution_artifact_bucket_arn}/*",
      local.app_target_proof_bucket_arn,
      "${local.app_target_proof_bucket_arn}/*",
      local.app_target_frontend_bucket_arn,
      "${local.app_target_frontend_bucket_arn}/*",
    ])
  }

  statement {
    sid    = "AppReleaseManifestReadGuardrail"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.app_toolchain_promotion_object_arn,
      local.app_prover_promotion_object_arn,
      local.foundation_checkpoint_object_arn,
      local.app_toolchain_candidate_records_objects_arn,

      local.app_prover_candidate_records_objects_arn,

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
    effect = "Allow"

    actions = [
      "apigateway:*",
      "batch:*",
      "cloudformation:*",
      "cloudfront:*",
      "cloudwatch:*",
      "codebuild:*",
      "codepipeline:*",
      "dynamodb:*",
      "ecr:GetAuthorizationToken",
      "ecs:*",
      "kms:*",
      "lambda:*",
      "logs:*",
      # These subscription APIs expose no resource-level IAM type. Attached
      # identities retain the exact lifecycle action set.
      "sns:GetSubscriptionAttributes",
      "sns:SetSubscriptionAttributes",
      "sns:Unsubscribe",
      "sqs:*",
      "ssm:*",
      "states:*",
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
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [local.foundation_risc0_toolchain_ecr_repository_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["events:*"]
    resources = ["arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.app_runtime_name_prefix}-*"]
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
      aws_secretsmanager_secret.app_ci_validation_github[0].arn,
    ]
  }

  statement {
    sid    = "AppIamGuardrail"
    effect = "Allow"

    actions = ["iam:*"]
    resources = [
      local.app_pipeline_role_arn_pattern,
      local.app_batch_service_role_arn,
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

  # Each API admits only its own service's resource types; combining the
  # ECR and Signer grants preserves the exact Prover repository/trust scope.
  statement {
    sid    = "VerifyProverSignature"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImageSigningStatus",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:GetDownloadUrlForLayer",
      "signer:GetRevocationStatus",
    ]
    resources = [
      local.foundation_prover_ecr_repository_arn,
      local.foundation_ecr_signing_profile_arn,
      local.foundation_signing_job_arn_pattern,
    ]
  }

}

# Statement IDs are review metadata, not authorization semantics. Omit them in
# the installed boundary to keep the exact grants within IAM's size quota.
locals {
  app_deploy_boundary_policy = local.app_pipeline_enabled ? jsonencode({
    Version = "2012-10-17"
    Statement = [for statement in jsondecode(data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json).Statement : {
      for key, value in statement : key => value if key != "Sid"
    }]
  }) : null
}

resource "aws_iam_policy" "app_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0


  name   = local.app_deploy_permissions_boundary_policy_name
  policy = local.app_deploy_boundary_policy
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

check "app_deploy_permissions_boundary_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(local.app_deploy_boundary_policy) <= 6144, false)
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


  name   = local.app_signature_verifier_execution_boundary_policy_name
  policy = data.aws_iam_policy_document.app_signature_verifier_execution_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
