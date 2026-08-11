locals {
  rollback_recovery_readiness_enabled = local.terraform_baseline_authority_enabled && local.terraform_drift_coordinator_enabled

  rollback_recovery_readiness_definitions = {
    rollback = {
      projectName  = local.deployment_shared_names.rollbackReadinessProject
      roleName     = local.deployment_shared_names.rollbackReadinessRole
      reportPrefix = local.deployment_shared_names.rollbackReadinessReportPrefix
      buildspec    = "buildspec-rollback-readiness.yml.tftpl"
      entrypoint   = "run-rollback-readiness-plan.sh"
      prepare      = "prepare-rollback-readiness-plan.mjs"
      collector    = "scripts/aws/lib/rollback-readiness-collection.ts"
      publisher    = "publish-rollback-readiness.mjs"
    }
    recovery = {
      projectName  = local.deployment_shared_names.recoveryReadinessProject
      roleName     = local.deployment_shared_names.recoveryReadinessRole
      reportPrefix = local.deployment_shared_names.recoveryReadinessReportPrefix
      buildspec    = "buildspec-recovery-readiness.yml.tftpl"
      entrypoint   = "run-recovery-readiness-plan.sh"
      prepare      = "prepare-recovery-readiness-plan.mjs"
      collector    = "scripts/aws/lib/dynamodb-recovery-readiness-collection.ts"
      publisher    = "publish-recovery-readiness.mjs"
    }
  }
  rollback_recovery_readiness_configuration = local.rollback_recovery_readiness_enabled ? local.rollback_recovery_readiness_definitions : {}

  rollback_recovery_readiness_project_names = {
    for kind, definition in local.rollback_recovery_readiness_definitions : kind => definition.projectName
  }
  rollback_recovery_readiness_project_arns = [
    for name in values(local.rollback_recovery_readiness_project_names) :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  rollback_recovery_readiness_role_names = {
    for kind, definition in local.rollback_recovery_readiness_definitions : kind => definition.roleName
  }
  rollback_recovery_readiness_role_arns = [
    for name in values(local.rollback_recovery_readiness_role_names) :
    "arn:aws:iam::${var.aws_account_id}:role/${name}"
  ]
  rollback_recovery_readiness_boundary_policy_names = {
    for kind in keys(local.rollback_recovery_readiness_role_names) :
    kind => "${local.deployment_target.projectId}-readiness-${kind}-boundary-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  }
  rollback_recovery_readiness_boundary_policy_arns = {
    for kind, name in local.rollback_recovery_readiness_boundary_policy_names :
    kind => "arn:aws:iam::${var.aws_account_id}:policy/${name}"
  }
  rollback_recovery_readiness_identity_policy_names = {
    for kind in keys(local.rollback_recovery_readiness_role_names) : kind => {
      core      = "${local.deployment_target.projectId}-readiness-${kind}-core-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
      sensitive = "${local.deployment_target.projectId}-readiness-${kind}-sensitive-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
    }
  }
  rollback_recovery_readiness_identity_policy_arns = flatten([
    for names in values(local.rollback_recovery_readiness_identity_policy_names) : [
      for name in values(names) : "arn:aws:iam::${var.aws_account_id}:policy/${name}"
    ]
  ])
  rollback_recovery_readiness_managed_policy_arns = concat(
    values(local.rollback_recovery_readiness_boundary_policy_arns),
    local.rollback_recovery_readiness_identity_policy_arns,
  )
  rollback_recovery_readiness_log_group_arns = [
    for name in values(local.rollback_recovery_readiness_project_names) :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  rollback_recovery_readiness_read_object_arns = [
    "${aws_s3_bucket.state.arn}/${local.app_lane_authority.backendKey}",
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.app_lane_authority.stateIdentity}/executions/*",
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/*",
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.approvalEvidencePrefix}/*",
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.lambdaArtifactPrefix}/*",
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.signaturePreflightPrefix}/*",
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.staticFrontendArtifactPrefix}/*",
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.recoveryManifestPrefix}/*",
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.deploymentRecordPrefix}/*",
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.foundationAppNetworkingKey}",
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/*",
    "${local.app_release_manifest_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/*",
  ]
  rollback_recovery_readiness_kms_decrypt_arns = [
    aws_kms_key.state.arn,
    aws_kms_key.terraform_authority[0].arn,
    aws_kms_key.app_pipeline_artifacts[0].arn,
    local.app_data_kms_key_arn_pattern,
  ]
  rollback_recovery_readiness_report_object_arns = {
    for kind, configuration in local.rollback_recovery_readiness_configuration :
    kind => "arn:aws:s3:::${local.terraform_authority_bucket_name}/${configuration.reportPrefix}/*"
  }
  rollback_recovery_readiness_log_stream_arns = {
    for kind, configuration in local.rollback_recovery_readiness_configuration :
    kind => "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${configuration.projectName}:*"
  }
  rollback_recovery_readiness_boundary_allowed_actions = [
    "apigateway:GET",
    "cloudfront:Describe*",
    "cloudfront:Get*",
    "cloudfront:List*",
    "cloudwatch:Describe*",
    "cloudwatch:Get*",
    "cloudwatch:List*",
    "codeconnections:Get*",
    "codeconnections:UseConnection",
    "codestar-connections:GetConnection*",
    "dynamodb:Describe*",
    "dynamodb:GetItem",
    "dynamodb:List*",
    "ecr:BatchGetImage",
    "ecr:Describe*",
    "ecs:Describe*",
    "ecs:List*",
    "events:Describe*",
    "events:List*",
    "iam:GetPolicy*",
    "iam:GetRole*",
    "iam:ListAttachedRolePolicies",
    "iam:ListRolePolicies",
    "iam:ListRoleTags",
    "kms:Decrypt",
    "kms:DescribeKey",
    "kms:Encrypt",
    "kms:GenerateDataKey",
    "kms:GetKey*",
    "kms:GetPublicKey",
    "kms:ListAliases",
    "kms:ListResourceTags",
    "lambda:Get*",
    "lambda:List*",
    "logs:CreateLogStream",
    "logs:Describe*",
    "logs:List*",
    "logs:PutLogEvents",
    "s3:GetAccelerateConfiguration",
    "s3:GetBucket*",
    "s3:GetEncryptionConfiguration",
    "s3:GetLifecycleConfiguration",
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:GetReplicationConfiguration",
    "s3:ListBucket",
    "s3:ListTagsForResource",
    "s3:PutObject",
    "secretsmanager:DescribeSecret",
    "secretsmanager:GetResourcePolicy",
    "secretsmanager:GetSecretValue",
    "sns:Get*",
    "sns:List*",
    "sqs:Get*",
    "sqs:List*",
    "ssm:DescribeParameters",
    "ssm:GetParameter",
    "ssm:GetParameters",
    "ssm:GetParametersByPath",
    "ssm:ListTagsForResource",
    "states:Describe*",
    "states:List*",
    "states:ValidateStateMachineDefinition",
    "sts:GetCallerIdentity",
  ]
}

data "aws_iam_policy_document" "rollback_recovery_readiness_assume_role" {
  for_each = local.rollback_recovery_readiness_configuration

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${each.value.projectName}"]
    }
  }
}

data "aws_iam_policy_document" "rollback_recovery_readiness" {
  for_each = local.rollback_recovery_readiness_configuration

  # IAM counts Sid bytes toward the 6,144-character managed-policy quota.
  # Keep these labels concise; the statements' actions, resources, and
  # conditions carry the reviewed authorization semantics.

  statement {
    sid       = "ReadReadinessCallerIdentity"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid    = "ReadExactReadinessObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = local.rollback_recovery_readiness_read_object_arns
  }

  statement {
    sid       = "ListExactAppStatePrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [dirname(local.app_lane_authority.backendKey), "${dirname(local.app_lane_authority.backendKey)}/*"]
    }
  }

  statement {
    sid    = "ReadinessKeys"
    effect = "Allow"
    actions = [
      "kms:DescribeKey",
    ]
    resources = [
      aws_kms_key.state.arn,
      aws_kms_key.terraform_authority[0].arn,
      aws_kms_key.app_pipeline_artifacts[0].arn,
    ]
  }

  dynamic "statement" {
    for_each = {
      state = {
        sidSuffix = "State"
        keyArn    = aws_kms_key.state.arn
        bucketArn = aws_s3_bucket.state.arn
      }
      authority = {
        sidSuffix = "Authority"
        keyArn    = aws_kms_key.terraform_authority[0].arn
        bucketArn = local.terraform_authority_bucket_arn
      }
      app_artifacts = {
        sidSuffix = "AppArtifacts"
        keyArn    = aws_kms_key.app_pipeline_artifacts[0].arn
        bucketArn = local.app_retained_artifact_bucket_arn
      }
    }

    content {
      sid       = "Decrypt${statement.value.sidSuffix}ReadinessObjectsThroughS3"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = [statement.value.keyArn]

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
        values   = [statement.value.bucketArn]
      }
    }
  }

  statement {
    sid    = "RecoveryTables"
    effect = "Allow"
    actions = [
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:ListTagsOfResource",
    ]
    resources = [
      local.app_dynamodb_table_arn_pattern,
      local.app_dynamodb_index_arn_pattern,
    ]
  }

  dynamic "statement" {
    for_each = each.key == "recovery" ? [1] : []

    content {
      sid    = "RecoveryRole"
      effect = "Allow"
      actions = [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
      ]
      resources = ["arn:aws:iam::${var.aws_account_id}:role/${each.value.roleName}"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "recovery" ? [1] : []

    content {
      sid    = "RecoveryPolicies"
      effect = "Allow"
      actions = [
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
      ]
      resources = [
        local.rollback_recovery_readiness_boundary_policy_arns[each.key],
        "arn:aws:iam::${var.aws_account_id}:policy/${local.rollback_recovery_readiness_identity_policy_names[each.key].core}",
        "arn:aws:iam::${var.aws_account_id}:policy/${local.rollback_recovery_readiness_identity_policy_names[each.key].sensitive}",
      ]
    }
  }

  statement {
    sid    = "ReadExactRetainedProverImage"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:DescribeImageSigningStatus",
    ]
    resources = local.app_release_image_repository_arns
  }

  statement {
    sid     = "PublishCreateOnlyReadinessEvidence"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      local.rollback_recovery_readiness_report_object_arns[each.key],
    ]

    condition {
      test     = "StringEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "UseReadinessEvidenceKeyThroughS3"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.terraform_authority[0].arn]

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
    sid    = "ReadSourceConnection"
    effect = "Allow"
    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
    ]
    resources = [aws_codeconnections_connection.source[0].arn]
  }

  statement {
    sid    = "WriteReadinessLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [local.rollback_recovery_readiness_log_stream_arns[each.key]]
  }
}

data "aws_iam_policy_document" "rollback_recovery_readiness_combined" {
  for_each = local.rollback_recovery_readiness_configuration

  source_policy_documents = [
    data.aws_iam_policy_document.rollback_recovery_readiness[each.key].json,
    data.aws_iam_policy_document.terraform_drift_runner_app_provider[0].json,
    data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json,
  ]
}

locals {
  rollback_recovery_readiness_identity_actions = {
    for kind in keys(local.rollback_recovery_readiness_configuration) : kind => distinct(flatten([
      for statement in jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_combined[kind].json).Statement :
      statement.Action
    ]))
  }
}

data "aws_iam_policy_document" "rollback_recovery_readiness_boundary" {
  for_each = local.rollback_recovery_readiness_configuration

  statement {
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  statement {
    effect      = "Deny"
    not_actions = local.rollback_recovery_readiness_boundary_allowed_actions
    resources   = ["*"]
  }

  # These resource ARN namespaces are service-disjoint. Combining their ceilings
  # preserves each action's existing maximum while avoiding duplicate statement
  # framing in the quota-bounded permissions boundary.
  statement {
    effect = "Deny"
    actions = [
      "dynamodb:GetItem",
      "iam:GetPolicy*",
      "iam:GetRole*",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GetKey*",
      "kms:GetPublicKey",
      "kms:ListResourceTags",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:PutObject",
      "secretsmanager:Describe*",
      "secretsmanager:Get*",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:ListTagsForResource",
    ]
    not_resources = concat(
      [local.rollback_recovery_readiness_report_object_arns[each.key]],
      local.terraform_drift_runner_secret_read_arns["app"],
      local.terraform_drift_runner_parameter_read_arns["app"],
      local.rollback_recovery_readiness_kms_decrypt_arns,
      [local.app_target_prover_semaphore_table_arn],
      local.app_target_runtime_role_resource_arns,
      ["arn:aws:iam::${var.aws_account_id}:role/${each.value.roleName}"],
      [
        local.app_signature_verifier_execution_boundary_policy_arn,
        local.rollback_recovery_readiness_boundary_policy_arns[each.key],
        "arn:aws:iam::${var.aws_account_id}:policy/${local.rollback_recovery_readiness_identity_policy_names[each.key].core}",
        "arn:aws:iam::${var.aws_account_id}:policy/${local.rollback_recovery_readiness_identity_policy_names[each.key].sensitive}",
      ],
      [local.rollback_recovery_readiness_log_stream_arns[each.key]],
    )
  }

  statement {
    effect        = "Deny"
    actions       = ["s3:GetObject", "s3:GetObjectVersion"]
    not_resources = local.rollback_recovery_readiness_read_object_arns
  }

  statement {
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    effect    = "Deny"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "kms:ViaService"
      values   = local.terraform_drift_runner_kms_decrypt_services["app"]
    }
  }

  statement {
    effect        = "Deny"
    actions       = ["kms:Encrypt", "kms:GenerateDataKey"]
    not_resources = [aws_kms_key.terraform_authority[0].arn]
  }

}

resource "aws_iam_policy" "rollback_recovery_readiness_boundary" {
  for_each = local.rollback_recovery_readiness_configuration

  depends_on = [aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management]

  name   = local.rollback_recovery_readiness_boundary_policy_names[each.key]
  policy = data.aws_iam_policy_document.rollback_recovery_readiness_boundary[each.key].json
  tags   = merge(local.common_tags, { EvidenceType = "${each.key}-readiness" })
}

resource "aws_iam_policy" "rollback_recovery_readiness_core" {
  for_each = local.rollback_recovery_readiness_configuration

  depends_on = [aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management]

  name   = local.rollback_recovery_readiness_identity_policy_names[each.key].core
  policy = data.aws_iam_policy_document.rollback_recovery_readiness[each.key].json
  tags   = merge(local.common_tags, { EvidenceType = "${each.key}-readiness" })
}

resource "aws_iam_policy" "rollback_recovery_readiness_sensitive" {
  for_each = local.rollback_recovery_readiness_configuration

  depends_on = [aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management]

  name   = local.rollback_recovery_readiness_identity_policy_names[each.key].sensitive
  policy = data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json
  tags   = merge(local.common_tags, { EvidenceType = "${each.key}-readiness" })
}

resource "aws_iam_role" "rollback_recovery_readiness" {
  for_each = local.rollback_recovery_readiness_configuration

  name                 = each.value.roleName
  assume_role_policy   = data.aws_iam_policy_document.rollback_recovery_readiness_assume_role[each.key].json
  permissions_boundary = aws_iam_policy.rollback_recovery_readiness_boundary[each.key].arn
  tags                 = merge(local.common_tags, { EvidenceType = "${each.key}-readiness" })
}

resource "aws_iam_role_policy" "rollback_recovery_readiness_provider" {
  for_each = local.rollback_recovery_readiness_configuration

  name   = "${each.value.roleName}-provider-read"
  role   = aws_iam_role.rollback_recovery_readiness[each.key].id
  policy = data.aws_iam_policy_document.terraform_drift_runner_app_provider[0].json
}

resource "aws_iam_role_policy_attachment" "rollback_recovery_readiness_core" {
  for_each = local.rollback_recovery_readiness_configuration

  role       = aws_iam_role.rollback_recovery_readiness[each.key].name
  policy_arn = aws_iam_policy.rollback_recovery_readiness_core[each.key].arn
}

resource "aws_iam_role_policy_attachment" "rollback_recovery_readiness_sensitive" {
  for_each = local.rollback_recovery_readiness_configuration

  role       = aws_iam_role.rollback_recovery_readiness[each.key].name
  policy_arn = aws_iam_policy.rollback_recovery_readiness_sensitive[each.key].arn
}

locals {
  rollback_recovery_readiness_reviewed_iam_contract = local.rollback_recovery_readiness_enabled ? {
    roleArn           = "arn:aws:iam::${var.aws_account_id}:role/${local.rollback_recovery_readiness_configuration.recovery.roleName}"
    trustPolicySha256 = sha256(jsonencode(jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_assume_role["recovery"].json)))
    permissionsBoundary = {
      policyArn      = local.rollback_recovery_readiness_boundary_policy_arns["recovery"]
      documentSha256 = sha256(jsonencode(jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_boundary["recovery"].json)))
    }
    attachedPolicies = [
      {
        policyArn      = "arn:aws:iam::${var.aws_account_id}:policy/${local.rollback_recovery_readiness_identity_policy_names.recovery.core}"
        documentSha256 = sha256(jsonencode(jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness["recovery"].json)))
      },
      {
        policyArn      = "arn:aws:iam::${var.aws_account_id}:policy/${local.rollback_recovery_readiness_identity_policy_names.recovery.sensitive}"
        documentSha256 = sha256(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json)))
      },
    ]
    inlinePolicies = [
      {
        policyName     = "${local.rollback_recovery_readiness_configuration.recovery.roleName}-provider-read"
        documentSha256 = sha256(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_provider[0].json)))
      },
    ]
  } : null
  rollback_recovery_readiness_reviewed_iam_contract_base64 = local.rollback_recovery_readiness_enabled ? base64encode("${jsonencode(local.rollback_recovery_readiness_reviewed_iam_contract)}\n") : ""
}

check "rollback_recovery_readiness_policy_quotas" {
  assert {
    condition = (
      !local.rollback_recovery_readiness_enabled
      || try(alltrue([
        for kind in keys(local.rollback_recovery_readiness_configuration) :
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_provider[0].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness[kind].json))) <= 6144
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json))) <= 6144
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_boundary[kind].json))) <= 6144
      ]), false)
    )
    error_message = "Rollback and recovery readiness policies must remain within IAM inline and managed policy quotas."
  }
}

check "rollback_recovery_readiness_statement_ids" {
  assert {
    condition = (
      !local.rollback_recovery_readiness_enabled
      || try(alltrue(flatten([
        for kind in keys(local.rollback_recovery_readiness_configuration) : [
          for statement in jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness[kind].json).Statement :
          !contains(keys(statement), "Sid")
          || length(regexall("^[0-9A-Za-z]+$", try(statement.Sid, ""))) == 1
        ]
      ])), false)
    )
    error_message = "Every readiness IAM statement ID must contain only ASCII alphanumeric characters."
  }
}

check "rollback_recovery_readiness_boundary_action_coverage" {
  assert {
    condition = (
      !local.rollback_recovery_readiness_enabled
      || alltrue(flatten([
        for actions in values(local.rollback_recovery_readiness_identity_actions) : [
          for action in actions : anytrue([
            for allowed_action in local.rollback_recovery_readiness_boundary_allowed_actions :
            endswith(allowed_action, "*")
            ? startswith(lower(action), lower(trimsuffix(allowed_action, "*")))
            : lower(action) == lower(allowed_action)
          ])
        ]
      ]))
    )
    error_message = "Every readiness identity action must remain admitted by the compact permissions-boundary action ceiling."
  }
}

resource "aws_codebuild_project" "rollback_recovery_readiness" {
  for_each = local.rollback_recovery_readiness_configuration

  depends_on = [terraform_data.terraform_report_only_execution_authorization_propagation]

  name                   = each.value.projectName
  service_role           = aws_iam_role.rollback_recovery_readiness[each.key].arn
  build_timeout          = 30
  concurrent_build_limit = 1
  source_version         = var.control_source_sha

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = false

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = var.aws_account_id
    }
    environment_variable {
      name  = "AWS_DEFAULT_REGION"
      value = var.aws_region
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_BUCKET"
      value = local.terraform_authority_bucket_name
    }
    environment_variable {
      name  = "TERRAFORM_AUTHORITY_KMS_KEY_ARN"
      value = aws_kms_key.terraform_authority[0].arn
    }
    environment_variable {
      name  = "TERRAFORM_STATE_BUCKET"
      value = aws_s3_bucket.state.bucket
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_KEY_ARN"
      value = aws_kms_key.state.arn
    }
    environment_variable {
      name  = "TERRAFORM_STATE_KMS_ALIAS"
      value = var.state_kms_alias
    }
    environment_variable {
      name  = "APP_PIPELINE_ARTIFACT_BUCKET"
      value = local.app_retained_artifact_bucket_name
    }
    environment_variable {
      name  = "APP_RELEASE_MANIFEST_BUCKET"
      value = local.app_release_manifest_bucket_name
    }
    environment_variable {
      name  = upper("${each.key}_READINESS_PROJECT_NAME")
      value = each.value.projectName
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.terraform_drift_codebuild_log_groups.log_groups[each.value.projectName].name
      stream_name = each.key
    }
  }

  source {
    type                = "GITHUB"
    location            = local.deployment_target.repositoryUrl
    git_clone_depth     = 0
    report_build_status = false
    buildspec = templatefile("${path.module}/${each.value.buildspec}", {
      entrypoint_path               = "infra/terraform/bootstrap/readiness-scripts/${each.value.entrypoint}"
      entrypoint_sha256             = filesha256("${path.module}/readiness-scripts/${each.value.entrypoint}")
      shared_runner_path            = "infra/terraform/bootstrap/report-only-terraform-scripts/run-report-only-terraform-plan.sh"
      shared_runner_sha256          = filesha256("${path.module}/report-only-terraform-scripts/run-report-only-terraform-plan.sh")
      prepare_path                  = "infra/terraform/bootstrap/readiness-scripts/${each.value.prepare}"
      prepare_sha256                = filesha256("${path.module}/readiness-scripts/${each.value.prepare}")
      collector_path                = each.value.collector
      collector_sha256              = filesha256("${path.module}/../../../${each.value.collector}")
      publisher_path                = "infra/terraform/bootstrap/readiness-scripts/${each.value.publisher}"
      publisher_sha256              = filesha256("${path.module}/readiness-scripts/${each.value.publisher}")
      reviewed_control_source_sha   = var.control_source_sha
      configured_control_source_sha = var.control_source_sha
      reviewed_iam_contract_base64  = each.key == "recovery" ? local.rollback_recovery_readiness_reviewed_iam_contract_base64 : ""
    })

    auth {
      type     = "CODECONNECTIONS"
      resource = aws_codeconnections_connection.source[0].arn
    }
  }

  tags = merge(local.common_tags, {
    EvidenceType = "${each.key}-readiness"
    StateScope   = "app"
  })
}

output "rollback_readiness_on_demand_project_name" {
  description = "On-demand report-only rollback readiness project; defining it does not authorize invocation."
  value       = try(aws_codebuild_project.rollback_recovery_readiness["rollback"].name, null)
}

output "recovery_readiness_on_demand_project_name" {
  description = "On-demand report-only recovery readiness project; defining it does not authorize invocation."
  value       = try(aws_codebuild_project.rollback_recovery_readiness["recovery"].name, null)
}
