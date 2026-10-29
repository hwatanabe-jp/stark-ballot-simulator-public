locals {
  gateway_stage_name = "live"
  gateway_contract   = jsondecode(file("${path.module}/gateway-contract.json"))
  gateway_resource_ids = merge(
    { for path, resource in aws_api_gateway_resource.depth_1 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_2 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_3 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_4 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_5 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_6 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_7 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_8 : path => resource.id },
    { for path, resource in aws_api_gateway_resource.depth_9 : path => resource.id },
  )
}

resource "aws_api_gateway_rest_api" "target" {
  name = local.api_name
  endpoint_configuration { types = ["REGIONAL"] }
  # JSON requests must remain text for body validation. Streaming responses
  # carry ZIP bytes without a binary-media wildcard or Accept-order conversion.
  binary_media_types = []
  tags               = local.common_tags
}

resource "aws_api_gateway_resource" "depth_1" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 1 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_rest_api.target.root_resource_id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_2" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 2 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_1[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_3" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 3 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_2[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_4" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 4 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_3[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_5" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 5 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_4[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_6" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 6 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_5[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_7" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 7 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_6[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_8" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 8 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_7[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_resource" "depth_9" {
  for_each    = { for path, resource in local.gateway_contract.resources : path => resource if resource.depth == 9 }
  rest_api_id = aws_api_gateway_rest_api.target.id
  parent_id   = aws_api_gateway_resource.depth_8[each.value.parent].id
  path_part   = each.value.part
}

resource "aws_api_gateway_model" "request" {
  for_each     = local.gateway_contract.models
  rest_api_id  = aws_api_gateway_rest_api.target.id
  name         = each.key
  content_type = "application/json"
  schema       = jsonencode(each.value)
}

resource "aws_api_gateway_request_validator" "body" {
  rest_api_id                 = aws_api_gateway_rest_api.target.id
  name                        = "Body"
  validate_request_body       = true
  validate_request_parameters = false
}

resource "aws_api_gateway_method" "route" {
  for_each             = local.gateway_contract.methods
  rest_api_id          = aws_api_gateway_rest_api.target.id
  resource_id          = local.gateway_resource_ids[each.value.path]
  http_method          = each.value.method
  authorization        = "NONE"
  request_parameters   = { "method.request.header.X-HTTP-Method-Override" = false }
  request_validator_id = each.value.model == null ? null : aws_api_gateway_request_validator.body.id
  request_models = each.value.model == null ? {} : {
    "application/json" = aws_api_gateway_model.request[each.value.model].name
    "$default"         = aws_api_gateway_model.request[each.value.model].name
  }
}

resource "aws_api_gateway_integration" "public_api" {
  for_each                = aws_api_gateway_method.route
  rest_api_id             = aws_api_gateway_rest_api.target.id
  resource_id             = each.value.resource_id
  http_method             = each.value.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  request_parameters      = { "integration.request.header.X-HTTP-Method-Override" = "method.request.header.X-HTTP-Method-Override" }
  response_transfer_mode  = "STREAM"
  uri                     = "arn:aws:apigateway:${var.aws_region}:lambda:path/2021-11-15/functions/${aws_lambda_function.target["public_api"].arn}/response-streaming-invocations"
}

locals {
  gateway_errors = {
    BAD_REQUEST_BODY       = { code = "INVALID_REQUEST", message = "Invalid request body", status = "400" }
    BAD_REQUEST_PARAMETERS = { code = "INVALID_REQUEST", message = "Invalid request parameters", status = "400" }
    THROTTLED              = { code = "RATE_LIMITED", message = "Too many requests", status = "429" }
    QUOTA_EXCEEDED         = { code = "RATE_LIMITED", message = "Too many requests", status = "429" }
    INTEGRATION_FAILURE    = { code = "INTERNAL_ERROR", message = "Internal server error", status = "504" }
    INTEGRATION_TIMEOUT    = { code = "INTERNAL_ERROR", message = "Internal server error", status = "504" }
    DEFAULT_4XX            = { code = "INVALID_REQUEST", message = "Request rejected", status = null }
    DEFAULT_5XX            = { code = "INTERNAL_ERROR", message = "Internal server error", status = null }
  }
}

resource "aws_api_gateway_gateway_response" "error" {
  for_each      = local.gateway_errors
  rest_api_id   = aws_api_gateway_rest_api.target.id
  response_type = each.key
  status_code   = each.value.status
  response_templates = {
    "application/json" = jsonencode({
      error = { code = each.value.code, message = each.value.message }
      meta  = { requestId = "$context.extendedRequestId" }
    })
  }
  # Body validation is attached only to the five public POST methods. Other
  # Gateway failures may cover private paths and must not gain public CORS.
  response_parameters = merge({
    "gatewayresponse.header.Content-Type" = "'application/json'"
    "gatewayresponse.header.x-request-id" = "context.extendedRequestId"
    }, each.key == "BAD_REQUEST_BODY" ? {
    "gatewayresponse.header.Access-Control-Allow-Origin"   = "'${local.target_public_origin}'"
    "gatewayresponse.header.Access-Control-Expose-Headers" = "'x-request-id'"
  } : {})
}

resource "aws_api_gateway_deployment" "target" {
  rest_api_id = aws_api_gateway_rest_api.target.id
  triggers = {
    configuration = sha256(jsonencode({
      contract        = local.gateway_contract
      gateway         = filesha256("${path.module}/api_gateway.tf")
      integration_uri = aws_lambda_function.target["public_api"].invoke_arn
      errors          = aws_api_gateway_gateway_response.error
    }))
  }
  depends_on = [aws_api_gateway_integration.public_api, aws_api_gateway_model.request, aws_api_gateway_request_validator.body]
  lifecycle { create_before_destroy = true }
}

resource "aws_api_gateway_stage" "live" {
  rest_api_id           = aws_api_gateway_rest_api.target.id
  deployment_id         = aws_api_gateway_deployment.target.id
  stage_name            = local.gateway_stage_name
  cache_cluster_enabled = false

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId       = "$context.extendedRequestId"
      requestTime     = "$context.requestTime"
      method          = "$context.httpMethod"
      pathTemplate    = "$context.resourcePath"
      status          = "$context.status"
      protocol        = "$context.protocol"
      responseLength  = "$context.responseLength"
      responseLatency = "$context.responseLatency"
      integration     = "$context.integration.status"
      responseType    = "$context.error.responseType"
    })
  }
  tags = local.common_tags
}

resource "aws_api_gateway_method_settings" "default" {
  rest_api_id = aws_api_gateway_rest_api.target.id
  stage_name  = aws_api_gateway_stage.live.stage_name
  method_path = "*/*"
  settings {
    throttling_burst_limit = local.api_throttle_burst_limit
    throttling_rate_limit  = local.api_throttle_rate_limit
    metrics_enabled        = false
    logging_level          = "OFF"
    data_trace_enabled     = false
    caching_enabled        = false
  }
}

resource "aws_api_gateway_method_settings" "validated" {
  for_each    = { for key, route in local.gateway_contract.methods : key => route if route.model != null && !strcontains(route.path, "/current/") }
  rest_api_id = aws_api_gateway_rest_api.target.id
  stage_name  = aws_api_gateway_stage.live.stage_name
  method_path = "${trimprefix(each.value.path, "/")}/${each.value.method}"
  settings {
    throttling_burst_limit = local.api_throttle_burst_limit
    throttling_rate_limit  = local.api_throttle_rate_limit
    metrics_enabled        = true
    logging_level          = "OFF"
    data_trace_enabled     = false
    caching_enabled        = false
  }
}

resource "aws_lambda_permission" "api_gateway_hono" {
  statement_id  = "AllowExecutionFromApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.target["public_api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.target.execution_arn}/live/*/api*"
}
