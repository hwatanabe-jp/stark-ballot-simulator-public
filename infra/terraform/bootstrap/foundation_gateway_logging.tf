locals {
  foundation_gateway_logging_role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.runtimeNamePrefix}-gateway-logs"
  foundation_gateway_logging_boundary_arn = "arn:aws:iam::${var.aws_account_id}:policy/${local.deployment_shared_names.runtimeNamePrefix}-gateway-logs-boundary"
  foundation_gateway_account_arn          = "arn:aws:apigateway:${var.aws_region}::/account"
  foundation_gateway_logging_read_actions = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListRoleTags", "iam:ListPolicyTags"]
}

data "aws_iam_policy_document" "foundation_gateway_logging_read" {
  statement {
    effect    = "Allow"
    actions   = ["apigateway:GET"]
    resources = [local.foundation_gateway_account_arn]
  }
  statement {
    effect    = "Allow"
    actions   = local.foundation_gateway_logging_read_actions
    resources = [local.foundation_gateway_logging_role_arn, local.foundation_gateway_logging_boundary_arn]
  }
}

data "aws_iam_policy_document" "foundation_gateway_logging_write" {
  source_policy_documents = [data.aws_iam_policy_document.foundation_gateway_logging_read.json]
  statement {
    effect    = "Allow"
    actions   = ["apigateway:PATCH"]
    resources = [local.foundation_gateway_account_arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
    resources = [local.foundation_gateway_logging_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.foundation_gateway_logging_boundary_arn]
    }
  }
  statement {
    effect    = "Allow"
    actions   = ["iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy"]
    resources = [local.foundation_gateway_logging_role_arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"]
    resources = [local.foundation_gateway_logging_boundary_arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.foundation_gateway_logging_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["apigateway.amazonaws.com"]
    }
  }
}

# This ceiling is scoped to two exact Foundation-owned IAM identities. The
# workload identity policy above retains the action set, boundary condition,
# and service-specific PassRole restriction in the effective intersection.
data "aws_iam_policy_document" "foundation_gateway_logging_ceiling" {
  statement {
    effect    = "Allow"
    actions   = ["apigateway:GET", "apigateway:PATCH"]
    resources = [local.foundation_gateway_account_arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["iam:*"]
    resources = [local.foundation_gateway_logging_role_arn, local.foundation_gateway_logging_boundary_arn]
  }
}
