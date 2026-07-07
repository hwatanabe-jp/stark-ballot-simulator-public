locals {
  image_signature_gate_lambda_name = "${var.project_name}-image-signature-gate-${var.environment}"
}

data "archive_file" "image_signature_gate" {
  type        = "zip"
  source_dir  = "${path.module}/.tmp/image-signature-gate"
  output_path = "${path.module}/.tmp/image-signature-gate.zip"
}

data "aws_iam_policy_document" "image_signature_gate_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "image_signature_gate" {
  name               = "${var.project_name}-image-signature-gate-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.image_signature_gate_assume_role.json

  tags = {
    Name = "${var.project_name}-image-signature-gate-${var.environment}"
  }
}

resource "aws_iam_role_policy" "image_signature_gate" {
  name = "${var.project_name}-image-signature-gate-policy-${var.environment}"
  role = aws_iam_role.image_signature_gate.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:DescribeImageSigningStatus"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = [
          aws_cloudwatch_log_group.image_signature_gate.arn,
          "${aws_cloudwatch_log_group.image_signature_gate.arn}:*"
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "image_signature_gate" {
  name              = "/aws/lambda/${local.image_signature_gate_lambda_name}"
  retention_in_days = local.current_environment_settings.log_retention_days

  tags = {
    Name = "/aws/lambda/${local.image_signature_gate_lambda_name}"
  }
}

resource "aws_lambda_function" "image_signature_gate" {
  function_name    = local.image_signature_gate_lambda_name
  role             = aws_iam_role.image_signature_gate.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.image_signature_gate.output_path
  source_code_hash = data.archive_file.image_signature_gate.output_base64sha256
  timeout          = 10
  memory_size      = 128

  depends_on = [aws_cloudwatch_log_group.image_signature_gate]
}
