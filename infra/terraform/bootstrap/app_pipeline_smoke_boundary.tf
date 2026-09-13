data "aws_iam_policy_document" "app_smoke_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json]

  # Keep this exact-resource statement SID-free so the rendered managed policy
  # remains below IAM's 6,144-character quota.
  statement {
    effect  = "Allow"
    actions = ["codebuild:BatchGetProjects"]
    resources = compact([
      local.source_path_app_start_build_projects.app_smoke.project_arn,
      local.app_static_fast_enabled ? local.source_path_static_fast_start_build_projects.app_static_fast_smoke_lite.project_arn : null,
    ])
  }

  statement {
    effect    = "Allow"
    actions   = ["sts:AssumeRole"]
    resources = [local.app_acceptance_publisher_role_arn]
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
      local.app_static_fast_enabled ? local.app_static_fast_execution_artifact_bucket_arn : null,
      local.app_static_fast_enabled ? "${local.app_static_fast_execution_artifact_bucket_arn}/*" : null,
    ])
  }

  # The Smoke identity below this ceiling retains exact record/pointer
  # families. Static-fast shares the boundary but receives no matching
  # identity grant.
  statement {
    effect  = "Allow"
    actions = ["s3:GetObjectVersion"]
    resources = [
      "${local.app_release_manifest_bucket_arn}/*",
      local.app_foundation_acceptance_records_objects_arn,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
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
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
      "codepipeline:GetPipelineExecution",
      "codepipeline:GetPipelineState",
      "codepipeline:ListActionExecutions",
      "codepipeline:ListPipelineExecutions",
      "codepipeline:StartPipelineExecution",
    ]
    resources = [
      local.app_codebuild_project_arn_pattern,
      local.app_pipeline_arn,
    ]
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
      values   = concat(local.app_dynamodb_table_names, local.app_dynamodb_recovery_table_name_patterns)
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

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
  ]

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
