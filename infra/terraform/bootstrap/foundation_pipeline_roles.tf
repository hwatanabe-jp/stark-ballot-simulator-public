resource "aws_iam_role" "foundation_pipeline" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_pipeline_role_name
  assume_role_policy   = data.aws_iam_policy_document.pipeline_assume_role[0].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_prover_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_prover_release_candidate_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_prover_release_candidate_build"].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_prover_release_toolchain_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_prover_release_toolchain_resolver_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_prover_release_toolchain_resolver_build"].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_prover_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_prover_release_update_accepted_pointer_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_prover_release_update_accepted_pointer_build"].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_toolchain_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_toolchain_release_candidate_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_toolchain_release_candidate_build"].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_toolchain_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_toolchain_release_update_accepted_pointer_build_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_toolchain_release_update_accepted_pointer_build"].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_terraform_plan" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_terraform_plan_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_terraform_plan"].json
  permissions_boundary = aws_iam_policy.foundation_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_terraform_apply" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_terraform_apply_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_terraform_apply"].json
  permissions_boundary = aws_iam_policy.foundation_apply_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

resource "aws_iam_role" "foundation_terraform_smoke" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name                 = local.foundation_terraform_smoke_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role["foundation_terraform_smoke"].json
  permissions_boundary = aws_iam_policy.foundation_smoke_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}
