locals {
  terraform_baseline_authority_enabled = (
    local.pipeline_enabled
    && local.foundation_pipeline_enabled
    && local.app_pipeline_enabled
  )
  # Activation B changes only this flag after the prerequisite cleanup,
  # accepted baselines, Terraform cutover, and ECR-retention rollout.
  terraform_drift_coordinator_enabled = true

  terraform_authority_bucket_name = local.deployment_shared_names.terraformAuthorityBucket
  terraform_authority_kms_alias   = local.deployment_shared_names.terraformAuthorityKmsAlias
  terraform_baseline_prefix       = local.deployment_shared_names.terraformBaselinePrefix
  terraform_drift_report_prefix   = local.deployment_shared_names.terraformDriftReportPrefix

  terraform_authority_bucket_arn = "arn:aws:s3:::${local.terraform_authority_bucket_name}"
  terraform_authority_kms_alias_arn = (
    "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.terraform_authority_kms_alias}"
  )
  terraform_baseline_root_configuration = [
    {
      root          = "bootstrap"
      stateIdentity = local.bootstrap_lane_authority.stateIdentity
      backendKey    = local.bootstrap_lane_authority.backendKey
    },
    {
      root          = "foundation"
      stateIdentity = local.foundation_lane_authority.stateIdentity
      backendKey    = local.foundation_lane_authority.backendKey
    },
    {
      root          = "app"
      stateIdentity = local.app_lane_authority.stateIdentity
      backendKey    = local.app_lane_authority.backendKey
    },
  ]
  terraform_baseline_pointer_object_arns = [
    for configuration in local.terraform_baseline_root_configuration :
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${configuration.stateIdentity}/current.json"
    if configuration.root != "app"
  ]
  terraform_baseline_immutable_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/*/executions/*"
  )
  terraform_drift_report_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_drift_report_prefix}/*"
  )
  terraform_drift_app_accepted_pointer_key = local.deployment_shared_names.acceptedDeploymentPointerKey
  terraform_drift_app_accepted_pointer_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.terraform_drift_app_accepted_pointer_key}"
  )
  terraform_drift_app_accepted_manifest_arn_pattern = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/executions/*/attempts/*/authoritative-app-deployment.json"
  )

  terraform_drift_coordinator_project_name = local.deployment_shared_names.terraformDriftCoordinatorProject
  terraform_drift_runner_project_names = {
    bootstrap  = local.deployment_shared_names.terraformDriftBootstrapProject
    foundation = local.deployment_shared_names.terraformDriftFoundationProject
    app        = local.deployment_shared_names.terraformDriftAppProject
  }
  terraform_drift_all_project_names = concat(
    [local.terraform_drift_coordinator_project_name],
    values(local.terraform_drift_runner_project_names),
  )
  terraform_drift_runner_project_arns = [
    for name in values(local.terraform_drift_runner_project_names) :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  terraform_drift_coordinator_project_arn = (
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.terraform_drift_coordinator_project_name}"
  )
  terraform_drift_all_project_arns = concat(
    [local.terraform_drift_coordinator_project_arn],
    local.terraform_drift_runner_project_arns,
  )
  terraform_report_only_project_arns = concat(
    local.terraform_drift_all_project_arns,
    local.rollback_recovery_readiness_project_arns,
  )
  terraform_drift_codebuild_log_group_arns = [
    for name in local.terraform_drift_all_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  terraform_drift_runner_role_names = {
    for root in ["bootstrap", "foundation", "app"] :
    root => "${local.deployment_shared_names.terraformDriftRunnerRole}-${root}"
  }
  terraform_drift_runner_role_arns = [
    for name in values(local.terraform_drift_runner_role_names) :
    "arn:aws:iam::${var.aws_account_id}:role/${name}"
  ]
  terraform_drift_coordinator_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.terraformDriftCoordinatorRole}"
  )
  terraform_drift_schedule_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.terraformDriftScheduleRole}"
  )
  terraform_drift_execution_role_arns = concat(
    local.terraform_drift_runner_role_arns,
    [local.terraform_drift_coordinator_role_arn, local.terraform_drift_schedule_role_arn],
  )
  terraform_report_only_execution_role_arns = concat(
    local.terraform_drift_execution_role_arns,
    local.rollback_recovery_readiness_role_arns,
  )
  terraform_drift_runner_boundary_policy_names = {
    for root in ["bootstrap", "foundation", "app"] :
    root => "${local.deployment_shared_names.terraformDriftRunnerRole}-${root}-boundary"
  }
  terraform_drift_runner_boundary_policy_arns = {
    for root, name in local.terraform_drift_runner_boundary_policy_names :
    root => "arn:aws:iam::${var.aws_account_id}:policy/${name}"
  }
  terraform_drift_runner_app_provider_policy_names = {
    core    = local.deployment_shared_names.terraformDriftAppProviderCorePolicy
    runtime = local.deployment_shared_names.terraformDriftAppProviderRuntimePolicy
  }
  terraform_drift_runner_app_provider_policy_arns = {
    for responsibility, name in local.terraform_drift_runner_app_provider_policy_names :
    responsibility => "arn:aws:iam::${var.aws_account_id}:policy/${name}"
  }
  terraform_drift_coordinator_guardrail_policy_names = {
    requestShape         = local.deployment_shared_names.terraformDriftCoordinatorRequestShapePolicy
    executionEnvironment = local.deployment_shared_names.terraformDriftCoordinatorExecutionEnvironmentPolicy
    authorityEnvironment = local.deployment_shared_names.terraformDriftCoordinatorAuthorityEnvironmentPolicy
  }
  terraform_drift_coordinator_guardrail_policy_arns = {
    for responsibility, name in local.terraform_drift_coordinator_guardrail_policy_names :
    responsibility => "arn:aws:iam::${var.aws_account_id}:policy/${name}"
  }
  terraform_drift_coordinator_guardrail_override_groups = {
    requestShape = toset([
      "Artifacts",
      "AutoRetry",
      "Cache",
      "Logs",
      "SecondaryArtifacts",
      "SecondarySources",
    ])
    executionEnvironment = toset([
      "Certificate",
      "ComputeType",
      "EnvironmentType",
      "Fleet",
      "Image",
      "ImageCredentials",
      "PrivilegedMode",
      "RegistryCredentials",
    ])
    authorityEnvironment = toset([
      "Buildspec",
      "EncryptionKey",
      "ServiceRole",
      "Source",
    ])
  }
  terraform_drift_runner_app_managed_policy_role_attachments = {
    appProviderCore = {
      sid       = "AttachAppDriftProviderCorePolicy"
      roleArn   = "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_drift_runner_role_names.app}"
      policyArn = local.terraform_drift_runner_app_provider_policy_arns.core
    }
    appProviderRuntime = {
      sid       = "AttachAppDriftProviderRuntimePolicy"
      roleArn   = "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_drift_runner_role_names.app}"
      policyArn = local.terraform_drift_runner_app_provider_policy_arns.runtime
    }
  }
  terraform_drift_coordinator_managed_policy_role_attachments = {
    coordinatorRequestShape = {
      sid       = "AttachDriftCoordinatorRequestShapePolicy"
      roleArn   = local.terraform_drift_coordinator_role_arn
      policyArn = local.terraform_drift_coordinator_guardrail_policy_arns.requestShape
    }
    coordinatorExecutionEnvironment = {
      sid       = "AttachDriftCoordinatorExecutionEnvironmentPolicy"
      roleArn   = local.terraform_drift_coordinator_role_arn
      policyArn = local.terraform_drift_coordinator_guardrail_policy_arns.executionEnvironment
    }
    coordinatorAuthorityEnvironment = {
      sid       = "AttachDriftCoordinatorAuthorityEnvironmentPolicy"
      roleArn   = local.terraform_drift_coordinator_role_arn
      policyArn = local.terraform_drift_coordinator_guardrail_policy_arns.authorityEnvironment
    }
  }
  terraform_drift_managed_policy_role_attachment_groups = {
    app = {
      sid        = "AttachAppDriftProviderPolicies"
      roleArn    = "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_drift_runner_role_names.app}"
      policyArns = values(local.terraform_drift_runner_app_provider_policy_arns)
    }
    coordinator = {
      sid        = "AttachDriftCoordinatorPolicies"
      roleArn    = local.terraform_drift_coordinator_role_arn
      policyArns = values(local.terraform_drift_coordinator_guardrail_policy_arns)
    }
  }
  # These exact attachment pairs were rendered and authorized before S3. The
  # activation plan must leave both management policies, both attachments, and
  # their propagation barriers unchanged while creating the report-only plane.
  terraform_drift_managed_policy_role_attachments = merge(
    local.terraform_drift_runner_app_managed_policy_role_attachments,
    local.terraform_drift_coordinator_managed_policy_role_attachments,
  )
  terraform_drift_managed_policy_arns = [
    for attachment in values(local.terraform_drift_managed_policy_role_attachments) : attachment.policyArn
  ]
  terraform_drift_schedule_name = local.deployment_shared_names.terraformDriftSchedule
  terraform_drift_schedule_arn = (
    "arn:aws:scheduler:${var.aws_region}:${var.aws_account_id}:schedule/default/${local.terraform_drift_schedule_name}"
  )
  terraform_drift_missed_queue_name = "${local.terraform_drift_schedule_name}-missed"
  terraform_drift_missed_queue_arn = (
    "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.terraform_drift_missed_queue_name}"
  )
  terraform_drift_forbidden_start_build_overrides = {
    Artifacts           = "codebuild:artifacts"
    AutoRetry           = "codebuild:autoRetryLimit"
    Buildspec           = "codebuild:source.buildspec"
    Cache               = "codebuild:cache"
    Certificate         = "codebuild:environment.certificate"
    ComputeType         = "codebuild:environment.computeType"
    EncryptionKey       = "codebuild:encryptionKey"
    EnvironmentType     = "codebuild:environment.type"
    Fleet               = "codebuild:environment.fleet.fleetArn"
    Image               = "codebuild:environment.image"
    ImageCredentials    = "codebuild:environment.imagePullCredentialsType"
    Logs                = "codebuild:logsConfig"
    PrivilegedMode      = "codebuild:environment.privilegedMode"
    RegistryCredentials = "codebuild:environment.registryCredential"
    SecondaryArtifacts  = "codebuild:secondaryArtifacts"
    SecondarySources    = "codebuild:secondarySources"
    ServiceRole         = "codebuild:serviceRole"
    Source              = "codebuild:source"
  }

  terraform_baseline_publishers = local.terraform_baseline_authority_enabled ? {
    bootstrap = {
      role          = local.terraform_smoke_role_name
      role_arn      = "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_smoke_role_name}"
      stateIdentity = local.bootstrap_lane_authority.stateIdentity
    }
    foundation = {
      role          = local.foundation_terraform_smoke_role_name
      role_arn      = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_smoke_role_name}"
      stateIdentity = local.foundation_lane_authority.stateIdentity
    }
    app = {
      role          = local.app_terraform_smoke_role_name
      role_arn      = "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_smoke_role_name}"
      stateIdentity = local.app_lane_authority.stateIdentity
    }
  } : {}
  terraform_baseline_publisher_role_arns = [
    for publisher in values(local.terraform_baseline_publishers) : publisher.role_arn
  ]
  terraform_apply_role_arns = local.terraform_baseline_authority_enabled ? [
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_apply_role_name}",
  ] : []

  terraform_baseline_authority_management_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-apply-terraform-authority-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  )
  terraform_baseline_authority_management_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.terraform_baseline_authority_management_policy_name}"
  )
  # Preserve the already-attached App-artifact managed-policy identity while
  # its former permissions move into the App pipeline-management policy. This
  # updates the existing attachment slot in place instead of risking a
  # transient eleventh attachment on the Bootstrap Apply role.
  terraform_baseline_authority_runtime_management_policy_name = local.app_lane_artifacts_management_policy_name
  terraform_baseline_authority_runtime_management_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.terraform_baseline_authority_runtime_management_policy_name}"
  )
  terraform_baseline_authority_storage_management_statement_sids = [
    "CreateTerraformAuthorityKey",
    "ManageTerraformAuthorityKey",
    "ManageExactTerraformAuthorityAlias",
    "ManageTaggedTerraformAuthorityAliasTarget",
    "ManageAcceptedBaselinePublisherPolicies",
    "ManageExactTerraformDriftProjects",
    "ManageExactTerraformDriftLogGroups",
    "DescribeTerraformDriftLogGroups",
    "CreateTerraformDriftControlRoles",
    "AttachExactReadinessPolicies",
    "PassExactTerraformDriftScheduleRole",
    "ManageExactTerraformDriftMissedQueue",
  ]
  terraform_baseline_authority_runtime_management_statement_sids = [
    for sid in concat(
      [
        for runner_kind in keys(merge(
          local.terraform_drift_runner_role_names,
          local.rollback_recovery_readiness_role_names,
        )) :
        "CreateBoundedTerraformDrift${title(runner_kind)}RunnerRole"
      ],
      [
        "ManageExactTerraformDriftRoles",
        "ManageTerraformDriftRunnerBoundary",
        "AttachExactBootstrapDriftProviderPolicies",
        "PassExactTerraformDriftCodeBuildRoles",
        "ManageExactTerraformDriftSchedule",
      ],
    ) : sid
  ]
}

data "aws_iam_policy_document" "terraform_baseline_authority_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  statement {
    sid       = "CreateTerraformAuthorityKey"
    effect    = "Allow"
    actions   = ["kms:CreateKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AuthorityType"
      values   = ["terraform-baseline"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values   = [var.state_scope]
    }
  }

  statement {
    sid    = "ManageTerraformAuthorityKey"
    effect = "Allow"
    actions = [
      "kms:DescribeKey",
      "kms:EnableKeyRotation",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:TagResource",
      "kms:UntagResource",
    ]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AuthorityType"
      values   = ["terraform-baseline"]
    }

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
      values   = [var.state_scope]
    }
  }

  statement {
    sid    = "ManageExactTerraformAuthorityAlias"
    effect = "Allow"
    actions = [
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:UpdateAlias",
    ]
    resources = [local.terraform_authority_kms_alias_arn]
  }

  statement {
    sid    = "ManageTaggedTerraformAuthorityAliasTarget"
    effect = "Allow"
    actions = [
      "kms:CreateAlias",
      "kms:UpdateAlias",
    ]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AuthorityType"
      values   = ["terraform-baseline"]
    }

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
      values   = [var.state_scope]
    }
  }

  statement {
    sid    = "ManageAcceptedBaselinePublisherPolicies"
    effect = "Allow"
    actions = [
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:PutRolePolicy",
    ]
    resources = local.terraform_baseline_publisher_role_arns
  }

  statement {
    sid    = "ManageExactTerraformDriftProjects"
    effect = "Allow"
    actions = [
      "codebuild:BatchGetProjects",
      "codebuild:CreateProject",
      "codebuild:DeleteProject",
      "codebuild:ListTagsForResource",
      "codebuild:TagResource",
      "codebuild:UntagResource",
      "codebuild:UpdateProject",
    ]
    resources = local.terraform_report_only_project_arns
  }

  statement {
    sid    = "ManageExactTerraformDriftLogGroups"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DeleteRetentionPolicy",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = concat(
      local.terraform_drift_codebuild_log_group_arns,
      [for arn in local.terraform_drift_codebuild_log_group_arns : "${arn}:*"],
      local.rollback_recovery_readiness_log_group_arns,
      [for arn in local.rollback_recovery_readiness_log_group_arns : "${arn}:*"],
    )
  }

  statement {
    sid       = "DescribeTerraformDriftLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = merge(local.terraform_drift_runner_role_names, local.rollback_recovery_readiness_role_names)

    content {
      sid    = "CreateBoundedTerraformDrift${title(statement.key)}RunnerRole"
      effect = "Allow"
      actions = [
        "iam:CreateRole",
        "iam:PutRolePermissionsBoundary",
      ]
      resources = ["arn:aws:iam::${var.aws_account_id}:role/${statement.value}"]

      condition {
        test     = "StringEquals"
        variable = "iam:PermissionsBoundary"
        values = [merge(
          local.terraform_drift_runner_boundary_policy_arns,
          local.rollback_recovery_readiness_boundary_policy_arns,
        )[statement.key]]
      }
    }
  }

  statement {
    sid       = "CreateTerraformDriftControlRoles"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.terraform_drift_coordinator_role_arn, local.terraform_drift_schedule_role_arn]
  }

  statement {
    sid    = "ManageExactTerraformDriftRoles"
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = local.terraform_report_only_execution_role_arns
  }

  statement {
    sid    = "ManageTerraformDriftRunnerBoundary"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = concat(
      values(local.terraform_drift_runner_boundary_policy_arns),
      values(local.terraform_drift_bootstrap_provider_policy_arns),
      local.rollback_recovery_readiness_managed_policy_arns,
    )
  }

  statement {
    sid    = "AttachExactBootstrapDriftProviderPolicies"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_drift_runner_role_names.bootstrap}",
    ]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = values(local.terraform_drift_bootstrap_provider_policy_arns)
    }
  }

  statement {
    sid    = "AttachExactReadinessPolicies"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = local.rollback_recovery_readiness_role_arns

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = local.rollback_recovery_readiness_identity_policy_arns
    }
  }

  statement {
    sid     = "PassExactTerraformDriftCodeBuildRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = concat(
      local.terraform_drift_runner_role_arns,
      [local.terraform_drift_coordinator_role_arn],
      local.rollback_recovery_readiness_role_arns,
    )

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["codebuild.amazonaws.com"]
    }
  }

  statement {
    sid       = "PassExactTerraformDriftScheduleRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.terraform_drift_schedule_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }

  statement {
    sid    = "ManageExactTerraformDriftSchedule"
    effect = "Allow"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
      "scheduler:ListTagsForResource",
      "scheduler:TagResource",
      "scheduler:UntagResource",
      "scheduler:UpdateSchedule",
    ]
    resources = [local.terraform_drift_schedule_arn]
  }

  statement {
    sid    = "ManageExactTerraformDriftMissedQueue"
    effect = "Allow"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListQueueTags",
      "sqs:SetQueueAttributes",
      "sqs:TagQueue",
      "sqs:UntagQueue",
    ]
    resources = [local.terraform_drift_missed_queue_arn]
  }
}

data "aws_iam_policy_document" "terraform_baseline_authority_storage_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  source_policy_documents = [jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(data.aws_iam_policy_document.terraform_baseline_authority_management[0].json).Statement : {
        for key, value in statement : key => value if key != "Sid"
      } if contains(local.terraform_baseline_authority_storage_management_statement_sids, statement.Sid)
    ]
  })]
}

data "aws_iam_policy_document" "terraform_baseline_authority_runtime_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  source_policy_documents = [jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(data.aws_iam_policy_document.terraform_baseline_authority_management[0].json).Statement : {
        for key, value in statement : key => value if key != "Sid"
      } if contains(local.terraform_baseline_authority_runtime_management_statement_sids, statement.Sid)
    ]
  })]
}

locals {
  terraform_baseline_authority_management_policy_documents = local.terraform_baseline_authority_enabled ? {
    storage = data.aws_iam_policy_document.terraform_baseline_authority_storage_management[0].json
    runtime = data.aws_iam_policy_document.terraform_baseline_authority_runtime_management[0].json
  } : {}
  terraform_baseline_authority_management_policy_statement_shapes = {
    for responsibility, document_json in local.terraform_baseline_authority_management_policy_documents :
    responsibility => try(
      length(jsondecode(document_json).Statement) > 0
      && alltrue([
        for statement in jsondecode(document_json).Statement :
        (
          try(length(statement.Action) > 0, false)
          || try(length(statement.NotAction) > 0, false)
          ) && (
          try(length(statement.Resource) > 0, false)
          || try(length(statement.NotResource) > 0, false)
          ) && (
          !contains(keys(statement), "Condition")
          || (
            length(keys(statement.Condition)) > 0
            && alltrue([
              for condition in values(statement.Condition) :
              length(keys(condition)) > 0 && alltrue([
                for condition_values in values(condition) :
                length(condition_values) > 0
              ])
            ])
          )
        )
      ]),
      false,
    )
  }
}

check "terraform_baseline_authority_management_partition" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(
        length(concat(
          local.terraform_baseline_authority_storage_management_statement_sids,
          local.terraform_baseline_authority_runtime_management_statement_sids,
          )) == length(distinct(concat(
            local.terraform_baseline_authority_storage_management_statement_sids,
            local.terraform_baseline_authority_runtime_management_statement_sids,
        )))
        && toset(concat(
          local.terraform_baseline_authority_storage_management_statement_sids,
          local.terraform_baseline_authority_runtime_management_statement_sids,
          )) == toset([
          for statement in jsondecode(data.aws_iam_policy_document.terraform_baseline_authority_management[0].json).Statement :
          statement.Sid
        ]),
        false,
      )
    )
    error_message = "The Terraform authority storage and runtime management policy partitions must be disjoint and cover every exact management statement."
  }
}

resource "aws_iam_policy" "terraform_baseline_authority_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.terraform_apply_app_lane_policy_admin,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  name   = local.terraform_baseline_authority_management_policy_name
  policy = data.aws_iam_policy_document.terraform_baseline_authority_storage_management[0].json
  tags   = local.common_tags

  lifecycle {
    precondition {
      condition = try(
        local.terraform_baseline_authority_management_policy_statement_shapes.storage,
        false,
      )
      error_message = "The Terraform authority storage management policy contains an empty statement field."
    }

    precondition {
      condition = (
        length(local.rollback_recovery_readiness_role_arns) == 2
        && length(local.rollback_recovery_readiness_identity_policy_arns) == 4
      )
      error_message = "The pre-authorized readiness attachment scope must contain exactly two roles and four identity policies."
    }
  }
}

resource "aws_iam_policy" "terraform_baseline_authority_runtime_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.terraform_apply_app_lane_policy_admin,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  name   = local.terraform_baseline_authority_runtime_management_policy_name
  policy = data.aws_iam_policy_document.terraform_baseline_authority_runtime_management[0].json
  tags   = local.common_tags

  lifecycle {
    precondition {
      condition = try(
        local.terraform_baseline_authority_management_policy_statement_shapes.runtime,
        false,
      )
      error_message = "The Terraform authority runtime management policy contains an empty statement field."
    }

    precondition {
      condition     = length(local.terraform_drift_bootstrap_provider_policy_arns) == 5
      error_message = "The pre-authorized Bootstrap drift-provider attachment scope must contain exactly five policies."
    }
  }
}

check "terraform_baseline_authority_management_policy_sizes" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_authority_storage_management[0].json))) <= 6144
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_authority_runtime_management[0].json))) <= 6144,
        false,
      )
    )
    error_message = "The Terraform authority storage and runtime management policies must each remain within IAM's 6,144-character quota."
  }
}

resource "aws_iam_role_policy_attachment" "terraform_baseline_authority_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.terraform_baseline_authority_management[0].arn
}

resource "aws_iam_role_policy_attachment" "terraform_baseline_authority_runtime_management" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.terraform_baseline_authority_runtime_management[0].arn
}

data "aws_iam_policy_document" "terraform_authority_key" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  statement {
    sid    = "EnableAccountRootAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowBaselinePublisherKeyDescription"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.terraform_baseline_publisher_role_arns
    }

    actions   = ["kms:DescribeKey"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowBaselinePublisherKeyUseThroughAuthorityBucket"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.terraform_baseline_publisher_role_arns
    }

    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

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
}

resource "aws_kms_key" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy_attachment.terraform_baseline_authority_management,
    aws_iam_role.terraform_smoke,
    aws_iam_role.foundation_terraform_smoke,
    aws_iam_role.app_terraform_smoke,
    terraform_data.terraform_baseline_authority_storage_authorization_propagation,
  ]

  description             = "Durable accepted Terraform baselines and report-only drift evidence"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.terraform_authority_key[0].json
  tags = merge(local.common_tags, {
    AuthorityType = "terraform-baseline"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  name          = local.terraform_authority_kms_alias
  target_key_id = aws_kms_key.terraform_authority[0].key_id
}

resource "aws_s3_bucket" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  bucket = local.terraform_authority_bucket_name
  tags = merge(local.common_tags, {
    AuthorityType = "terraform-baseline"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.terraform_authority[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket = aws_s3_bucket.terraform_authority[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  bucket = aws_s3_bucket.terraform_authority[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_authority[0].arn
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [aws_s3_bucket_versioning.terraform_authority]
  bucket     = aws_s3_bucket.terraform_authority[0].id

  rule {
    id     = "expire-terraform-drift-reports"
    status = "Enabled"

    filter {
      prefix = "${local.terraform_drift_report_prefix}/"
    }

    expiration {
      days = local.storage_retention.terraform_drift_report_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.terraform_drift_report_days
    }
  }

  rule {
    id     = "abort-incomplete-terraform-authority-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

data "aws_iam_policy_document" "terraform_authority_bucket" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      local.terraform_authority_bucket_arn,
      "${local.terraform_authority_bucket_arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyDeleteAcceptedTerraformBaselines"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = concat(
      [local.terraform_baseline_immutable_object_arn_pattern],
      local.terraform_baseline_pointer_object_arns,
    )
  }

  statement {
    sid    = "DenyUnconditionalAcceptedTerraformBaselineWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.terraform_baseline_immutable_object_arn_pattern]

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "DenyUnconditionalCurrentTerraformBaselineWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.terraform_baseline_pointer_object_arns

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["true"]
    }
  }

  statement {
    sid    = "DenyAmbiguousCurrentTerraformBaselineWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = local.terraform_baseline_pointer_object_arns

    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }

    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["false"]
    }
  }

  statement {
    sid    = "DenyUnconditionalTerraformDriftReportWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = [local.terraform_drift_report_object_arn_pattern]

    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }

  statement {
    sid    = "AllowAcceptedTerraformBaselinePublishers"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = local.terraform_baseline_publisher_role_arns
    }

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = concat(
      [local.terraform_baseline_immutable_object_arn_pattern],
      local.terraform_baseline_pointer_object_arns,
    )
  }

  statement {
    sid    = "DenyTerraformApplyRoleObjectAccess"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = local.terraform_apply_role_arns
    }

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = concat(
      [
        local.terraform_baseline_immutable_object_arn_pattern,
        local.terraform_drift_report_object_arn_pattern,
      ],
      local.terraform_baseline_pointer_object_arns,
    )
  }
}

resource "aws_s3_bucket_policy" "terraform_authority" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_role.terraform_smoke,
    aws_iam_role.foundation_terraform_smoke,
    aws_iam_role.app_terraform_smoke,
    aws_iam_role.terraform_apply,
    aws_iam_role.foundation_terraform_apply,
    aws_iam_role.app_terraform_apply,
  ]

  bucket = aws_s3_bucket.terraform_authority[0].id
  policy = data.aws_iam_policy_document.terraform_authority_bucket[0].json
}

data "aws_iam_policy_document" "terraform_baseline_publisher" {
  for_each = local.terraform_baseline_publishers

  statement {
    sid    = "PublishRootAcceptedBaseline"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    # App's accepted execution and attempt select its immutable baseline;
    # only Bootstrap and Foundation own generic current pointers.
    # The bucket policy still enforces conditional immutable writes for all roots.
    resources = concat(
      [
        "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${each.value.stateIdentity}/executions/*",
      ],
      each.key == "app" ? [] : [
        "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${each.value.stateIdentity}/current.json",
      ],
    )
  }

  statement {
    sid       = "DescribeTerraformAuthorityKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [aws_kms_key.terraform_authority[0].arn]
  }

  statement {
    sid       = "UseTerraformAuthorityKeyThroughS3"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
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
}

resource "aws_iam_role_policy" "terraform_baseline_publisher" {
  for_each = local.terraform_baseline_publishers

  depends_on = [
    aws_s3_bucket_policy.terraform_authority,
    aws_iam_role.terraform_smoke,
    aws_iam_role.foundation_terraform_smoke,
    aws_iam_role.app_terraform_smoke,
  ]

  name   = "${each.value.role}-accepted-baseline"
  role   = each.value.role
  policy = data.aws_iam_policy_document.terraform_baseline_publisher[each.key].json
}

check "terraform_baseline_publisher_role_inline_policy_quotas" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_smoke[0].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_publisher["bootstrap"].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_terraform_smoke[0].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_publisher["foundation"].json))) <= 10240
        && length(jsonencode(jsondecode(data.aws_iam_policy_document.app_terraform_smoke[0].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_baseline_publisher["app"].json))) <= 10240,
        false,
      )
    )
    error_message = "Each Terraform smoke publisher role must remain within IAM's aggregate 10,240-character inline-policy quota."
  }
}
