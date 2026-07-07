resource "aws_cloudwatch_event_rule" "semaphore_janitor_execution_status" {
  name        = "${local.name_prefix}-semaphore-janitor-execution"
  description = "Release target prover semaphore slots when Step Functions executions close."

  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [aws_sfn_state_machine.target_finalization.arn]
      status          = ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]
    }
  })

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "semaphore_janitor_execution_status" {
  rule = aws_cloudwatch_event_rule.semaphore_janitor_execution_status.name
  arn  = aws_lambda_function.target["semaphore_janitor"].arn
}

resource "aws_lambda_permission" "semaphore_janitor_execution_status" {
  statement_id  = "AllowSemaphoreJanitorExecutionStatus"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.target["semaphore_janitor"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.semaphore_janitor_execution_status.arn
}

resource "aws_cloudwatch_event_rule" "semaphore_janitor_sweep" {
  name                = "${local.name_prefix}-semaphore-janitor-sweep"
  description         = "Sweep stale target prover semaphore slots."
  schedule_expression = "rate(30 minutes)"

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "semaphore_janitor_sweep" {
  rule = aws_cloudwatch_event_rule.semaphore_janitor_sweep.name
  arn  = aws_lambda_function.target["semaphore_janitor"].arn
}

resource "aws_lambda_permission" "semaphore_janitor_sweep" {
  statement_id  = "AllowSemaphoreJanitorSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.target["semaphore_janitor"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.semaphore_janitor_sweep.arn
}
