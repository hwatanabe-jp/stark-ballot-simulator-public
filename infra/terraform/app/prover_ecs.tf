data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:*"]
    }
  }
}

resource "aws_iam_role" "prover_task_execution" {
  name               = "${local.name_prefix}-prover-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "prover_task_execution_default" {
  role       = aws_iam_role.prover_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_secretsmanager_secret" "prover_log_hash_salt" {
  name = local.runtime_reference_names.LOG_IP_HASH_SALT_REF
}

data "aws_iam_policy_document" "prover_task_execution_observability" {
  statement {
    sid       = "ReadProverLogHashSalt"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [data.aws_secretsmanager_secret.prover_log_hash_salt.arn]
  }
}

resource "aws_iam_role_policy" "prover_task_execution_observability" {
  name   = "${local.name_prefix}-prover-observability"
  role   = aws_iam_role.prover_task_execution.id
  policy = data.aws_iam_policy_document.prover_task_execution_observability.json
}

resource "aws_iam_role" "prover_task" {
  name               = "${local.name_prefix}-prover-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "prover_task" {
  statement {
    sid       = "AdmitProverStart"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.target_application_lambda_names.finalization_writer}"]
  }

  statement {
    sid    = "UseProofArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.proof_artifacts.arn}/${local.proof_artifact_prefix}*"]
  }

  statement {
    sid    = "ListProofArtifactPrefix"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.proof_artifacts.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [local.proof_artifact_prefix, "${local.proof_artifact_prefix}*"]
    }
  }
}

resource "aws_iam_role_policy" "prover_task" {
  name   = "${local.name_prefix}-prover-task"
  role   = aws_iam_role.prover_task.id
  policy = data.aws_iam_policy_document.prover_task.json
}

resource "aws_cloudwatch_log_group" "prover" {
  name              = "/aws/ecs/${local.name_prefix}-prover"
  retention_in_days = local.storage_retention.runtime_log_days
  tags              = local.common_tags
}

locals {
  prover_container_insights_performance_log_groups = {
    current = "/aws/ecs/containerinsights/${local.name_prefix}-prover/performance"
  }
  existing_prover_container_insights_performance_log_groups = (
    var.account_alias == local.deployment_target.accountLabel
    && var.deployment_environment == local.deployment_target.environmentId
    && local.deployment_target.environmentTier == "development"
    ? local.prover_container_insights_performance_log_groups
    : {}
  )
}

import {
  for_each = local.existing_prover_container_insights_performance_log_groups

  to = aws_cloudwatch_log_group.prover_container_insights_performance[each.key]
  id = each.value
}

resource "aws_cloudwatch_log_group" "prover_container_insights_performance" {
  for_each = local.prover_container_insights_performance_log_groups

  name              = each.value
  retention_in_days = local.storage_retention.container_insights_performance_days
  tags              = local.common_tags
}
