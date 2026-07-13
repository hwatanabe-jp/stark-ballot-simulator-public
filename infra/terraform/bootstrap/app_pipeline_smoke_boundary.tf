data "aws_iam_policy_document" "app_smoke_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::${local.app_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.app_pipeline_artifact_bucket_name}/*",
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
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
      "codepipeline:GetPipelineExecution",
      "codepipeline:GetPipelineState",
      "codepipeline:ListActionExecutions",
      "codepipeline:ListPipelineExecutions",
      "codepipeline:StartPipelineExecution",
    ]
    resources = concat(local.app_codebuild_project_arns, [local.app_pipeline_arn])
  }

  statement {
    sid    = "AppSmokeSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
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

    resources = concat(
      local.app_dynamodb_table_arns,
      local.app_dynamodb_index_arns,
      local.app_dynamodb_recovery_table_arn_patterns,
    )
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
    effect    = "Allow"
    actions   = ["lambda:GetFunctionConfiguration"]
    resources = [local.app_target_lambda_arn_pattern]
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
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_artifacts_management,
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
