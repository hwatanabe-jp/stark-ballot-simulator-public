resource "aws_iam_role" "app_pipeline" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_pipeline_role_name
  assume_role_policy   = data.aws_iam_policy_document.pipeline_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_terraform_plan" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_terraform_plan_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_deployment_record" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_deployment_record_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_terraform_apply" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_terraform_apply_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_apply_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_terraform_smoke" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_terraform_smoke_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_smoke_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_static_deploy" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_static_deploy_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_apply_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}

resource "aws_iam_role" "app_github_trigger" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_github_trigger_role_name
  assume_role_policy   = data.aws_iam_policy_document.github_trigger_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management]
}
