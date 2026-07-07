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

    resources = concat(local.app_dynamodb_table_arns, local.app_dynamodb_index_arns)
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
      test     = "ForAnyValue:StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = local.app_dynamodb_table_names
    }
  }
}

resource "aws_iam_role_policy" "app_terraform_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_terraform_smoke_role_name}-policy"
  role   = aws_iam_role.app_terraform_smoke[0].id
  policy = data.aws_iam_policy_document.app_terraform_smoke[0].json
}
