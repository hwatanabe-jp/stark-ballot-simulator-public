# Status is a bounded derivative of the successful checkpoint. The App pipeline
# finishes at Smoke; this independent scheduler never receives Apply authority.
locals {
  app_status_delivery_name     = "${local.app_runtime_name_prefix}-status-delivery"
  app_status_delivery_arn      = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.app_status_delivery_name}"
  app_status_delivery_rule_arn = "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.app_status_delivery_name}"
}

resource "aws_iam_role" "app_status_delivery" {
  count = local.app_pipeline_enabled ? 1 : 0
  name  = local.app_status_delivery_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "states.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnEquals    = { "aws:SourceArn" = local.app_status_delivery_arn }
      }
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy" "app_status_delivery" {
  count = local.app_pipeline_enabled ? 1 : 0
  role  = aws_iam_role.app_status_delivery[0].id
  name  = "observe-and-publish-status"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["codepipeline:GetPipelineExecution"], Resource = local.app_pipeline_arn },
      { Effect = "Allow", Action = ["codebuild:StartBuild", "codebuild:BatchGetBuilds", "codebuild:StopBuild"], Resource = aws_codebuild_project.app_deployment_status_publisher[0].arn },
      { Effect = "Allow", Action = ["events:PutRule", "events:PutTargets", "events:DescribeRule"], Resource = "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/StepFunctionsGetEventForCodeBuildStartBuildRule" },
    ]
  })
}

resource "aws_sfn_state_machine" "app_status_delivery" {
  count    = local.app_pipeline_enabled ? 1 : 0
  name     = local.app_status_delivery_name
  role_arn = aws_iam_role.app_status_delivery[0].arn
  definition = jsonencode({
    StartAt        = "ReadSuccessfulApp"
    TimeoutSeconds = 900
    States = {
      ReadSuccessfulApp = {
        Type       = "Task", Resource = "arn:aws:states:::aws-sdk:codepipeline:getPipelineExecution"
        Parameters = { PipelineName = local.app_pipeline_name, "PipelineExecutionId.$" = "$.executionId" }
        ResultPath = "$.pipeline", Next = "RequireSuccessfulApp"
      }
      RequireSuccessfulApp = {
        Type = "Choice"
        Choices = [{
          And = [
            { Variable = "$.pipeline.PipelineExecution.Status", StringEquals = "Succeeded" },
            { Variable = "$.pipeline.PipelineExecution.ArtifactRevisions[0].Name", StringEquals = "SourceOutput" },
            { Variable = "$.pipeline.PipelineExecution.ArtifactRevisions[1]", IsPresent = false },
          ]
          Next = "PublishCurrentStatus"
        }]
        Default = "RejectUnacceptedExecution"
      }
      RejectUnacceptedExecution = { Type = "Fail", Error = "AppStatusRequiresSuccessfulExecution" }
      PublishCurrentStatus = {
        Type = "Task", Resource = "arn:aws:states:::codebuild:startBuild.sync"
        Parameters = {
          ProjectName       = local.foundation_app_status_publisher_project_name
          "SourceVersion.$" = "$.pipeline.PipelineExecution.ArtifactRevisions[0].RevisionId"
          EnvironmentVariablesOverride = [
            { Name = "APP_PIPELINE_EXECUTION_ID", "Value.$" = "$.executionId", Type = "PLAINTEXT" },
            { Name = "APP_STATUS_SOURCE_SHA", "Value.$" = "$.pipeline.PipelineExecution.ArtifactRevisions[0].RevisionId", Type = "PLAINTEXT" },
          ]
        }
        # Retry only this derived cache publication, never App Apply or Smoke.
        Retry = [{ ErrorEquals = ["States.TaskFailed"], IntervalSeconds = 30, MaxAttempts = 1, BackoffRate = 1 }]
        End   = true
      }
    }
  })
  tags       = local.common_tags
  depends_on = [aws_iam_role_policy.app_status_delivery]
}

resource "aws_iam_role" "app_status_event" {
  count = local.app_pipeline_enabled ? 1 : 0
  name  = "${local.app_status_delivery_name}-event"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "events.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnEquals    = { "aws:SourceArn" = local.app_status_delivery_rule_arn }
      }
    }]
  })
  tags = local.common_tags
}
resource "aws_iam_role_policy" "app_status_event" {
  count = local.app_pipeline_enabled ? 1 : 0
  role  = aws_iam_role.app_status_event[0].id
  name  = "start-status-delivery"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "states:StartExecution", Resource = local.app_status_delivery_arn },
  ] })
}
resource "aws_cloudwatch_event_rule" "app_status_delivery" {
  count = local.app_pipeline_enabled ? 1 : 0
  name  = local.app_status_delivery_name
  event_pattern = jsonencode({
    source        = ["aws.codepipeline"]
    "detail-type" = ["CodePipeline Pipeline Execution State Change"]
    account       = [var.aws_account_id]
    region        = [var.aws_region]
    detail        = { pipeline = [local.app_pipeline_name], state = ["SUCCEEDED"] }
  })
  tags = local.common_tags
}
resource "aws_sqs_queue" "app_status_delivery_failures" {
  count                     = local.app_pipeline_enabled ? 1 : 0
  name                      = "${local.app_status_delivery_name}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = local.common_tags
}
resource "aws_sqs_queue_policy" "app_status_delivery_failures" {
  count     = local.app_pipeline_enabled ? 1 : 0
  queue_url = aws_sqs_queue.app_status_delivery_failures[0].url
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sqs:SendMessage"
    Resource  = aws_sqs_queue.app_status_delivery_failures[0].arn
    Condition = { ArnEquals = { "aws:SourceArn" = local.app_status_delivery_rule_arn } }
  }] })
}
resource "aws_cloudwatch_event_target" "app_status_delivery" {
  count     = local.app_pipeline_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.app_status_delivery[0].name
  target_id = "PublishAppStatus"
  arn       = aws_sfn_state_machine.app_status_delivery[0].arn
  role_arn  = aws_iam_role.app_status_event[0].arn
  input_transformer {
    input_paths    = { execution = "$.detail.execution-id" }
    input_template = "{\"executionId\":<execution>}"
  }
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 6
  }
  dead_letter_config { arn = aws_sqs_queue.app_status_delivery_failures[0].arn }
  depends_on = [aws_iam_role_policy.app_status_event, aws_sqs_queue_policy.app_status_delivery_failures]
}
resource "aws_cloudwatch_metric_alarm" "app_status_delivery_failed" {
  count      = local.app_pipeline_enabled ? 1 : 0
  alarm_name = "${local.app_status_delivery_name}-failed"
  metric_query {
    id          = "failures"
    expression  = "failed + timedout"
    return_data = true
  }
  metric_query {
    id = "failed"
    metric {
      namespace   = "AWS/States"
      metric_name = "ExecutionsFailed"
      dimensions  = { StateMachineArn = local.app_status_delivery_arn }
      stat        = "Sum"
      period      = 300
    }
  }
  metric_query {
    id = "timedout"
    metric {
      namespace   = "AWS/States"
      metric_name = "ExecutionsTimedOut"
      dimensions  = { StateMachineArn = local.app_status_delivery_arn }
      stat        = "Sum"
      period      = 300
    }
  }
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "App checkpoint may be accepted while derived status publication failed. Inspect this state machine and the dedicated status CodeBuild logs; never replay Apply."
  tags                = local.common_tags
}
resource "aws_cloudwatch_metric_alarm" "app_status_delivery_undelivered" {
  count               = local.app_pipeline_enabled ? 1 : 0
  alarm_name          = "${local.app_status_delivery_name}-undelivered"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.app_status_delivery_failures[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "App status scheduling events reached the retained delivery-failure queue. Inspect EventBridge delivery before replaying only status publication."
  tags                = local.common_tags
}
