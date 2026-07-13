data "aws_iam_policy_document" "app_terraform_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_codebuild_common[0].json]

  statement {
    sid       = "ReadOnlySmokeIdentity"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadTargetOperatorGateKmsPublicKeys"
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
    sid    = "ReadTargetOperatorGateCloudFrontKeys"
    effect = "Allow"
    actions = [
      "cloudfront:GetKeyGroup",
      "cloudfront:GetPublicKey",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SmokeSelfPolicySimulation"
    effect = "Allow"

    actions   = ["iam:SimulatePrincipalPolicy"]
    resources = [aws_iam_role.app_terraform_smoke[0].arn]
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
    sid       = "ReadTargetRecoveryLambdaConfig"
    effect    = "Allow"
    actions   = ["lambda:GetFunctionConfiguration"]
    resources = local.app_target_lambda_arns
  }

  statement {
    sid       = "ReadTargetRecoveryEventSourceMappings"
    effect    = "Allow"
    actions   = ["lambda:GetEventSourceMapping"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "app_terraform_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_terraform_smoke_role_name}-policy"
  role   = aws_iam_role.app_terraform_smoke[0].id
  policy = data.aws_iam_policy_document.app_terraform_smoke[0].json
}
