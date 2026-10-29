resource "aws_sqs_queue" "prover_work_dlq" {
  name                      = local.prover_work_dlq_name
  message_retention_seconds = 1209600

  tags = merge(local.common_tags, {
    DataClass = "async-finalization-work-dead-letter"
  })
}

resource "aws_sqs_queue" "prover_work" {
  name                      = local.prover_work_queue_name
  message_retention_seconds = 345600
  # Keep retry headroom at 6x the consumer timeout, including future timeout changes.
  visibility_timeout_seconds = 6 * local.target_lambda_timeout_seconds.proof_dispatcher
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.prover_work_dlq.arn
    maxReceiveCount     = 3
  })

  tags = merge(local.common_tags, {
    DataClass = "async-finalization-work"
  })
}

resource "aws_sqs_queue" "verification_work_dlq" {
  name                      = local.verification_work_dlq_name
  message_retention_seconds = 1209600

  tags = merge(local.common_tags, {
    DataClass = "async-verification-work-dead-letter"
  })
}

resource "aws_sqs_queue" "verification_work" {
  name                      = local.verification_work_queue_name
  message_retention_seconds = 345600
  # Allow throttled deliveries to retry without making in-flight work visible early.
  visibility_timeout_seconds = 6 * local.target_lambda_timeout_seconds.verification_worker
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.verification_work_dlq.arn
    maxReceiveCount     = 3
  })

  tags = merge(local.common_tags, {
    DataClass = "async-verification-work"
  })
}
