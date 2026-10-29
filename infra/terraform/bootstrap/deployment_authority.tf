locals {
  deployment_target_configuration = jsondecode(file("${path.module}/../../../packages/deployment-authority/deployment-targets.json"))
  deployment_target = one([
    for target in values(local.deployment_target_configuration.allowedTargets) : target
    if target.accountLabel == var.account_alias && target.environmentId == var.deployment_environment
  ])
  deployment_shared_names = local.deployment_target.sharedNames
  deployment_cli_command = (
    local.deployment_target.environmentId == "develop"
    ? "pnpm aws:deploy:develop --"
    : "pnpm exec tsx scripts/aws/deploy-cli.ts --target ${local.deployment_target.targetKey}"
  )

  bootstrap_lane_authority  = local.deployment_target.lanes.bootstrap
  foundation_lane_authority = local.deployment_target.lanes.foundation
  toolchain_lane_authority  = local.deployment_target.lanes.toolchain
  prover_lane_authority     = local.deployment_target.lanes.prover
  app_lane_authority        = local.deployment_target.lanes.app

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
    && var.github_full_repository_id == local.deployment_target.repository
    && var.source_branch == local.deployment_target.sourceBranch
    && var.state_scope == local.bootstrap_lane_authority.scope
    && var.state_backend_key == local.bootstrap_lane_authority.backendKey
    && var.state_bucket_name == local.deployment_shared_names.terraformStateBucket
    && var.state_kms_alias == local.deployment_shared_names.terraformStateKmsAlias
  )
}

check "deployment_target_configuration" {
  assert {
    condition     = local.deployment_target_configuration_exact
    error_message = "Deployment target configuration must contain only reviewed targets with matching keys."
  }
}
