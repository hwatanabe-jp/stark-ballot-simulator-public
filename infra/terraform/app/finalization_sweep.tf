# The writer owns persisted outcomes; AWS Batch owns prover capacity.
# The retained semaphore janitor normalizes operations-ledger events only.
resource "aws_cloudwatch_event_rule" "finalization_sweep" {
  name                = "${local.name_prefix}-finalization-sweep"
  description         = "Reconcile unexpired finalizations independently of API reads."
  schedule_expression = "rate(1 minute)"
  state               = local.application_quiesced ? "DISABLED" : "ENABLED"
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "finalization_sweep" {
  rule  = aws_cloudwatch_event_rule.finalization_sweep.name
  arn   = aws_lambda_function.target["finalization_writer"].arn
  input = jsonencode({ operation = "reconcile-finalizations" })

  retry_policy {
    maximum_event_age_in_seconds = 300
    maximum_retry_attempts       = 2
  }
}

resource "aws_lambda_permission" "finalization_sweep" {
  statement_id  = "AllowFinalizationSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.target["finalization_writer"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.finalization_sweep.arn
}

resource "aws_cloudwatch_metric_alarm" "finalization_sweep_delivery" {
  alarm_name          = "${local.name_prefix}-finalization-sweep-delivery"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedInvocations"
  namespace           = "AWS/Events"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.finalization_sweep.name }
  tags                = local.common_tags
}
