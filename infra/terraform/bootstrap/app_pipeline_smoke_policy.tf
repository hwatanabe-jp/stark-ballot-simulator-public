data "aws_iam_policy_document" "app_terraform_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.terraform_authority_decrypt[0].json]


  statement {
    sid       = "ReadExactFoundationCheckpointForSmoke"
    effect    = "Allow"
    actions   = ["s3:GetObjectVersion"]
    resources = [local.foundation_checkpoint_object_arn]
  }

  statement {
    sid     = "ReadRetainedSignaturePreflightAndVerifierPackageForSmoke"
    effect  = "Allow"
    actions = ["s3:GetObjectVersion"]
    resources = [
      local.app_retained_signature_preflight_objects_arn,
      local.app_retained_image_signature_verifier_package_objects_arn,
    ]
  }

  statement {
    sid       = "ReadApprovedFrontendManifestForSmoke"
    effect    = "Allow"
    actions   = ["s3:GetObjectVersion"]
    resources = ["${trimsuffix(local.app_retained_static_frontend_artifact_objects_arn, "*")}*/*/manifest.json"]
  }

  statement {
    sid       = "ReadOnlySmokeIdentity"
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
    resources = [local.app_terraform_smoke_role_arn]
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
      values   = local.app_dynamodb_table_names
    }
  }

  statement {
    sid       = "ReadRuntimeVerifierWorkflowBinding"
    effect    = "Allow"
    actions   = ["states:DescribeStateMachine"]
    resources = [local.app_target_state_machine_arn]
  }

  statement {
    sid    = "ReadTargetRuntimeLambdaConfig"
    effect = "Allow"
    actions = [
      "lambda:GetAlias",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = concat(
      local.app_target_lambda_arns,
      ["${local.app_signature_verifier_lambda_arn}:*"],
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
    sid       = "ReadTargetRuntimeEventSourceMappings"
    effect    = "Allow"
    actions   = ["lambda:GetEventSourceMapping"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "app_terraform_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy_attachment.app_codebuild_common_smoke]

  name   = "${local.app_terraform_smoke_role_name}-policy"
  role   = aws_iam_role.app_terraform_smoke[0].id
  policy = data.aws_iam_policy_document.app_terraform_smoke[0].json

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_smoke[0].json))) <= 10240
      error_message = "The app Terraform smoke inline policy must remain within the IAM 10,240-character role-policy quota."
    }
  }
}
