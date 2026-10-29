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

  actionable_dlq_queue_names = {
    prover       = aws_sqs_queue.prover_work_dlq.name
    verification = aws_sqs_queue.verification_work_dlq.name
  }

  actionable_work_queue_names = {
    prover       = aws_sqs_queue.prover_work.name
    verification = aws_sqs_queue.verification_work.name
  }

  finalization_transition_log_group_keys = toset([
    "public_api",
    "finalization_writer",
    "proof_dispatcher",
  ])

  invariant_alarm_name           = "${local.name_prefix}-verification-invariant-contradiction"
  invariant_email_parameter_path = "/${local.deployment_target.stateNamespace}/observability/invariant-email"
  invariant_email_parameter_name = "${local.invariant_email_parameter_path}/endpoint"
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

  ops_actionable_email_parameter_path = "/${local.deployment_target.stateNamespace}/observability/ops-actionable-email"
  ops_actionable_email_parameter_name = "${local.ops_actionable_email_parameter_path}/endpoint"
  ops_actionable_email_matching_indexes = [
    for index, parameter_name in data.aws_ssm_parameters_by_path.ops_actionable_email.names : index
    if parameter_name == local.ops_actionable_email_parameter_name
  ]
  ops_actionable_email_parameter_present = (
    length(local.ops_actionable_email_matching_indexes) == 1
    && try(
      data.aws_ssm_parameters_by_path.ops_actionable_email.types[local.ops_actionable_email_matching_indexes[0]] == "SecureString",
      false,
    )
  )
  ops_actionable_email_endpoint = try(
    local.ops_actionable_email_parameter_present
    ? data.aws_ssm_parameters_by_path.ops_actionable_email.values[local.ops_actionable_email_matching_indexes[0]]
    : null,
    null,
  )

  ops_actionable_alarm_routes = {
    prover_dlq = {
      alarm_name  = aws_cloudwatch_metric_alarm.actionable_dlq_depth["prover"].alarm_name
      resource    = aws_sqs_queue.prover_work_dlq.name
      rule_suffix = "action-dlq-prover"
      runbook_id  = "OPS-DLQ-01"
    }
    verification_dlq = {
      alarm_name  = aws_cloudwatch_metric_alarm.actionable_dlq_depth["verification"].alarm_name
      resource    = aws_sqs_queue.verification_work_dlq.name
      rule_suffix = "action-dlq-verification"
      runbook_id  = "OPS-DLQ-01"
    }
    prover_age = {
      alarm_name  = aws_cloudwatch_metric_alarm.actionable_work_queue_age["prover"].alarm_name
      resource    = aws_sqs_queue.prover_work.name
      rule_suffix = "action-age-prover"
      runbook_id  = "OPS-QUEUE-AGE-01"
    }
    verification_age = {
      alarm_name  = aws_cloudwatch_metric_alarm.actionable_work_queue_age["verification"].alarm_name
      resource    = aws_sqs_queue.verification_work.name
      rule_suffix = "action-age-verification"
      runbook_id  = "OPS-QUEUE-AGE-01"
    }
    api_5xx = {
      alarm_name  = aws_cloudwatch_metric_alarm.actionable_api_5xx.alarm_name
      resource    = local.api_name
      rule_suffix = "action-api-5xx"
      runbook_id  = "OPS-API-5XX-01"
    }
  }

  ops_actionable_pipeline_failed_route = {
    rule_suffix = "action-pipeline-failed"
    runbook_id  = "OPS-PIPELINE-FAILED-01"
  }
}

data "aws_ssm_parameters_by_path" "invariant_email" {
  path            = local.invariant_email_parameter_path
  recursive       = false
  with_decryption = true
}

data "aws_ssm_parameters_by_path" "ops_actionable_email" {
  path            = local.ops_actionable_email_parameter_path
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

resource "terraform_data" "ops_actionable_email_parameter_contract" {
  input = {
    parameter_name    = local.ops_actionable_email_parameter_name
    parameter_present = local.ops_actionable_email_parameter_present
  }

  lifecycle {
    precondition {
      condition     = length(data.aws_ssm_parameters_by_path.ops_actionable_email.names) <= 1
      error_message = "The actionable email parameter hierarchy may contain only the fixed endpoint parameter."
    }

    precondition {
      condition = alltrue([
        for parameter_name in data.aws_ssm_parameters_by_path.ops_actionable_email.names :
        parameter_name == local.ops_actionable_email_parameter_name
      ])
      error_message = "The actionable email parameter hierarchy contains an unexpected parameter name."
    }

    precondition {
      condition = alltrue([
        for parameter_type in data.aws_ssm_parameters_by_path.ops_actionable_email.types :
        parameter_type == "SecureString"
      ])
      error_message = "The actionable email endpoint must be stored as an SSM SecureString."
    }

    precondition {
      condition = local.ops_actionable_email_endpoint == null ? true : (
        trimspace(local.ops_actionable_email_endpoint) == local.ops_actionable_email_endpoint
        && length(local.ops_actionable_email_endpoint) <= 254
        && can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", local.ops_actionable_email_endpoint))
      )
      error_message = "The actionable email endpoint must be one trimmed, syntactically valid email address no longer than 254 characters."
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
  alarm_description   = "Passive detector for target REST API 5xx responses. Inspect access logs, the public API Lambda, and the accepted deployment before retrying."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5XXError"
  namespace           = "AWS/ApiGateway"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiName = aws_api_gateway_rest_api.target.name
    Stage   = aws_api_gateway_stage.live.stage_name
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

resource "aws_cloudwatch_metric_alarm" "actionable_dlq_depth" {
  for_each = local.actionable_dlq_queue_names

  alarm_name          = "${local.name_prefix}-actionable-${each.key}-work-dlq-depth"
  alarm_description   = "Actionable sustained visible-message detector for the ${each.key} DLQ. Preserve evidence and diagnose before any redrive or deletion."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "actionable_work_queue_age" {
  for_each = local.actionable_work_queue_names

  alarm_name          = "${local.name_prefix}-actionable-${each.key}-work-oldest-message-age"
  alarm_description   = "Actionable sustained stalled-work detector for the ${each.key} queue. Preserve queue and owner-state evidence before proposing remediation."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 900
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = each.value
  }

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "actionable_api_5xx" {
  alarm_name          = "${local.name_prefix}-actionable-api-gateway-5xx"
  alarm_description   = "Actionable sustained target REST API 5xx detector requiring at least 20 requests, five 5xx responses, and a greater-than-five-percent rate in each evaluated period."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 0.05
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "requests"
    return_data = false

    metric {
      metric_name = "Count"
      namespace   = "AWS/ApiGateway"
      period      = 300
      stat        = "SampleCount"

      dimensions = {
        ApiName = aws_api_gateway_rest_api.target.name
        Stage   = aws_api_gateway_stage.live.stage_name
      }
    }
  }

  metric_query {
    id          = "errors"
    return_data = false

    metric {
      metric_name = "5XXError"
      namespace   = "AWS/ApiGateway"
      period      = 300
      stat        = "Sum"

      dimensions = {
        ApiName = aws_api_gateway_rest_api.target.name
        Stage   = aws_api_gateway_stage.live.stage_name
      }
    }
  }

  metric_query {
    id          = "signal"
    expression  = "IF(requests >= 20, IF(errors >= 5, errors / requests, 0), 0)"
    label       = "sustained API 5xx fraction"
    return_data = true
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

resource "aws_cloudwatch_log_metric_filter" "finalization_admissions" {
  name           = "${local.name_prefix}-finalization-admissions"
  pattern        = "{ $.message.event = \"finalization_admitted\" && $.message.finalization_id = * }"
  log_group_name = aws_cloudwatch_log_group.target_lambdas["public_api"].name

  metric_transformation {
    name      = "FinalizationAdmissions"
    namespace = local.observability_metric_namespace
    value     = "1"
    unit      = "Count"
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

resource "aws_cloudwatch_query_definition" "finalization_completion_cohort" {
  name = "${local.name_prefix}/finalization/completion-cohort"
  log_group_names = [
    aws_cloudwatch_log_group.target_lambdas["public_api"].name,
    aws_cloudwatch_log_group.target_lambdas["finalization_writer"].name,
    aws_cloudwatch_log_group.target_lambdas["proof_dispatcher"].name,
  ]

  query_string = <<-QUERY
    fields @timestamp,
      coalesce(message.event, event) as normalized_event,
      coalesce(message.finalization_id, finalization_id) as normalized_finalization_id,
      coalesce(message.to, to) as normalized_to,
      coalesce(message.reason, reason) as normalized_reason
    | filter normalized_event in ["finalization_admitted", "finalize_state_transition"]
    | fields toMillis(@timestamp) as event_ms,
      if(normalized_event = "finalization_admitted", 1, 0) as admission_marker,
      if(normalized_event = "finalize_state_transition" and normalized_reason != "IDEMPOTENT_RETRY" and normalized_to in ["succeeded", "failed", "timeout"], 1, 0) as terminal_marker
    | fields if(terminal_marker = 1 and normalized_to = "succeeded", 1, 0) as succeeded_marker,
      if(terminal_marker = 1 and normalized_to = "failed" and normalized_reason in ["FINALIZATION_RESULT_INVALID", "USER_CANCELLED", "INVALID_FINALIZATION_ARTIFACT"], 1, 0) as expected_domain_marker
    | stats min(if(admission_marker = 1, event_ms, 9999999999999)) as admitted_at_ms,
      min(if(terminal_marker = 1, event_ms, 9999999999999)) as terminal_at_ms,
      sum(admission_marker) as admission_rows,
      sum(terminal_marker) as terminal_rows,
      sum(succeeded_marker) as succeeded_rows,
      sum(expected_domain_marker) as expected_domain_rows
      by normalized_finalization_id
    | filter admission_rows > 0
    | fields 4500000 as completion_window_ms, 300000 as delayed_event_grace_ms
    | fields admitted_at_ms + completion_window_ms as deadline_at_ms
    | fields if(now() * 1000 < deadline_at_ms + delayed_event_grace_ms, "inside_window", if(terminal_rows = 0 or terminal_at_ms < admitted_at_ms or terminal_at_ms > deadline_at_ms, "stalled", if(terminal_rows = succeeded_rows + expected_domain_rows, "good", "bad"))) as cohort
    | stats count() as admitted,
      sum(if(cohort != "inside_window", 1, 0)) as eligible,
      sum(if(cohort = "good", 1, 0)) as good,
      sum(if(cohort in ["bad", "stalled"], 1, 0)) as bad,
      sum(if(cohort = "stalled", 1, 0)) as stalled,
      sum(if(cohort = "good" and expected_domain_rows > 0, 1, 0)) as expected_domain,
      sum(if(cohort = "inside_window", 1, 0)) as inside_window
    | fields if(eligible > 0, 100 * good / eligible, "") as completion_percentage,
      if(eligible > 0, "measured", "insufficient_evidence") as evidence_status
  QUERY
}

resource "aws_cloudwatch_query_definition" "finalization_terminal_reasons" {
  name = "${local.name_prefix}/finalization/terminal-reasons"
  log_group_names = [
    aws_cloudwatch_log_group.target_lambdas["public_api"].name,
    aws_cloudwatch_log_group.target_lambdas["finalization_writer"].name,
    aws_cloudwatch_log_group.target_lambdas["proof_dispatcher"].name,
  ]

  query_string = <<-QUERY
    fields @timestamp,
      coalesce(message.event, event) as normalized_event,
      coalesce(message.finalization_id, finalization_id) as normalized_finalization_id,
      coalesce(message.to, to) as normalized_to,
      coalesce(message.reason, reason) as normalized_reason
    | filter normalized_event = "finalize_state_transition" and normalized_reason != "IDEMPOTENT_RETRY" and normalized_to in ["failed", "timeout"]
    | fields if(normalized_to = "failed" and normalized_reason in ["FINALIZATION_RESULT_INVALID", "USER_CANCELLED", "INVALID_FINALIZATION_ARTIFACT"], "expected_domain", "platform_failure") as classification
    | stats earliest(@timestamp) as first_seen by normalized_finalization_id, normalized_reason, classification
    | stats count() as terminal_outcomes by normalized_reason, classification
    | sort terminal_outcomes desc
  QUERY
}

resource "aws_sns_topic" "ops_actionable" {
  name         = "${local.name_prefix}-ops-actionable"
  display_name = "STARK ballot actionable"

  tags = local.common_tags
}

data "aws_iam_policy_document" "ops_actionable_notifications" {
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
      "SNS:RemovePermission",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]
    resources = [aws_sns_topic.ops_actionable.arn]
  }

  statement {
    sid    = "AllowExactActionableEventRulesPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.ops_actionable.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = concat(
        [for rule in aws_cloudwatch_event_rule.ops_actionable_alarm : rule.arn],
        [aws_cloudwatch_event_rule.ops_actionable_pipeline_failed.arn],
      )
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
  }
}

resource "aws_sns_topic_policy" "ops_actionable" {
  arn    = aws_sns_topic.ops_actionable.arn
  policy = data.aws_iam_policy_document.ops_actionable_notifications.json
}

resource "aws_sns_topic_subscription" "ops_actionable_email" {
  count     = local.ops_actionable_email_parameter_present ? 1 : 0
  topic_arn = aws_sns_topic.ops_actionable.arn
  protocol  = "email"
  endpoint  = local.ops_actionable_email_endpoint

  depends_on = [terraform_data.ops_actionable_email_parameter_contract]
}

resource "aws_cloudwatch_event_rule" "ops_actionable_alarm" {
  for_each = local.ops_actionable_alarm_routes

  name        = "${local.name_prefix}-${each.value.rule_suffix}"
  description = "Route the exact ${each.key} sustained actionable alarm state to the isolated operational topic."
  event_pattern = jsonencode({
    source        = ["aws.cloudwatch"]
    "detail-type" = ["CloudWatch Alarm State Change"]
    detail = {
      alarmName = [each.value.alarm_name]
      state = {
        value = ["ALARM"]
      }
    }
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "ops_actionable_alarm" {
  for_each = local.ops_actionable_alarm_routes

  rule      = aws_cloudwatch_event_rule.ops_actionable_alarm[each.key].name
  target_id = "ops-actionable"
  arn       = aws_sns_topic.ops_actionable.arn

  input_transformer {
    input_paths = {
      state     = "$.detail.state.value"
      timestamp = "$.time"
    }
    input_template = "{\"dashboard\":\"${aws_cloudwatch_dashboard.observability.dashboard_name}\",\"environment\":\"${var.deployment_environment}\",\"resource\":\"${each.value.resource}\",\"runbook_id\":\"${each.value.runbook_id}\",\"state\":<state>,\"timestamp\":<timestamp>}"
  }

  depends_on = [aws_sns_topic_policy.ops_actionable]
}

resource "aws_cloudwatch_event_rule" "ops_actionable_pipeline_failed" {
  name        = "${local.name_prefix}-${local.ops_actionable_pipeline_failed_route.rule_suffix}"
  description = "Route exact owned-pipeline failed states to the isolated operational topic."
  event_pattern = jsonencode({
    source        = ["aws.codepipeline"]
    "detail-type" = ["CodePipeline Pipeline Execution State Change"]
    detail = {
      pipeline       = local.ops_ledger_pipeline_names
      "execution-id" = [{ exists = true }]
      state          = ["FAILED"]
    }
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "ops_actionable_pipeline_failed" {
  rule      = aws_cloudwatch_event_rule.ops_actionable_pipeline_failed.name
  target_id = "ops-actionable"
  arn       = aws_sns_topic.ops_actionable.arn

  input_transformer {
    input_paths = {
      resource_name         = "$.detail.pipeline"
      pipeline_execution_id = "$.detail.execution-id"
      state                 = "$.detail.state"
      timestamp             = "$.time"
    }
    input_template = "{\"dashboard\":\"${aws_cloudwatch_dashboard.observability.dashboard_name}\",\"environment\":\"${var.deployment_environment}\",\"pipeline\":<resource_name>,\"pipeline_execution_id\":<pipeline_execution_id>,\"runbook_id\":\"${local.ops_actionable_pipeline_failed_route.runbook_id}\",\"state\":<state>,\"timestamp\":<timestamp>}"
  }

  depends_on = [aws_sns_topic_policy.ops_actionable]
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
          title   = "REST API volume, 5xx, and inspect-only p99 latency"
          region  = var.aws_region
          view    = "timeSeries"
          stacked = false
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { label = "Requests", stat = "SampleCount" }],
            ["AWS/ApiGateway", "5XXError", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { label = "5XXError", stat = "Sum" }],
            ["AWS/ApiGateway", "4XXError", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { label = "4xx", stat = "Sum" }],
            ["AWS/ApiGateway", "IntegrationLatency", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { label = "integration latency", stat = "Average" }],
            ["AWS/ApiGateway", "Latency", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { label = "p99 latency", stat = "p99" }],
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
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 5
        properties = {
          title                = "28-day provisional API serving SLI (no traffic = insufficient evidence)"
          region               = var.aws_region
          view                 = "singleValue"
          start                = "-P28D"
          setPeriodToTimeRange = true
          stacked              = false
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { id = "m_total", label = "sample size: total requests", stat = "SampleCount" }],
            ["AWS/ApiGateway", "5XXError", "ApiName", aws_api_gateway_rest_api.target.name, "Stage", aws_api_gateway_stage.live.stage_name, { id = "m_5xx", label = "5xx responses", stat = "Sum", visible = false }],
            [{ expression = "m_total - m_5xx", id = "e_good", label = "good responses" }],
            [{ expression = "IF(m_total > 0, 100 * (m_total - m_5xx) / m_total)", id = "e_success", label = "provisional serving success (%)" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 18
        width  = 12
        height = 5
        properties = {
          title                = "28-day finalization sample counts (cohort query is authoritative)"
          region               = var.aws_region
          view                 = "singleValue"
          start                = "-P28D"
          setPeriodToTimeRange = true
          stacked              = false
          metrics = [
            [local.observability_metric_namespace, "FinalizationAdmissions", { id = "m_admitted", label = "admitted sample size", stat = "Sum" }],
            [{ expression = "SUM(SEARCH('{${local.observability_metric_namespace},ReasonCode} MetricName=\"FinalizationTerminalOutcomes\"', 'Sum', 2419200))", id = "e_terminal_sample", label = "terminal outcome sample size" }],
          ]
        }
      },
    ]
  })
}
