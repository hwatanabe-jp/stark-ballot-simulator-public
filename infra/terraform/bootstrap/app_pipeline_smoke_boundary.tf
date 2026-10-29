data "aws_iam_policy_document" "app_smoke_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [
    data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json,
    data.aws_iam_policy_document.terraform_authority_decrypt[0].json,
  ]

  # Keep this exact-resource statement SID-free so the rendered managed policy
  # remains below IAM's 6,144-character quota.

  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
    resources = ["${local.deployment_record_prefixes.app}/*"]
  }
  statement {
    actions   = ["s3:ListBucketVersions"]
    resources = [local.deployment_record_roots.app.bucket]
  }

  statement {
    actions   = ["codebuild:BatchGetBuilds"]
    resources = ["arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.managed_codebuild_executions.app_terraform_smoke.project}"]
  }
  statement {
    actions   = ["codepipeline:ListActionExecutions", "codepipeline:GetPipelineExecution"]
    resources = ["arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.managed_codebuild_executions.app_terraform_smoke.pipeline}"]
  }


  statement {
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = compact([
      local.app_retained_artifact_bucket_arn,
      "${local.app_retained_artifact_bucket_arn}/*",
      local.app_pipeline_execution_artifact_bucket_arn,
      "${local.app_pipeline_execution_artifact_bucket_arn}/*",
    ])
  }

  # Smoke can inspect only the exact selected Foundation checkpoint version.
  statement {
    effect  = "Allow"
    actions = ["s3:GetObjectVersion"]
    resources = [
      local.foundation_checkpoint_object_arn,
    ]
  }


  statement {
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/StateScope"
      values   = ["app"]
    }
  }

  statement {
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "NoRuntimeMutationPermissions"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid       = "PublishAcceptedDeploymentEvent"
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${var.aws_region}:${var.aws_account_id}:event-bus/default"]

    condition {
      test     = "StringEquals"
      variable = "events:source"
      values   = ["stark-ballot.observability"]
    }

    condition {
      test     = "StringEquals"
      variable = "events:detail-type"
      values   = ["Accepted Deployment"]
    }
  }

  statement {
    effect = "Allow"

    actions = [
      "kms:DescribeKey",
      "kms:GetPublicKey",
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
    effect = "Allow"
    actions = [
      "cloudfront:GetKeyGroup",
      "cloudfront:GetPublicKey",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "TargetDynamoDbDataPlaneSmoke"
    effect = "Allow"

    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]

    resources = [
      local.app_dynamodb_table_arn_pattern,
      local.app_dynamodb_index_arn_pattern,
    ]
  }

  statement {
    sid    = "TargetDynamoDbKmsDataPlaneSmoke"
    effect = "Allow"

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
      test     = "ForAnyValue:StringLike"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = local.app_dynamodb_table_names
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "lambda:GetAlias",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = concat(
      [local.app_target_lambda_arn_pattern],
      [
        local.app_signature_verifier_lambda_arn,
        "${local.app_signature_verifier_lambda_arn}:*",
      ],
    )
  }

  statement {
    effect    = "Allow"
    actions   = ["states:DescribeStateMachine"]
    resources = [local.app_target_state_machine_arn]
  }

  statement {
    sid    = "ReadImageSignatureVerifierLiveIam"
    effect = "Allow"

    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
    ]
    resources = [
      local.app_signature_verifier_role_arn,
      local.app_signature_verifier_execution_boundary_policy_arn,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["lambda:GetEventSourceMapping"]
    resources = ["*"]
  }

  statement {
    sid     = "AppSmokeSelfPolicySimulation"
    effect  = "Allow"
    actions = ["iam:SimulatePrincipalPolicy"]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_smoke_role_name}",
    ]
  }
}

resource "aws_iam_policy" "app_smoke_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0


  name   = local.app_smoke_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.app_smoke_deploy_permissions_boundary[0].json

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.app_smoke_deploy_permissions_boundary[0].json))) <= 6144
      error_message = "App smoke permissions boundary exceeds the IAM managed-policy size quota."
    }
  }

  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}
