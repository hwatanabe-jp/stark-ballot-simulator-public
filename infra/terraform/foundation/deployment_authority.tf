locals {
  deployment_target_configuration = jsondecode(file("${path.module}/../../../packages/deployment-authority/deployment-targets.json"))
  deployment_target = one([
    for target in values(local.deployment_target_configuration.allowedTargets) : target
    if target.accountLabel == var.account_alias && target.environmentId == var.deployment_environment
  ])
  foundation_public_subnet_exception = (
    local.deployment_target.environmentTier == "development"
    ? "accepted-for-develop-prover-egress"
    : local.deployment_target.productionPolicy.foundationPublicSubnetException
  )
  deployment_shared_names   = local.deployment_target.sharedNames
  foundation_lane_authority = local.deployment_target.lanes.foundation

  deployment_target_configuration_exact = (
    local.deployment_target_configuration.configurationType == "deployment-target-configuration"
    && length(local.deployment_target_configuration.allowedTargets) > 0
    && alltrue([for key, target in local.deployment_target_configuration.allowedTargets : key == target.targetKey])
  )
  deployment_target_inputs_exact = (
    var.aws_account_id == local.deployment_target.accountId
    && var.aws_region == local.deployment_target.region
    && var.account_alias == local.deployment_target.accountLabel
    && var.deployment_environment == local.deployment_target.environmentId
    && var.project_name == local.deployment_target.projectId
    && var.state_scope == local.foundation_lane_authority.scope
    && var.state_backend_key == local.foundation_lane_authority.backendKey
  )
}

check "deployment_target_configuration" {
  assert {
    condition     = local.deployment_target_configuration_exact
    error_message = "Deployment target configuration must contain only reviewed targets with matching keys."
  }
}
