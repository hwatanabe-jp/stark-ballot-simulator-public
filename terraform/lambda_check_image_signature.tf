locals {
  check_image_signature_lambda_name = "${var.project_name}-check-image-signature-${var.environment}"
}

data "archive_file" "check_image_signature" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/check-image-signature"
  output_path = "${path.module}/.tmp/check-image-signature.zip"
}

data "aws_iam_policy_document" "check_image_signature_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "check_image_signature" {
  name               = "${var.project_name}-check-image-signature-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.check_image_signature_assume_role.json

  tags = {
    Name = "${var.project_name}-check-image-signature-${var.environment}"
  }
}

resource "aws_iam_role_policy" "check_image_signature" {
  name = "${var.project_name}-check-image-signature-policy-${var.environment}"
  role = aws_iam_role.check_image_signature.id

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
          aws_cloudwatch_log_group.check_image_signature.arn,
          "${aws_cloudwatch_log_group.check_image_signature.arn}:*"
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "check_image_signature" {
  name              = "/aws/lambda/${local.check_image_signature_lambda_name}"
  retention_in_days = local.current_environment_settings.log_retention_days

  tags = {
    Name = "/aws/lambda/${local.check_image_signature_lambda_name}"
  }
}

resource "aws_lambda_function" "check_image_signature" {
  function_name    = local.check_image_signature_lambda_name
  role             = aws_iam_role.check_image_signature.arn
  runtime          = "nodejs24.x"
  handler          = "index.handler"
  filename         = data.archive_file.check_image_signature.output_path
  source_code_hash = data.archive_file.check_image_signature.output_base64sha256
  timeout          = 10
  memory_size      = 128

  depends_on = [aws_cloudwatch_log_group.check_image_signature]
}
