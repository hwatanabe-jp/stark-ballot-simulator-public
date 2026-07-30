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
    var.account_alias == "stark-dev" && var.deployment_environment == "develop"
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

resource "aws_ecs_cluster" "prover" {
  name = "${local.name_prefix}-prover"

  depends_on = [aws_cloudwatch_log_group.prover_container_insights_performance]

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "prover" {
  family                   = "${local.name_prefix}-prover"
  cpu                      = tostring(var.prover_cpu)
  memory                   = tostring(var.prover_memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.prover_task_execution.arn
  task_role_arn            = aws_iam_role.prover_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "prover-tmp"
  }

  volume {
    name = "prover-output"
  }

  container_definitions = jsonencode([
    {
      name                   = "prover"
      image                  = var.prover_image_uri
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      stopTimeout            = 120
      linuxParameters = {
        initProcessEnabled = true
        capabilities = {
          drop = ["ALL"]
        }
      }
      mountPoints = [
        {
          sourceVolume  = "prover-tmp"
          containerPath = "/tmp"
          readOnly      = false
        },
        {
          sourceVolume  = "prover-output"
          containerPath = "/var/task/output"
          readOnly      = false
        },
      ]
      environment = [
        {
          name  = "ENV_NAME"
          value = var.deployment_environment
        },
        {
          name  = "RUNTIME_DEPLOYMENT_ENV"
          value = var.deployment_environment
        },
        {
          name  = "DEPLOYMENT_ID"
          value = var.deployment_id
        },
        {
          name  = "APP_SOURCE_SHA"
          value = var.app_source_sha
        },
        {
          name  = "DEPLOY_MODE"
          value = var.deploy_mode
        },
        {
          name  = "TARGET_AWS_RUNTIME"
          value = "1"
        },
        {
          name  = "AWS_ACCOUNT_ID"
          value = var.aws_account_id
        },
        {
          name  = "S3_PROOF_BUCKET"
          value = aws_s3_bucket.proof_artifacts.bucket
        },
        {
          name  = "S3_PROOF_PREFIX"
          value = local.proof_artifact_prefix
        },
      ]
      secrets = [
        {
          name      = "LOG_IP_HASH_SALT"
          valueFrom = data.aws_secretsmanager_secret.prover_log_hash_salt.arn
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.prover.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "prover"
          "mode"                  = "non-blocking"
          "max-buffer-size"       = "25m"
        }
      }
    }
  ])

  lifecycle {
    precondition {
      condition     = can(regex(local.prover_image_uri_pattern, var.prover_image_uri))
      error_message = "prover_image_uri must reference the expected target account and region."
    }
  }

  tags = local.common_tags
}
