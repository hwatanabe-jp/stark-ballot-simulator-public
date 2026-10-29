locals {
  pipeline_enabled    = var.enable_development_pipeline
  codeconnection_name = "sbs-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  # Historical build logs remain retained after the managed Bootstrap lane retires.
  codebuild_project_names = [
    local.bootstrap_lane_authority.names.terraformPlanProject,
    local.bootstrap_lane_authority.names.terraformApplyProject,
    local.bootstrap_lane_authority.names.smokeProject,
  ]
  codebuild_log_group_arns = [
    for name in local.codebuild_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  oidc_provider_arn = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
}
