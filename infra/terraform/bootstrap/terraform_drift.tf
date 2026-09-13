locals {
  terraform_drift_coordinator_guardrail_policy_configuration = local.terraform_drift_enabled ? {
    authorityEnvironment = {
      name = local.deployment_shared_names.terraformDriftCoordinatorAuthorityEnvironmentPolicy
    }
  } : {}
  source_path_start_build_guardrail_policy_configuration = local.pipeline_enabled ? {
    requestShape = {
      name = local.source_path_start_build_guardrail_policy_name
    }
  } : {}
  terraform_drift_coordinator_guardrail_managed_policy_configuration = merge(
    local.source_path_start_build_guardrail_policy_configuration,
    local.terraform_drift_coordinator_guardrail_policy_configuration,
  )
  terraform_drift_direct_start_project_arns = local.terraform_drift_runner_project_arns
}

data "aws_iam_policy_document" "terraform_drift_on_demand_assume_role" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid     = "AssumeFromExactAdministratorAccessRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.terraform_drift_on_demand_administrator_access_role_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:RoleSessionName"
      values   = [local.terraform_drift_on_demand_role_name]
    }
  }
}

check "terraform_drift_on_demand_role_session_name" {
  assert {
    condition = (
      length(local.terraform_drift_on_demand_role_name) >= 2
      && length(local.terraform_drift_on_demand_role_name) <= 64
      && can(regex("^[A-Za-z0-9+=,.@_-]+$", local.terraform_drift_on_demand_role_name))
    )
    error_message = "The on-demand Terraform drift starter role name must also be a valid fixed role session name."
  }
}

resource "aws_iam_role" "terraform_drift_on_demand" {
  count = local.terraform_drift_enabled ? 1 : 0

  depends_on = [
    terraform_data.source_path_start_build_guardrail_authorization_propagation,
    terraform_data.terraform_baseline_authority_storage_authorization_propagation,
  ]

  name                 = local.terraform_drift_on_demand_role_name
  assume_role_policy   = data.aws_iam_policy_document.terraform_drift_on_demand_assume_role[0].json
  max_session_duration = 3600
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "terraform_drift_on_demand_start" {
  count = local.terraform_drift_enabled ? 1 : 0

  statement {
    sid       = "StartExactTerraformDriftRunnersOnDemand"
    effect    = "Allow"
    actions   = ["codebuild:StartBuild"]
    resources = local.terraform_drift_runner_project_arns
  }
}

resource "aws_iam_role_policy" "terraform_drift_on_demand_start" {
  count = local.terraform_drift_enabled ? 1 : 0

  depends_on = [terraform_data.terraform_drift_on_demand_guardrail_authorization_propagation]

  name   = "${local.terraform_drift_on_demand_role_name}-start"
  role   = aws_iam_role.terraform_drift_on_demand[0].id
  policy = data.aws_iam_policy_document.terraform_drift_on_demand_start[0].json

  lifecycle {
    replace_triggered_by = [terraform_data.terraform_drift_on_demand_guardrail_authorization_propagation]
  }
}

check "terraform_drift_on_demand_inline_policy_size" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_drift_on_demand_start[0].json))) <= 10240, false)
    )
    error_message = "The on-demand Terraform drift starter policy must remain within IAM's aggregate 10,240-character inline-policy quota."
  }
}

data "aws_iam_policy_document" "terraform_drift_coordinator_guardrail" {
  for_each = local.terraform_drift_coordinator_guardrail_policy_configuration

  statement {
    sid       = "DenyTerraformDriftEnvironmentVariablesOverride"
    effect    = "Deny"
    actions   = ["codebuild:StartBuild"]
    resources = local.terraform_drift_direct_start_project_arns

    condition {
      test     = "Null"
      variable = "codebuild:environment.environmentVariables.name"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = toset(local.direct_start_build_additional_structural_condition_keys)

    content {
      effect    = "Deny"
      actions   = ["codebuild:StartBuild"]
      resources = local.terraform_drift_direct_start_project_arns

      condition {
        test     = "Null"
        variable = statement.value
        values   = ["false"]
      }
    }
  }
}

resource "aws_iam_policy" "terraform_drift_coordinator_guardrail" {
  for_each = local.terraform_drift_coordinator_guardrail_managed_policy_configuration

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    terraform_data.source_path_start_build_guardrail_authorization_propagation,
  ]

  name = each.value.name
  policy = (
    each.key == "requestShape"
    ? data.aws_iam_policy_document.source_path_start_build_guardrail[0].json
    : data.aws_iam_policy_document.terraform_drift_coordinator_guardrail[each.key].json
  )
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "terraform_drift_on_demand_guardrail" {
  for_each = local.terraform_drift_coordinator_guardrail_managed_policy_configuration

  depends_on = [terraform_data.source_path_start_build_guardrail_authorization_propagation]

  role       = aws_iam_role.terraform_drift_on_demand[0].name
  policy_arn = aws_iam_policy.terraform_drift_coordinator_guardrail[each.key].arn
}

resource "terraform_data" "terraform_drift_on_demand_guardrail_authorization_propagation" {
  count = local.terraform_drift_enabled ? 1 : 0

  triggers_replace = {
    authorization_sha256 = sha256(jsonencode({
      roleArn = local.terraform_drift_on_demand_role_arn
      guardrails = {
        for responsibility, document in data.aws_iam_policy_document.terraform_drift_coordinator_guardrail :
        responsibility => jsondecode(document.json)
      }
    }))
  }

  depends_on = [aws_iam_role_policy_attachment.terraform_drift_on_demand_guardrail]

  lifecycle {
    replace_triggered_by = [
      aws_iam_role.terraform_drift_on_demand,
      aws_iam_policy.terraform_drift_coordinator_guardrail,
      aws_iam_role_policy_attachment.terraform_drift_on_demand_guardrail,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }

  provisioner "local-exec" {
    when        = destroy
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}

check "terraform_drift_coordinator_guardrail_managed_policy_sizes" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || try(alltrue([
        for document in values(data.aws_iam_policy_document.terraform_drift_coordinator_guardrail) :
        length(jsonencode(jsondecode(document.json))) <= 6144
      ]), false)
    )
    error_message = "Each Terraform drift coordinator guardrail managed policy must remain within IAM's 6,144-character quota."
  }
}

check "terraform_drift_managed_policy_attachment_quotas" {
  assert {
    condition = (
      !local.terraform_drift_enabled
      || (
        length(local.terraform_drift_runner_app_managed_policy_role_attachments) <= 10
        && length(local.terraform_drift_coordinator_guardrail_managed_policy_configuration) <= 10
      )
    )
    error_message = "The App drift runner and direct drift starters must each remain within IAM's ten managed-policy attachment quota."
  }
}
