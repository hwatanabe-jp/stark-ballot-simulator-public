locals {
  log_retention_days = local.current_environment_settings.log_retention_days
}

resource "aws_cloudwatch_log_group" "ecs_prover" {
  name              = local.ecs_log_group_name
  retention_in_days = local.log_retention_days

  tags = {
    Name = local.ecs_log_group_name
  }
}

resource "aws_cloudwatch_log_group" "sfn_prover" {
  name              = local.sfn_log_group_name
  retention_in_days = local.log_retention_days

  tags = {
    Name = local.sfn_log_group_name
  }
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/aws/codebuild/${var.project_name}-fargate-prover-${var.environment}"
  retention_in_days = local.log_retention_days

  tags = {
    Name = "/aws/codebuild/${var.project_name}-fargate-prover-${var.environment}"
  }
}

resource "aws_cloudwatch_log_group" "codebuild_risc0_toolchain" {
  provider          = aws.shared
  name              = "/aws/codebuild/${var.risc0_toolchain_codebuild_name}"
  retention_in_days = local.shared_log_retention_days

  tags = {
    Name = "/aws/codebuild/${var.risc0_toolchain_codebuild_name}"
  }
}
