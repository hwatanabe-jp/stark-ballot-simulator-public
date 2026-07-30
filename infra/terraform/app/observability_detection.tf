locals {
  observability_metric_namespace = "${var.project_name}/${var.deployment_environment}/Observability"

  additional_lambda_error_alarm_functions = {
    public_api               = local.target_lambda_names.public_api
    verification_worker      = local.target_lambda_names.verification_worker
    image_signature_verifier = local.target_lambda_names.image_signature_verifier
  }

  monitored_work_queue_names = {
    prover       = aws_sqs_queue.prover_work.name
    verification = aws_sqs_queue.verification_work.name
  }

  finalization_transition_log_group_keys = toset([
    "public_api",
    "finalization_writer",
    "proof_dispatcher",
  ])

  invariant_alarm_name           = "${local.name_prefix}-verification-invariant-contradiction"
  invariant_email_parameter_path = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/observability/invariant-email"
  invariant_email_parameter_name = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/observability/invariant-email/endpoint"
  invariant_email_matching_indexes = [
    for index, parameter_name in data.aws_ssm_parameters_by_path.invariant_email.names : index
    if parameter_name == local.invariant_email_parameter_name
  ]
  invariant_email_parameter_present = (
    length(local.invariant_email_matching_indexes) == 1
    && try(
      data.aws_ssm_parameters_by_path.invariant_email.types[local.invariant_email_matching_indexes[0]] == "SecureString",
      false,
    )
  )
  invariant_alarm_email_endpoint = try(
    local.invariant_email_parameter_present
    ? data.aws_ssm_parameters_by_path.invariant_email.values[local.invariant_email_matching_indexes[0]]
    : null,
    null,
  )
}

data "aws_ssm_parameters_by_path" "invariant_email" {
  path            = local.invariant_email_parameter_path
  recursive       = false
  with_decryption = true
}

resource "terraform_data" "invariant_email_parameter_contract" {
  input = {
    parameter_name    = local.invariant_email_parameter_name
    parameter_present = local.invariant_email_parameter_present
  }

  lifecycle {
    precondition {
      condition     = length(data.aws_ssm_parameters_by_path.invariant_email.names) <= 1
      error_message = "The invariant email parameter hierarchy may contain only the fixed endpoint parameter."
    }

    precondition {
      condition = alltrue([
        for parameter_name in data.aws_ssm_parameters_by_path.invariant_email.names :
        parameter_name == local.invariant_email_parameter_name
      ])
      error_message = "The invariant email parameter hierarchy contains an unexpected parameter name."
    }

    precondition {
      condition = alltrue([
        for parameter_type in data.aws_ssm_parameters_by_path.invariant_email.types :
        parameter_type == "SecureString"
      ])
      error_message = "The invariant email endpoint must be stored as an SSM SecureString."
    }

    precondition {
      condition = local.invariant_alarm_email_endpoint == null ? true : (
        trimspace(local.invariant_alarm_email_endpoint) == local.invariant_alarm_email_endpoint
        && length(local.invariant_alarm_email_endpoint) <= 254
        && can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", local.invariant_alarm_email_endpoint))
      )
      error_message = "The invariant email endpoint must be one trimmed, syntactically valid email address no longer than 254 characters."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "target_lambda_errors_additional" {
  for_each = local.additional_lambda_error_alarm_functions

  alarm_name          = "${local.name_prefix}-${replace(each.key, "_", "-")}-errors"
  alarm_description   = "Passive detector for errors in the ${each.key} Lambda. Inspect the named handler and correlated runtime evidence; no automatic remediation."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_lambda_throttles" {
  for_each = local.target_lambda_names

  alarm_name          = "${local.name_prefix}-${replace(each.key, "_", "-")}-throttles"
  alarm_description   = "Passive detector for pre-handler throttles in the ${each.key} Lambda. Correlate with invocation volume and concurrency before proposing a change."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "target_api_gateway_5xx" {
  alarm_name          = "${local.name_prefix}-api-gateway-5xx"
  alarm_description   = "Passive detector for target HTTP API 5xx responses. Inspect access logs, the public API Lambda, and the accepted deployment before retrying."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xx"
  namespace           = "AWS/ApiGateway"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = aws_apigatewayv2_api.target.id
    Stage = aws_apigatewayv2_stage.default.name
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "work_queue_oldest_message_age" {
  for_each = local.monitored_work_queue_names

  alarm_name          = "${local.name_prefix}-${each.key}-work-oldest-message-age"
  alarm_description   = "Passive stalled-work detector for the ${each.key} queue. Inspect queue, consumer, DLQ, and owner state before redrive or deletion."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 300
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_log_metric_filter" "dispatch_dropped" {
  name           = "${local.name_prefix}-dispatch-dropped"
  pattern        = "{ $.message.event = \"dispatch_dropped\" && $.message.reason = * }"
  log_group_name = aws_cloudwatch_log_group.target_lambdas["proof_dispatcher"].name

  metric_transformation {
    name      = "DispatcherDrops"
    namespace = local.observability_metric_namespace
    value     = "1"
    unit      = "Count"

    dimensions = {
      Reason = "$.message.reason"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "finalization_terminal_outcomes" {
  for_each = local.finalization_transition_log_group_keys

  name           = "${local.name_prefix}-finalization-terminal-outcomes"
  pattern        = "{ $.message.event = \"finalize_state_transition\" && $.message.reason = * && $.message.reason != \"IDEMPOTENT_RETRY\" && ($.message.to = \"succeeded\" || $.message.to = \"failed\" || $.message.to = \"timeout\") }"
  log_group_name = aws_cloudwatch_log_group.target_lambdas[each.key].name

  metric_transformation {
    name      = "FinalizationTerminalOutcomes"
    namespace = local.observability_metric_namespace
    value     = "1"
    unit      = "Count"

    dimensions = {
      ReasonCode = "$.message.reason"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "verification_failure_categories" {
  name           = "${local.name_prefix}-verification-failure-categories"
  pattern        = "{ $.message.event = \"verification_run_summary\" && $.message.failure_category = * }"
  log_group_name = aws_cloudwatch_log_group.target_lambdas["public_api"].name

  metric_transformation {
    name      = "VerificationRunsByFailureCategory"
    namespace = local.observability_metric_namespace
    value     = "1"
    unit      = "Count"

    dimensions = {
      FailureCategory = "$.message.failure_category"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "verification_invariant_contradiction" {
  name           = "${local.name_prefix}-verification-invariant-contradiction"
  pattern        = "{ $.message.event = \"verification_run_summary\" && $.message.outcome = \"fully_verified\" && $.message.failed_required_count > 0 }"
  log_group_name = aws_cloudwatch_log_group.target_lambdas["public_api"].name

  metric_transformation {
    name          = "VerificationInvariantContradictions"
    namespace     = local.observability_metric_namespace
    value         = "1"
    default_value = 0
    unit          = "Count"
  }
}

resource "aws_sns_topic" "verification_invariant_alerts" {
  name         = "${local.name_prefix}-verification-invariant-alerts"
  display_name = "STARK ballot invariant"

  tags = local.common_tags
}

data "aws_iam_policy_document" "verification_invariant_notifications" {
  statement {
    sid    = "AllowAccountTopicAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions = [
      "SNS:AddPermission",
      "SNS:DeleteTopic",
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:Receive",
      "SNS:RemovePermission",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]
    resources = [aws_sns_topic.verification_invariant_alerts.arn]
  }

  statement {
    sid    = "AllowInvariantAlarmPublishOnly"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.verification_invariant_alerts.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${local.invariant_alarm_name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
  }
}

resource "aws_sns_topic_policy" "verification_invariant_alerts" {
  arn    = aws_sns_topic.verification_invariant_alerts.arn
  policy = data.aws_iam_policy_document.verification_invariant_notifications.json
}

resource "aws_sns_topic_subscription" "verification_invariant_email" {
  count     = local.invariant_email_parameter_present ? 1 : 0
  topic_arn = aws_sns_topic.verification_invariant_alerts.arn
  protocol  = "email"
  endpoint  = local.invariant_alarm_email_endpoint

  depends_on = [terraform_data.invariant_email_parameter_contract]
}

resource "aws_cloudwatch_metric_alarm" "verification_invariant_contradiction" {
  alarm_name          = local.invariant_alarm_name
  alarm_description   = "A fully verified summary reported failed required checks: likely verdict-pipeline code bug, not proof of tampering. Escalate and preserve evidence; telemetry does not alter the verdict."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "VerificationInvariantContradictions"
  namespace           = local.observability_metric_namespace
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.verification_invariant_alerts.arn]

  depends_on = [aws_sns_topic_policy.verification_invariant_alerts]

  tags = local.common_tags
}

resource "aws_cloudwatch_dashboard" "observability" {
  dashboard_name = "${local.name_prefix}-observability"

  dashboard_body = jsonencode({
    start          = "-PT24H"
    periodOverride = "inherit"
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 2
        properties = {
          markdown = "# ${var.account_alias}/${var.deployment_environment} observability\nEntry point only: use the bounded query pack and runbook for conclusions. Flat demo-traffic graphs do not prove health."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 2
        width  = 12
        height = 6
        properties = {
          title   = "HTTP API volume, 5xx, and inspect-only p99 latency"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.target.id, "Stage", aws_apigatewayv2_stage.default.name, { label = "Requests", stat = "Sum" }],
            ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.target.id, "Stage", aws_apigatewayv2_stage.default.name, { label = "5xx", stat = "Sum" }],
            ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.target.id, "Stage", aws_apigatewayv2_stage.default.name, { label = "p99 latency", stat = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 2
        width  = 12
        height = 6
        properties = {
          title   = "Lambda errors and throttles"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          metrics = concat(
            [for key, function_name in local.target_lambda_names : ["AWS/Lambda", "Errors", "FunctionName", function_name, { label = "${key} errors", stat = "Sum" }]],
            [for key, function_name in local.target_lambda_names : ["AWS/Lambda", "Throttles", "FunctionName", function_name, { label = "${key} throttles", stat = "Sum" }]],
          )
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 8
        width  = 12
        height = 6
        properties = {
          title   = "Work queue age and DLQ depth"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          metrics = [
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.prover_work.name, { label = "prover oldest age", stat = "Maximum" }],
            ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", aws_sqs_queue.verification_work.name, { label = "verification oldest age", stat = "Maximum" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.prover_work_dlq.name, { label = "prover DLQ", stat = "Maximum" }],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.verification_work_dlq.name, { label = "verification DLQ", stat = "Maximum" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 8
        width  = 12
        height = 6
        properties = {
          title   = "Closed logical signals"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          metrics = [
            [{ expression = "SEARCH('{${local.observability_metric_namespace},Reason} MetricName=\"DispatcherDrops\"', 'Sum', 300)", id = "dispatch", label = "dispatcher drops by reason" }],
            [{ expression = "SEARCH('{${local.observability_metric_namespace},ReasonCode} MetricName=\"FinalizationTerminalOutcomes\"', 'Sum', 300)", id = "terminal", label = "terminal outcomes by code" }],
            [{ expression = "SEARCH('{${local.observability_metric_namespace},FailureCategory} MetricName=\"VerificationRunsByFailureCategory\"', 'Sum', 300)", id = "verify", label = "verification by infrastructure category" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 14
        width  = 24
        height = 4
        properties = {
          title   = "Verification invariant contradictions (expected zero)"
          region  = var.aws_region
          view    = "singleValue"
          stacked = false
          metrics = [
            [local.observability_metric_namespace, "VerificationInvariantContradictions", { stat = "Sum" }],
          ]
        }
      },
    ]
  })
}
