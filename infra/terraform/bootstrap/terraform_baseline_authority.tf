locals {
  terraform_authority_kms_alias_arn = (
    "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.terraform_authority_kms_alias}"
  )
  terraform_drift_app_managed_policy_role_attachment_groups = {
    app = {
      sid        = "AttachAppDrift"
      roleArn    = "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_drift_runner_role_names.app}"
      policyArns = values(local.terraform_drift_runner_app_provider_policy_arns)
    }
  }
  terraform_baseline_authority_storage_management_statement_sids = [
    "CreateTerraformAuthorityKey",
    "ManageTerraformAuthorityKey",
    "ManageExactTerraformAuthorityAlias",
    "ManageTaggedTerraformAuthorityAliasTarget",
    "CreateBootstrapTerraformAcceptancePublisherRole",
    "ManageBootstrapTerraformAcceptancePublisherRole",
    "ManageTerraformAuthorityPublisherPolicies",
    "ManageExactTerraformDriftProjects",
    "DescribeTerraformDriftLogGroups",
    "CreateTerraformDriftOnDemandRole",
  ]
  terraform_baseline_authority_runtime_management_statement_sids = [
    for sid in concat(
      [
        for runner_kind in keys(local.terraform_drift_runner_role_names) :
        "CreateBoundedTerraformDrift${title(runner_kind)}RunnerRole"
      ],
      [
        "ManageExactTerraformDriftRoles",
        "ConfigureTerraformDriftOnDemandRoleSession",
        "ManageTerraformDriftRunnerBoundary",
        "AttachExactBootstrapDriftProviderPolicies",
        "AttachExactTerraformDriftOnDemandAuthorityGuardrail",
        "PassExactTerraformDriftCodeBuildRoles",
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
    sid    = "CreateBootstrapTerraformAcceptancePublisherRole"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = [local.bootstrap_terraform_acceptance_publisher_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.bootstrap_deploy_permissions_boundary_policy_arn]
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

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values = [
        "AccountAlias",
        "Environment",
        "ManagedBy",
        "Project",
        "StateScope",
      ]
    }
  }

  statement {
    sid    = "ManageBootstrapTerraformAcceptancePublisherRole"
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = [local.bootstrap_terraform_acceptance_publisher_role_arn]
  }

  statement {
    sid    = "ManageTerraformAuthorityPublisherPolicies"
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
    resources = local.terraform_drift_all_project_arns
  }

  statement {
    sid       = "DescribeTerraformDriftLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = local.terraform_drift_runner_role_names

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
        values   = [local.terraform_drift_runner_boundary_policy_arns[statement.key]]
      }
    }
  }

  statement {
    sid       = "CreateTerraformDriftOnDemandRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.terraform_drift_on_demand_role_arn]
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
    resources = local.terraform_drift_execution_role_arns
  }

  statement {
    sid       = "ConfigureTerraformDriftOnDemandRoleSession"
    effect    = "Allow"
    actions   = ["iam:UpdateRole"]
    resources = [local.terraform_drift_on_demand_role_arn]
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
    sid    = "AttachExactTerraformDriftOnDemandAuthorityGuardrail"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [local.terraform_drift_on_demand_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [local.terraform_drift_coordinator_guardrail_policy_arns.authorityEnvironment]
    }
  }

  statement {
    sid       = "PassExactTerraformDriftCodeBuildRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = local.terraform_drift_runner_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["codebuild.amazonaws.com"]
    }
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

data "aws_iam_policy_document" "bootstrap_terraform_acceptance_publisher_assume_role" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [local.terraform_smoke_role_arn]
    }
  }
}

resource "aws_iam_role" "bootstrap_terraform_acceptance_publisher" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_role.terraform_smoke,
    terraform_data.terraform_baseline_authority_storage_authorization_propagation,
  ]

  name                 = local.bootstrap_terraform_acceptance_publisher_role_name
  assume_role_policy   = data.aws_iam_policy_document.bootstrap_terraform_acceptance_publisher_assume_role[0].json
  permissions_boundary = aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn
  tags                 = local.common_tags
}
