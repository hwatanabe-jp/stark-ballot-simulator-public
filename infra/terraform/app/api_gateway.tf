resource "aws_apigatewayv2_api" "target" {
  name          = local.api_name
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers  = ["Content-Type", "X-Session-ID", "X-Session-Capability", "Range"]
    allow_methods  = ["GET", "POST", "OPTIONS"]
    allow_origins  = [local.target_public_origin]
    expose_headers = ["Content-Range", "Accept-Ranges", "X-Stark-Bundle-Range-Chunk-Size"]
    max_age        = 300
  }

  tags = local.common_tags
}

resource "aws_apigatewayv2_integration" "public_api" {
  api_id                 = aws_apigatewayv2_api.target.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.target["public_api"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api_proxy" {
  api_id    = aws_apigatewayv2_api.target.id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.public_api.id}"
}

resource "aws_apigatewayv2_route" "api_root" {
  api_id    = aws_apigatewayv2_api.target.id
  route_key = "ANY /api"
  target    = "integrations/${aws_apigatewayv2_integration.public_api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.target.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      integration    = "$context.integrationStatus"
      error          = "$context.error.message"
    })
  }

  default_route_settings {
    throttling_burst_limit = local.api_throttle_burst_limit
    throttling_rate_limit  = local.api_throttle_rate_limit
  }

  tags = local.common_tags
}

resource "aws_lambda_permission" "api_gateway_hono" {
  statement_id  = "AllowExecutionFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.target["public_api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.target.execution_arn}/*/*"
}
