locals {
  terraform_baseline_authority_enabled = (
    local.pipeline_enabled
    && local.foundation_pipeline_enabled
    && local.app_pipeline_enabled
  )
  terraform_authority_bucket_name = local.deployment_shared_names.terraformAuthorityBucket
  terraform_authority_kms_alias   = local.deployment_shared_names.terraformAuthorityKmsAlias
  terraform_baseline_prefix       = local.deployment_shared_names.terraformBaselinePrefix
  terraform_authority_bucket_arn  = "arn:aws:s3:::${local.terraform_authority_bucket_name}"
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
  foundation_checkpoint_object_arn = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/deployment/${local.deployment_target.targetKey}/foundation/checkpoint.json"
  )
  terraform_drift_runner_project_names = {
    bootstrap  = local.deployment_shared_names.terraformDriftBootstrapProject
    foundation = local.deployment_shared_names.terraformDriftFoundationProject
    app        = local.deployment_shared_names.terraformDriftAppProject
  }
  terraform_drift_all_project_names = values(local.terraform_drift_runner_project_names)
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
  terraform_drift_on_demand_role_name = local.deployment_shared_names.terraformDriftRunnerRole
  terraform_drift_on_demand_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_drift_on_demand_role_name}"
  )
  terraform_drift_execution_role_arns = concat(
    local.terraform_drift_runner_role_arns,
    [local.terraform_drift_on_demand_role_arn],
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
  drift_start_guard_policy_names = {
    authorityEnvironment = local.deployment_shared_names.terraformDriftCoordinatorAuthorityEnvironmentPolicy
  }
  drift_start_guard_policy_arns = {
    for responsibility, name in local.drift_start_guard_policy_names :
    responsibility => "arn:aws:iam::${var.aws_account_id}:policy/${name}"
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
  terraform_drift_on_demand_managed_policy_role_attachments = {
    onDemandAuthorityEnvironment = {
      sid       = "AttachDriftOnDemandAuthorityEnvironmentPolicy"
      roleArn   = local.terraform_drift_on_demand_role_arn
      policyArn = local.drift_start_guard_policy_arns.authorityEnvironment
    }
  }
  terraform_drift_managed_policy_role_attachments = merge(
    local.terraform_drift_runner_app_managed_policy_role_attachments,
    local.terraform_drift_on_demand_managed_policy_role_attachments,
  )
  terraform_drift_managed_policy_arns = distinct([
    for attachment in values(local.terraform_drift_managed_policy_role_attachments) : attachment.policyArn
  ])
}
