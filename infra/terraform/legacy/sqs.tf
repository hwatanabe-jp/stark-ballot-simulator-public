resource "aws_sqs_queue" "prover_dlq" {
  name                      = "${var.project_name}-prover-dlq-${var.environment}"
  message_retention_seconds = 1209600

  tags = {
    Name = "${var.project_name}-prover-dlq-${var.environment}"
  }
}

resource "aws_sqs_queue" "prover_work" {
  name                       = "${var.project_name}-prover-work-${var.environment}"
  visibility_timeout_seconds = 1000
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.prover_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    Name = "${var.project_name}-prover-work-${var.environment}"
  }
}
