resource "aws_apigatewayv2_api" "target" {
  name          = local.api_name
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers  = ["Content-Type", "If-None-Match", "X-Session-Capability", "Range"]
    allow_methods  = ["GET", "POST", "OPTIONS"]
    allow_origins  = [local.target_public_origin]
    expose_headers = ["Content-Range", "Accept-Ranges", "ETag", "X-Amz-Version-Id", "X-Stark-Bundle-Range-Chunk-Size", "x-request-id"]
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

resource "aws_apigatewayv2_route" "canonical" {
  for_each = toset([
    "GET /api/sessions/{sessionId}/bulletin",
    "GET /api/sessions/{sessionId}/bulletin/consistency-proof",
    "GET /api/sessions/{sessionId}/bulletin/sth",
    "GET /api/sessions/{sessionId}/finalizations/current/bitmap-proofs/{kind}/{voteIndex}",
    "GET /api/sessions/{sessionId}/finalizations/current/input-commitment",
    "GET /api/sessions/{sessionId}/finalizations/current",
    "GET /api/sessions/{sessionId}/finalizations/{finalizationId}/artifacts/bundle",
    "GET /api/sessions/{sessionId}/finalizations/{finalizationId}/artifacts/report",
    "GET /api/sessions/{sessionId}/finalizations/{finalizationId}/verification",
    "GET /api/sessions/{sessionId}/progress",
    "GET /api/sessions/{sessionId}/votes/{voteId}/inclusion-proof",
    "POST /api/sessions",
    "POST /api/sessions/{sessionId}/finalizations",
    "POST /api/sessions/{sessionId}/finalizations/{finalizationId}/cancel",
    "POST /api/sessions/{sessionId}/finalizations/{finalizationId}/verification",
    "POST /api/sessions/{sessionId}/finalizations/{finalizationId}/verification/observations",
    "POST /api/sessions/{sessionId}/votes",
  ])

  api_id    = aws_apigatewayv2_api.target.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.public_api.id}"
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
      requestId        = "$context.requestId"
      requestTime      = "$context.requestTime"
      method           = "$context.httpMethod"
      pathTemplate     = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      responseLatency  = "$context.responseLatency"
      integration      = "$context.integrationStatus"
      integrationError = "$context.integrationErrorMessage"
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
