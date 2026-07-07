resource "aws_sqs_queue" "prover_work_dlq" {
  name                      = local.prover_work_dlq_name
  message_retention_seconds = 1209600

  tags = merge(local.common_tags, {
    DataClass = "async-finalization-work-dead-letter"
  })
}

resource "aws_sqs_queue" "prover_work" {
  name                      = local.prover_work_queue_name
  message_retention_seconds = 1209600
  # Keep at 6x the proof dispatcher Lambda timeout; raising the dispatcher timeout requires raising this too.
  visibility_timeout_seconds = 180
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
  name                       = local.verification_work_queue_name
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 180
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.verification_work_dlq.arn
    maxReceiveCount     = 3
  })

  tags = merge(local.common_tags, {
    DataClass = "async-verification-work"
  })
}
