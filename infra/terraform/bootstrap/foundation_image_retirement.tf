locals {
  foundation_image_retirement_enabled   = local.foundation_pipeline_enabled && local.deployment_target.environmentId == "main"
  foundation_retired_image_function_arn = "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.deployment_shared_names.runtimeNamePrefix}-ecr-retention"
  foundation_retired_image_role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${local.deployment_shared_names.retiredImageRetentionRole}"
  foundation_retired_image_boundary_arn = "arn:aws:iam::${var.aws_account_id}:policy/${local.deployment_shared_names.retiredImageRetentionBoundaryPolicy}"
  foundation_retired_image_rule_arn     = "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.deployment_shared_names.runtimeNamePrefix}-ecr-retention-daily"
  foundation_retained_image_log_arn     = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.deployment_shared_names.runtimeNamePrefix}-ecr-retention"
}

# Foundation still owns the attached role until its managed retirement. Keep
# this identity in Bootstrap and revoke all execution rights before that step.
resource "aws_iam_policy" "foundation_ecr_retention_boundary" {
  count = local.foundation_image_retirement_enabled ? 1 : 0
  name  = local.deployment_shared_names.retiredImageRetentionBoundaryPolicy
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Deny", Action = "*", Resource = "*" }]
  })
  tags = merge(local.common_tags, { StateScope = "foundation" })
  lifecycle { prevent_destroy = true }
}

data "aws_iam_policy_document" "foundation_retained_image_logs_read" {
  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:ListTagsForResource", "logs:ListTagsLogGroup"]
    resources = [local.foundation_retained_image_log_arn, "${local.foundation_retained_image_log_arn}:*"]
  }
}

data "aws_iam_policy_document" "foundation_image_retirement_read" {
  count = local.foundation_image_retirement_enabled ? 1 : 0
  statement {
    actions   = ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConcurrency", "lambda:GetPolicy", "lambda:ListTags", "lambda:ListVersionsByFunction"]
    resources = [local.foundation_retired_image_function_arn]
  }
  statement {
    actions   = ["events:DescribeRule", "events:ListTargetsByRule", "events:ListTagsForResource"]
    resources = [local.foundation_retired_image_rule_arn]
  }
  statement {
    actions   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListRoleTags", "iam:ListInstanceProfilesForRole", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:ListPolicyTags"]
    resources = [local.foundation_retired_image_role_arn, local.foundation_retired_image_boundary_arn]
  }
}

data "aws_iam_policy_document" "foundation_image_retirement_delete" {
  count = local.foundation_image_retirement_enabled ? 1 : 0
  statement {
    actions   = ["lambda:DeleteFunction", "lambda:RemovePermission"]
    resources = [local.foundation_retired_image_function_arn]
  }
  statement {
    actions   = ["events:DisableRule", "events:RemoveTargets", "events:DeleteRule"]
    resources = [local.foundation_retired_image_rule_arn]
  }
  statement {
    actions   = ["iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRolePermissionsBoundary"]
    resources = [local.foundation_retired_image_role_arn]
  }
}

# This one Foundation-owned audit group remains managed in both targets.
# Creation is needed only where the earlier retirement already removed it.
data "aws_iam_policy_document" "foundation_retained_image_logs_write" {
  source_policy_documents = [data.aws_iam_policy_document.foundation_retained_image_logs_read.json]
  statement {
    actions   = ["logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource"]
    resources = [local.foundation_retained_image_log_arn, "${local.foundation_retained_image_log_arn}:*"]
  }
}

# The identity policies above permit only read/retirement operations. This
# compact boundary ceiling applies to those four exact identities; it does not
# grant permission to invoke, create or reconfigure the retired controller.
data "aws_iam_policy_document" "foundation_image_retirement_ceiling" {
  count = local.foundation_image_retirement_enabled ? 1 : 0
  statement {
    actions   = ["iam:*", "lambda:*", "events:*"]
    resources = [local.foundation_retired_image_function_arn, local.foundation_retired_image_role_arn, local.foundation_retired_image_boundary_arn, local.foundation_retired_image_rule_arn]
  }
}
