locals {
  alarmed_dynamodb_tables = {
    sessions            = aws_dynamodb_table.sessions.name
    votes               = aws_dynamodb_table.votes.name
    rate_limit_events   = aws_dynamodb_table.rate_limit_events.name
    rate_limit_counters = aws_dynamodb_table.rate_limit_counters.name
    prover_semaphore    = aws_dynamodb_table.prover_semaphore.name
  }
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_read_throttle_events" {
  for_each = local.alarmed_dynamodb_tables

  alarm_name          = "${each.value}-read-throttle-events"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ReadThrottleEvents"
  namespace           = "AWS/DynamoDB"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    TableName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_write_throttle_events" {
  for_each = local.alarmed_dynamodb_tables

  alarm_name          = "${each.value}-write-throttle-events"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "WriteThrottleEvents"
  namespace           = "AWS/DynamoDB"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    TableName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "prover_work_dlq_depth" {
  alarm_name          = "${local.name_prefix}-prover-work-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.prover_work_dlq.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "verification_work_dlq_depth" {
  alarm_name          = "${local.name_prefix}-verification-work-dlq-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.verification_work_dlq.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_sfn_executions_failed" {
  alarm_name          = "${local.name_prefix}-target-sfn-executions-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExecutionsFailed"
  namespace           = "AWS/States"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.target_finalization.arn
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_sfn_executions_timed_out" {
  alarm_name          = "${local.name_prefix}-target-sfn-executions-timed-out"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ExecutionsTimedOut"
  namespace           = "AWS/States"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    StateMachineArn = aws_sfn_state_machine.target_finalization.arn
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_lambda_errors_proof_dispatcher" {
  alarm_name          = "${local.name_prefix}-proof-dispatcher-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.target["proof_dispatcher"].function_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_lambda_errors_finalization_writer" {
  alarm_name          = "${local.name_prefix}-finalization-writer-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.target["finalization_writer"].function_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_lambda_errors_semaphore_janitor" {
  alarm_name          = "${local.name_prefix}-semaphore-janitor-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.target["semaphore_janitor"].function_name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "fargate_on_demand_vcpu_usage" {
  alarm_name          = "${local.name_prefix}-fargate-on-demand-vcpu-usage"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ResourceCount"
  namespace           = "AWS/Usage"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.fargate_vcpu_alarm_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    Class    = "Standard/OnDemand"
    Resource = "vCPU"
    Service  = "Fargate"
    Type     = "Resource"
  }

  tags = local.common_tags
}
