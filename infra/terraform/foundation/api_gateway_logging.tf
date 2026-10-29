locals {
  gateway_logging_role_name = "${local.name_prefix}-gateway-logs"
  gateway_welcome_log_arn   = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/apigateway/welcome"
  gateway_access_log_arn    = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/apigateway/${local.name_prefix}-api/access"
}

data "aws_iam_policy_document" "gateway_logging" {
  # UpdateAccount validates its assumed role by creating/writing this exact
  # service-owned welcome group, even when execution logging remains disabled.
  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
    resources = [local.gateway_welcome_log_arn, "${local.gateway_welcome_log_arn}:*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
    resources = [local.gateway_access_log_arn, "${local.gateway_access_log_arn}:*"]
  }
}

resource "aws_iam_policy" "gateway_logging_boundary" {
  name   = "${local.gateway_logging_role_name}-boundary"
  policy = data.aws_iam_policy_document.gateway_logging.json
  tags   = local.common_tags

  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role" "gateway_logging" {
  name                 = local.gateway_logging_role_name
  permissions_boundary = aws_iam_policy.gateway_logging_boundary.arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "apigateway.amazonaws.com" }
    }]
  })
  tags = local.common_tags

  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy" "gateway_logging" {
  name   = "access-log-writer"
  role   = aws_iam_role.gateway_logging.id
  policy = data.aws_iam_policy_document.gateway_logging.json
}

# This account/region singleton belongs only to Foundation. Plan and Apply
# reject a pre-existing different owner before Terraform can change it.
resource "aws_api_gateway_account" "logging" {
  cloudwatch_role_arn = aws_iam_role.gateway_logging.arn
  depends_on          = [aws_iam_role_policy.gateway_logging]

  lifecycle { prevent_destroy = true }
}
