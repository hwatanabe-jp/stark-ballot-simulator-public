locals {
  terraform_baseline_authority_enabled = (
    local.pipeline_enabled
    && local.foundation_pipeline_enabled
    && local.app_pipeline_enabled
  )
  terraform_authority_bucket_name = local.deployment_shared_names.terraformAuthorityBucket
  terraform_authority_kms_alias   = local.deployment_shared_names.terraformAuthorityKmsAlias
  terraform_baseline_prefix       = local.deployment_shared_names.terraformBaselinePrefix
  terraform_drift_report_prefix   = local.deployment_shared_names.terraformDriftReportPrefix

  terraform_authority_bucket_arn = "arn:aws:s3:::${local.terraform_authority_bucket_name}"
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
  terraform_bootstrap_acceptance_pointer_object_arn = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.bootstrap_lane_authority.stateIdentity}/current.json"
  )
  terraform_foundation_acceptance_pointer_object_arn = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.foundation_lane_authority.stateIdentity}/current.json"
  )
  terraform_baseline_pointer_object_arns = [
    local.terraform_bootstrap_acceptance_pointer_object_arn,
    local.terraform_foundation_acceptance_pointer_object_arn,
  ]
  terraform_bootstrap_acceptance_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.bootstrap_lane_authority.stateIdentity}/acceptances/*"
  )
  terraform_foundation_acceptance_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.foundation_lane_authority.stateIdentity}/acceptances/*"
  )
  terraform_foundation_baseline_history_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.foundation_lane_authority.stateIdentity}/executions/*"
  )
  terraform_bootstrap_baseline_history_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.bootstrap_lane_authority.stateIdentity}/executions/*"
  )
  terraform_app_baseline_history_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.app_lane_authority.stateIdentity}/executions/*"
  )
  terraform_current_immutable_object_arn_patterns = [
    local.terraform_bootstrap_acceptance_object_arn_pattern,
    local.terraform_foundation_acceptance_object_arn_pattern,
  ]
  terraform_drift_report_object_arn_pattern = (
    "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_drift_report_prefix}/*"
  )
  terraform_drift_app_accepted_pointer_key = local.deployment_shared_names.acceptedDeploymentPointerKey
  terraform_drift_app_accepted_pointer_arn = (
    "${local.app_retained_artifact_bucket_arn}/${local.terraform_drift_app_accepted_pointer_key}"
  )
  terraform_app_acceptance_object_arn_pattern = (
    "${local.app_retained_artifact_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/acceptances/*"
  )

  terraform_drift_runner_project_names = {
    bootstrap  = local.deployment_shared_names.terraformDriftBootstrapProject
    foundation = local.deployment_shared_names.terraformDriftFoundationProject
    app        = local.deployment_shared_names.terraformDriftAppProject
  }
  terraform_drift_all_project_names = values(local.terraform_drift_runner_project_names)
  terraform_drift_runner_project_arns = [
    for name in values(local.terraform_drift_runner_project_names) :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  terraform_drift_all_project_arns = local.terraform_drift_runner_project_arns
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
  terraform_drift_on_demand_administrator_access_role_arn = (
    local.saved_plan_approval_administrator_access_role_arn
  )
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
  terraform_drift_coordinator_guardrail_policy_names = {
    authorityEnvironment = local.deployment_shared_names.terraformDriftCoordinatorAuthorityEnvironmentPolicy
  }
  terraform_drift_coordinator_guardrail_policy_arns = {
    for responsibility, name in local.terraform_drift_coordinator_guardrail_policy_names :
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
      policyArn = local.terraform_drift_coordinator_guardrail_policy_arns.authorityEnvironment
    }
  }
  terraform_drift_managed_policy_role_attachments = merge(
    local.terraform_drift_runner_app_managed_policy_role_attachments,
    local.terraform_drift_on_demand_managed_policy_role_attachments,
  )
  terraform_drift_managed_policy_arns = distinct([
    for attachment in values(local.terraform_drift_managed_policy_role_attachments) : attachment.policyArn
  ])
  terraform_baseline_publishers = local.terraform_baseline_authority_enabled ? {
    bootstrap = {
      role     = local.bootstrap_terraform_acceptance_publisher_role_name
      role_arn = local.bootstrap_terraform_acceptance_publisher_role_arn
      object_arns = [
        local.terraform_bootstrap_acceptance_object_arn_pattern,
        local.terraform_bootstrap_acceptance_pointer_object_arn,
      ]
    }
    foundation = {
      role     = local.foundation_terraform_acceptance_publisher_role_name
      role_arn = local.foundation_terraform_acceptance_publisher_role_arn
      object_arns = [
        local.terraform_foundation_acceptance_object_arn_pattern,
        local.terraform_foundation_acceptance_pointer_object_arn,
      ]
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
}
