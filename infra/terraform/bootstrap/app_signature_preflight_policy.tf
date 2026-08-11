data "aws_iam_policy_document" "app_signature_preflight_plan" {
  count                   = local.app_pipeline_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.app_codebuild_common[0].json]

  statement {
    sid    = "UseRetainedVerifierPackageForPreflightPlan"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.app_retained_lambda_artifact_objects_arn]
  }

  statement {
    sid    = "ReadCurrentAcceptedProverForVerifierOnlyPlan"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.app_prover_accepted_pointer_object_arn,
      local.app_prover_release_records_objects_arn,
    ]
  }

  statement {
    sid    = "ReadAppStateForVerifierOnlyPlan"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
  }

  statement {
    sid    = "UseAppStateLockForVerifierOnlyPlan"
    effect = "Allow"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}.tflock"]
  }

  statement {
    sid       = "ListAppStateForVerifierOnlyPlan"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "${dirname(local.app_state_backend_key)}/",
        "${dirname(local.app_state_backend_key)}/*",
      ]
    }
  }

  statement {
    sid    = "UseAppStateKeyForVerifierOnlyPlan"
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
    sid    = "ReadVerifierOnlyLambda"
    effect = "Allow"
    actions = [
      "lambda:GetAlias",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConfiguration",
      "lambda:GetFunctionConcurrency",
      "lambda:GetPolicy",
      "lambda:GetRuntimeManagementConfig",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
    ]
    resources = [
      local.app_signature_verifier_lambda_arn,
      "${local.app_signature_verifier_lambda_arn}:*",
    ]
  }

  statement {
    sid    = "ReadVerifierOnlyRole"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_runtime_name_prefix}-image-signature-verifier-role",
    ]
  }

  statement {
    sid    = "ReadVerifierOnlyExecutionBoundary"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = [local.app_signature_verifier_execution_boundary_policy_arn]
  }

  statement {
    sid     = "ReadVerifierOnlyLogGroup"
    effect  = "Allow"
    actions = ["logs:ListTagsForResource"]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.app_signature_runtime_name_prefix}-image-signature-verifier",
    ]
  }

  statement {
    sid    = "ReadVerifierOnlyCallerAndLogInventory"
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "sts:GetCallerIdentity",
    ]
    resources = [
      "*",
    ]
  }
}

resource "aws_iam_role_policy" "app_signature_preflight_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_signature_preflight_plan_role_name}-policy"
  role   = aws_iam_role.app_signature_preflight_plan[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_plan[0].json
}

data "aws_iam_policy_document" "app_signature_state_refresh_apply" {
  count                   = local.app_pipeline_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.app_signature_preflight_plan[0].json]

  statement {
    sid       = "ReadCurrentVerifierStateRefreshApproval"
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = [local.app_pipeline_arn]
  }

  statement {
    sid       = "WriteAppStateForReviewedVerifierRefresh"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
  }
}

resource "aws_iam_role_policy" "app_signature_state_refresh_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_signature_state_refresh_apply_role_name}-policy"
  role   = aws_iam_role.app_signature_state_refresh_apply[0].id
  policy = data.aws_iam_policy_document.app_signature_state_refresh_apply[0].json
}

data "aws_iam_policy_document" "app_signature_preflight_apply" {
  count                   = local.app_pipeline_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.app_signature_preflight_plan[0].json]

  statement {
    sid       = "ReadCurrentVerifierPreflightApproval"
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = [local.app_pipeline_arn]
  }

  statement {
    sid       = "WriteAppStateForVerifierOnlyApply"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.app_state_backend_key}"]
  }

  statement {
    sid    = "ManageVerifierOnlyLambda"
    effect = "Allow"
    actions = [
      "lambda:CreateAlias",
      "lambda:CreateFunction",
      "lambda:GetAlias",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConfiguration",
      "lambda:GetFunctionConcurrency",
      "lambda:GetPolicy",
      "lambda:GetRuntimeManagementConfig",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
      "lambda:PublishVersion",
      "lambda:TagResource",
      "lambda:UntagResource",
      "lambda:UpdateAlias",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
    ]
    resources = [
      local.app_signature_verifier_lambda_arn,
      "${local.app_signature_verifier_lambda_arn}:*",
    ]
  }

  statement {
    sid    = "ManageVerifierOnlyRole"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_runtime_name_prefix}-image-signature-verifier-role",
    ]
  }

  statement {
    sid    = "CreateVerifierOnlyRoleWithBoundary"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_runtime_name_prefix}-image-signature-verifier-role",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.app_signature_verifier_execution_boundary_policy_arn]
    }
  }

  statement {
    sid       = "PassVerifierOnlyRoleToLambda"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_runtime_name_prefix}-image-signature-verifier-role"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid    = "ManageVerifierOnlyLogGroup"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DescribeLogGroups",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.app_signature_runtime_name_prefix}-image-signature-verifier",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.app_signature_runtime_name_prefix}-image-signature-verifier:*",
    ]
  }
}

resource "aws_iam_role_policy" "app_signature_preflight_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_signature_preflight_apply_role_name}-policy"
  role   = aws_iam_role.app_signature_preflight_apply[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_apply[0].json
}

data "aws_iam_policy_document" "app_signature_preflight_invoker" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSignaturePreflightSourceConnection"
    effect = "Allow"
    actions = [
      "codeconnections:UseConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    sid    = "ReadSignaturePreflightSourceArtifact"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      "${aws_s3_bucket.app_pipeline_execution_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid       = "WriteSignaturePreflightOutputArtifact"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.app_pipeline_execution_artifacts[0].arn}/*"]
  }

  statement {
    sid    = "WriteSignaturePreflightLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${module.app_pipeline_codebuild_log_groups.log_groups[local.app_signature_preflight_invoke_project_name].arn}:*",
    ]
  }

  statement {
    sid       = "InvokeQualifiedPreflightAlias"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.app_signature_preflight_alias_arn]
  }

  statement {
    sid    = "PublishImmutableSignaturePreflightEvidence"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.app_signature_preflight_evidence_object_arn]
  }

  statement {
    sid    = "EncryptSignaturePreflightEvidence"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.app_pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "app_signature_preflight_invoker" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_signature_preflight_invoker_role_name}-policy"
  role   = aws_iam_role.app_signature_preflight_invoker[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_invoker[0].json
}
