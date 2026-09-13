locals {
  pipeline_enabled                                   = var.enable_development_pipeline
  pipeline_name                                      = local.bootstrap_lane_authority.names.pipeline
  codeconnection_name                                = "sbs-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  pipeline_role_name                                 = local.bootstrap_lane_authority.names.pipelineRole
  terraform_plan_role_name                           = local.bootstrap_lane_authority.names.terraformPlanRole
  terraform_apply_role_name                          = local.bootstrap_lane_authority.names.terraformApplyRole
  terraform_smoke_role_name                          = local.bootstrap_lane_authority.names.terraformSmokeRole
  bootstrap_terraform_acceptance_publisher_role_name = local.deployment_shared_names.bootstrapTerraformAcceptancePublisherRole
  bootstrap_terraform_acceptance_publisher_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.bootstrap_terraform_acceptance_publisher_role_name}"
  )
  foundation_terraform_acceptance_publisher_role_name = (
    local.deployment_shared_names.foundationTerraformAcceptancePublisherRole
  )
  foundation_terraform_acceptance_publisher_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_acceptance_publisher_role_name}"
  )
  github_trigger_role_name = local.bootstrap_lane_authority.names.githubTriggerRole
  bootstrap_deploy_permissions_boundary_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-deploy-boundary-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}-${local.bootstrap_lane_authority.scope}"
  )
  bootstrap_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_deploy_permissions_boundary_policy_name}"
  )
  bootstrap_apply_app_lane_policy_admin_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-apply-app-lane-admin-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  )
  bootstrap_apply_artifact_management_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-apply-artifacts-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  )
  bootstrap_apply_artifact_management_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_apply_artifact_management_policy_name}"
  )
  bootstrap_apply_foundation_lane_policy_arns = local.foundation_pipeline_enabled ? local.foundation_lane_management_policy_arns : []
  bootstrap_apply_managed_policy_arns = concat(
    [
      "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_apply_app_lane_policy_admin_policy_name}",
      local.bootstrap_apply_artifact_management_policy_arn,
      local.terraform_baseline_authority_management_policy_arn,
      local.terraform_baseline_authority_runtime_management_policy_arn,
    ],
    local.bootstrap_apply_foundation_lane_policy_arns,
  )
  bootstrap_apply_administered_policy_arns = concat(
    local.bootstrap_apply_managed_policy_arns,
    local.foundation_pipeline_enabled ? [local.foundation_terraform_apply_workload_policy_arn] : [],
    values(local.terraform_drift_bootstrap_provider_policy_arns),
  )
  terraform_plan_project_name  = local.bootstrap_lane_authority.names.terraformPlanProject
  terraform_apply_project_name = local.bootstrap_lane_authority.names.terraformApplyProject
  smoke_project_name           = local.bootstrap_lane_authority.names.smokeProject

  codebuild_project_names = [
    local.terraform_plan_project_name,
    local.terraform_apply_project_name,
    local.smoke_project_name,
  ]

  codebuild_project_arns = [
    for name in local.codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  codebuild_log_group_arns = [
    for name in local.codebuild_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  pipeline_arn      = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.pipeline_name}"
  oidc_provider_arn = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
  bootstrap_pipeline_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_smoke_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.bootstrap_terraform_acceptance_publisher_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.github_trigger_role_name}",
  ]
  terraform_distribution_sha256 = (
    "d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d"
  )

  terraform_install_commands = [
    "set -eu",
    "curl -fsSLo /tmp/terraform.zip \"https://releases.hashicorp.com/terraform/${var.terraform_version}/terraform_${var.terraform_version}_linux_amd64.zip\"; echo \"${local.terraform_distribution_sha256}  /tmp/terraform.zip\" | sha256sum --check --status; unzip -q -o /tmp/terraform.zip -d /usr/local/bin",
    "terraform version -json > /tmp/stark-ballot-terraform-version.json && jq -e -c 'select(.terraform_version == \"${var.terraform_version}\" and .platform == \"linux_amd64\") | {terraform_version, platform}' /tmp/stark-ballot-terraform-version.json",
  ]

}
