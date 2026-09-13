data "aws_iam_policy_document" "app_signature_preflight_specific" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = local.deployment_target.environmentId == "main" ? [
    data.aws_iam_policy_document.app_initialization_execution_read[0].json,
    data.aws_iam_policy_document.app_initialization_absence_read[0].json,
  ] : []

  statement {
    sid       = "ReadCurrentVerifierPreflightPlanActionExecution"
    effect    = "Allow"
    actions   = ["codepipeline:ListActionExecutions"]
    resources = [local.app_pipeline_arn]
  }

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

data "aws_iam_policy_document" "app_signature_preflight_plan" {
  count = local.app_pipeline_enabled ? 1 : 0
  source_policy_documents = [
    data.aws_iam_policy_document.app_codebuild_common[0].json,
    data.aws_iam_policy_document.app_signature_preflight_specific[0].json,
  ]
}

resource "aws_iam_role_policy" "app_signature_preflight_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_signature_preflight_plan_role_name}-policy"
  role   = aws_iam_role.app_signature_preflight_plan[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_plan[0].json
}

data "aws_iam_policy_document" "app_signature_preflight_plan_pipeline_state" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadAppPipelineStateForVerifierPreflightPlan"
    effect    = "Allow"
    actions   = ["codepipeline:GetPipelineState"]
    resources = [local.app_pipeline_arn]
  }
}

resource "aws_iam_role_policy" "app_signature_preflight_plan_pipeline_state" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_signature_preflight_plan_role_name}-pipeline-state"
  role   = aws_iam_role.app_signature_preflight_plan[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_plan_pipeline_state[0].json
}

check "app_signature_preflight_plan_inline_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.app_signature_preflight_plan[0].json)))
        + length(
          jsonencode(jsondecode(data.aws_iam_policy_document.app_signature_preflight_plan_pipeline_state[0].json))
        ) <= 10240,
        false,
      )
    )
    error_message = "The App verifier-preflight Plan aggregate inline policies must remain within IAM's 10,240-character role-policy quota."
  }
}

data "aws_iam_policy_document" "app_signature_preflight_apply" {
  count = local.app_pipeline_enabled ? 1 : 0
  source_policy_documents = [
    data.aws_iam_policy_document.app_signature_preflight_specific[0].json,
    data.aws_iam_policy_document.saved_plan_approval_apply_read["app_verifier_preflight"].json,
  ]

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

  depends_on = [aws_iam_role_policy_attachment.app_codebuild_common_preflight_apply]

  name   = "${local.app_signature_preflight_apply_role_name}-policy"
  role   = aws_iam_role.app_signature_preflight_apply[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_apply[0].json

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.app_signature_preflight_apply[0].json))) <= 10240
      error_message = "The App verifier preflight Apply inline policy must remain within IAM's 10,240-character role-policy quota."
    }
  }
}

resource "aws_iam_role_policy_attachment" "app_codebuild_common_preflight_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  role       = aws_iam_role.app_signature_preflight_apply[0].name
  policy_arn = aws_iam_policy.app_codebuild_common[0].arn
}

data "aws_iam_policy_document" "app_signature_preflight_invoker" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.app_pipeline_clone_reference_source[0].json]

  statement {
    sid       = "ReadExactVerifierPreflightInvokeProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [local.source_path_app_start_build_projects.app_signature_preflight_invoke.project_arn]
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
      "${local.app_codebuild_log_group_arn_by_project_name[local.app_signature_preflight_invoke_project_name]}:*",
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
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]
  }
}

resource "aws_iam_role_policy" "app_signature_preflight_invoker" {
  count = local.app_pipeline_enabled ? 1 : 0

  depends_on = [module.app_pipeline_codebuild_log_groups]

  name   = "${local.app_signature_preflight_invoker_role_name}-policy"
  role   = aws_iam_role.app_signature_preflight_invoker[0].id
  policy = data.aws_iam_policy_document.app_signature_preflight_invoker[0].json
}
