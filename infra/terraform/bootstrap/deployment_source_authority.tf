data "aws_iam_policy_document" "pipeline_assume_role" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codepipeline.amazonaws.com"]
    }
  }
}

locals {
  managed_codebuild_executions = {
    foundation_terraform_plan                                  = { project = local.foundation_terraform_plan_project_name, pipeline = local.foundation_pipeline_name }
    foundation_terraform_apply                                 = { project = local.foundation_terraform_apply_project_name, pipeline = local.foundation_pipeline_name }
    foundation_terraform_smoke                                 = { project = local.foundation_smoke_project_name, pipeline = local.foundation_pipeline_name }
    app_terraform_plan                                         = { project = local.app_terraform_plan_project_name, pipeline = local.app_pipeline_name }
    app_terraform_apply                                        = { project = local.app_terraform_apply_project_name, pipeline = local.app_pipeline_name }
    app_terraform_smoke                                        = { project = local.app_smoke_project_name, pipeline = local.app_pipeline_name }
    app_static_deploy                                          = { project = local.app_static_deploy_project_name, pipeline = local.app_pipeline_name }
    app_deployment_status_publisher                            = { project = local.foundation_app_status_publisher_project_name, pipeline = local.app_pipeline_name }
    foundation_prover_release_candidate_build                  = { project = local.prover_release_candidate_project_name, pipeline = local.prover_release_pipeline_name }
    foundation_prover_release_toolchain_resolver_build         = { project = local.prover_release_toolchain_resolver_project_name, pipeline = local.prover_release_pipeline_name }
    foundation_prover_release_update_accepted_pointer_build    = { project = local.prover_release_update_accepted_pointer_project_name, pipeline = local.prover_release_pipeline_name }
    foundation_toolchain_release_candidate_build               = { project = local.toolchain_release_candidate_project_name, pipeline = local.toolchain_release_pipeline_name }
    foundation_toolchain_release_update_accepted_pointer_build = { project = local.toolchain_release_update_accepted_pointer_project_name, pipeline = local.toolchain_release_pipeline_name }
  }
}

data "aws_iam_policy_document" "codebuild_assume_role" {
  for_each = local.pipeline_enabled ? local.managed_codebuild_executions : {}
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${each.value.project}"]
    }
  }
}

# BatchGetBuilds authorizes the project ARN, not a build ARN. Each running
# build observes its own project and owning pipeline; runtime admission binds
# the response to the exact native build/action/source.
data "aws_iam_policy_document" "managed_execution_read" {
  for_each = local.pipeline_enabled ? local.managed_codebuild_executions : {}
  statement {
    actions   = ["codebuild:BatchGetBuilds"]
    resources = ["arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${each.value.project}"]
  }
  statement {
    actions   = ["codepipeline:ListActionExecutions", "codepipeline:GetPipelineExecution"]
    resources = ["arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${each.value.pipeline}"]
  }
}

resource "aws_iam_policy" "managed_execution_read" {
  for_each = local.pipeline_enabled ? local.managed_codebuild_executions : {}
  name     = "${each.value.project}-execution-read"

  policy = data.aws_iam_policy_document.managed_execution_read[each.key].json
}

resource "aws_iam_role_policy_attachment" "managed_execution_read" {
  for_each = local.pipeline_enabled ? local.managed_codebuild_executions : {}
  role = {
    foundation_terraform_plan                                  = aws_iam_role.foundation_terraform_plan[0].name
    foundation_terraform_apply                                 = aws_iam_role.foundation_terraform_apply[0].name
    foundation_terraform_smoke                                 = aws_iam_role.foundation_terraform_smoke[0].name
    app_terraform_plan                                         = aws_iam_role.app_terraform_plan[0].name
    app_terraform_apply                                        = aws_iam_role.app_terraform_apply[0].name
    app_terraform_smoke                                        = aws_iam_role.app_terraform_smoke[0].name
    app_static_deploy                                          = aws_iam_role.app_static_deploy[0].name
    app_deployment_status_publisher                            = aws_iam_role.app_deployment_status_publisher[0].name
    foundation_prover_release_candidate_build                  = aws_iam_role.foundation_prover_release_candidate_build[0].name
    foundation_prover_release_toolchain_resolver_build         = aws_iam_role.foundation_prover_release_toolchain_resolver_build[0].name
    foundation_prover_release_update_accepted_pointer_build    = aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].name
    foundation_toolchain_release_candidate_build               = aws_iam_role.foundation_toolchain_release_candidate_build[0].name
    foundation_toolchain_release_update_accepted_pointer_build = aws_iam_role.foundation_toolchain_release_update_accepted_pointer_build[0].name
  }[each.key]
  policy_arn = aws_iam_policy.managed_execution_read[each.key].arn
}

resource "aws_codeconnections_connection" "source" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.codeconnection_name
  provider_type = "GitHub"

  tags = merge(local.common_tags, {
    Name = local.codeconnection_name
  })
}
