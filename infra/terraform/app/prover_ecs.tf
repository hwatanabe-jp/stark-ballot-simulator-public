data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
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
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_ecs_cluster" "prover" {
  name = "${local.name_prefix}-prover"

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

  container_definitions = jsonencode([
    {
      name      = "prover"
      image     = var.prover_image_uri
      essential = true
      environment = [
        {
          name  = "ENV_NAME"
          value = var.deployment_environment
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
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.prover.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "prover"
        }
      }
    }
  ])

  tags = local.common_tags
}
