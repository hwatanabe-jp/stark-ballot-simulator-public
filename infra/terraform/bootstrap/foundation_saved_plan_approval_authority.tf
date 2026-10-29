locals {
  saved_plan_approval_administrator_access_role_candidates = [
    for arn in var.backend_principal_arns : arn
    if can(regex(
      "^arn:${local.deployment_target.partition}:iam::${var.aws_account_id}:role/aws-reserved/sso.amazonaws.com/${var.aws_region}/AWSReservedSSO_AdministratorAccess_[0-9a-f]{16}$",
      arn,
    ))
  ]
  saved_plan_approval_administrator_access_role_arn = (
    local.terraform_baseline_authority_enabled
    ? one(local.saved_plan_approval_administrator_access_role_candidates)
    : null
  )
}

check "saved_plan_approval_administrator_access_is_exact" {
  assert {
    condition = (
      !local.terraform_baseline_authority_enabled
      || length(local.saved_plan_approval_administrator_access_role_candidates) == 1
    )
    error_message = "Saved-plan approval authority requires exactly one regional AdministratorAccess SSO role among the governed backend principals."
  }
}
