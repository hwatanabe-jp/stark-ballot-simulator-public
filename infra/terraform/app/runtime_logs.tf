resource "aws_cloudwatch_log_group" "target_lambdas" {
  for_each = local.target_lambda_names

  name              = "/aws/lambda/${each.value}"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "target_sfn" {
  name              = "/aws/vendedlogs/states/${local.target_state_machine_name}"
  retention_in_days = 30
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.api_name}/access"
  retention_in_days = 30
  tags              = local.common_tags
}
