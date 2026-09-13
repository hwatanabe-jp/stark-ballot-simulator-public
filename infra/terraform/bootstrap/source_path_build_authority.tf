locals {
  source_path_start_build_guardrail_policy_name = (
    local.deployment_shared_names.terraformDriftCoordinatorRequestShapePolicy
  )
  source_path_start_build_guardrail_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.source_path_start_build_guardrail_policy_name}"
  )
  direct_start_build_additional_structural_condition_keys = [
    "codebuild:artifacts",
    "codebuild:encryptionKey",
    "codebuild:secondarySources",
    "codebuild:source",
    "codebuild:source.location",
  ]
  direct_start_build_shared_structural_condition_keys = [
    "codebuild:autoRetryLimit",
    "codebuild:cache",
    "codebuild:environment.certificate",
    "codebuild:environment.computeType",
    "codebuild:environment.fleet.fleetArn",
    "codebuild:environment.image",
    "codebuild:environment.imagePullCredentialsType",
    "codebuild:environment.privilegedMode",
    "codebuild:environment.registryCredential",
    "codebuild:environment.type",
    "codebuild:logsConfig",
    "codebuild:secondaryArtifacts",
    "codebuild:serviceRole",
    "codebuild:source.auth.resource",
    "codebuild:source.auth.type",
    "codebuild:source.buildStatusConfig.context",
    "codebuild:source.buildStatusConfig.targetUrl",
    "codebuild:source.buildspec",
    "codebuild:source.insecureSsl",
  ]

  source_path_foundation_start_build_projects = {
    plan = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.foundation_terraform_plan_project_name}"
    }
    apply = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.foundation_terraform_apply_project_name}"
    }
    smoke = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.foundation_smoke_project_name}"
    }
    signing_resolver = {
      project_arn = local.foundation_image_signing_authority_resolver_project_arn
    }
  }

  source_path_app_start_build_projects = {
    app_signature_preflight_plan = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_signature_preflight_plan_project_name}"
    }
    app_signature_preflight_apply = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_signature_preflight_apply_project_name}"
    }
    app_signature_preflight_invoke = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_signature_preflight_invoke_project_name}"
    }
    app_execution_authority = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_execution_authority_project_name}"
    }
    app_terraform_plan = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_terraform_plan_project_name}"
    }
    app_terraform_apply = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_terraform_apply_project_name}"
    }
    app_static_deploy = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_static_deploy_project_name}"
    }
    app_smoke = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_smoke_project_name}"
    }
    app_deployment_status_publisher = {
      project_arn = local.foundation_app_status_publisher_project_arn
    }
  }

  source_path_static_fast_start_build_projects = local.app_static_fast_available ? {
    app_static_fast_gate_and_build = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_static_fast_gate_project_name}"
    }
    app_static_fast_static_deploy = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_static_fast_static_deploy_project_name}"
    }
    app_static_fast_smoke_lite = {
      project_arn = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_static_fast_smoke_project_name}"
    }
  } : {}

  source_path_start_build_guardrail_management_role_arns = local.terraform_drift_enabled ? [
    local.terraform_drift_on_demand_role_arn,
  ] : []
}

data "aws_iam_policy_document" "source_path_start_build_guardrail" {
  count = local.pipeline_enabled ? 1 : 0

  dynamic "statement" {
    for_each = toset(local.direct_start_build_shared_structural_condition_keys)

    content {
      effect    = "Deny"
      actions   = ["codebuild:StartBuild"]
      resources = ["*"]

      condition {
        test     = "Null"
        variable = statement.value
        values   = ["false"]
      }
    }
  }
}

check "source_path_start_build_guardrail_condition_keys" {
  assert {
    condition = (
      length(local.direct_start_build_shared_structural_condition_keys) == 19
      && length(distinct(local.direct_start_build_shared_structural_condition_keys)) == 19
      && length(local.direct_start_build_additional_structural_condition_keys) == 5
      && length(distinct(local.direct_start_build_additional_structural_condition_keys)) == 5
      && length(distinct(concat(
        local.direct_start_build_shared_structural_condition_keys,
        local.direct_start_build_additional_structural_condition_keys,
      ))) == 24
    )
    error_message = "The direct StartBuild guardrails must cover 19 shared and five additional distinct structural keys."
  }
}

data "aws_iam_policy_document" "source_path_start_build_guardrail_management" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid       = "CreateSourcePathStartBuildGuardrail"
    effect    = "Allow"
    actions   = ["iam:CreatePolicy"]
    resources = [local.source_path_start_build_guardrail_policy_arn]

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
    sid    = "ManageSourcePathStartBuildGuardrail"
    effect = "Allow"
    actions = [
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
    resources = [local.source_path_start_build_guardrail_policy_arn]

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
    sid    = "AttachSourcePathStartBuildGuardrail"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = local.source_path_start_build_guardrail_management_role_arns

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [local.source_path_start_build_guardrail_policy_arn]
    }
  }

  statement {
    sid       = "ReadSourcePathStartBuildGuardrailAttachments"
    effect    = "Allow"
    actions   = ["iam:ListAttachedRolePolicies"]
    resources = local.source_path_start_build_guardrail_management_role_arns
  }
}

check "source_path_start_build_guardrail_managed_policy_size" {
  assert {
    condition = (
      !local.pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.source_path_start_build_guardrail[0].json))) <= 6144, false)
    )
    error_message = "The shared source-path StartBuild guardrail must remain within IAM's 6,144-character managed-policy quota."
  }
}

resource "terraform_data" "source_path_start_build_guardrail_authorization_propagation" {
  count = local.pipeline_enabled ? 1 : 0

  triggers_replace = {
    management_policy_sha256 = sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.source_path_start_build_guardrail_management[0].json
    )))
    authority_environment_attachment_management_policy_sha256 = sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.terraform_baseline_authority_runtime_management[0].json
    )))
  }

  depends_on = [
    aws_iam_role_policy.terraform_apply,
    aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
    aws_iam_policy.terraform_baseline_authority_runtime_management,
    aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management,
      aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
      aws_iam_policy.terraform_baseline_authority_runtime_management,
      aws_iam_role_policy_attachment.terraform_baseline_authority_runtime_management,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}
