locals {
  ecs_container_image = trimspace(var.ecs_image_uri)

  ecs_public_subnet_ids = [for subnet in aws_subnet.public : subnet.id]
}

resource "aws_ecs_cluster" "prover" {
  name = "${var.project_name}-prover-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${var.project_name}-prover-${var.environment}"
  }
}

resource "aws_ecs_task_definition" "prover" {
  family                   = "${var.project_name}-prover-${var.environment}"
  cpu                      = tostring(var.ecs_cpu)
  memory                   = tostring(var.ecs_memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "prover"
      image     = local.ecs_container_image
      essential = true
      environment = [
        {
          name  = "ENV_NAME"
          value = var.environment
        },
        {
          name  = "S3_PROOF_BUCKET"
          value = local.proof_bundle_bucket_name
        },
        {
          name  = "S3_PROOF_PREFIX"
          value = var.s3_proof_prefix
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ecs_prover.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "prover"
        }
      }
    }
  ])
}
