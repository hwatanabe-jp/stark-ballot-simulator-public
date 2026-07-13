resource "aws_ssm_parameter" "runtime_config_names" {
  for_each = merge({
    DYNAMODB_SESSIONS_TABLE             = local.active_sessions_table_arn
    DYNAMODB_VOTES_TABLE                = local.active_votes_table_arn
    RATE_LIMIT_EVENTS_TABLE             = aws_dynamodb_table.rate_limit_events.arn
    RATE_LIMIT_COUNTERS_TABLE           = aws_dynamodb_table.rate_limit_counters.arn
    APP_DATA_KMS_KEY_ARN                = aws_kms_key.app_data.arn
    TARGET_LAMBDA_ROLE_ARNS             = jsonencode({ for key, role in aws_iam_role.target_lambda : key => role.arn })
    RATE_LIMIT_STORE                    = "dynamo"
    SESSION_LIVE_TTL_SECONDS            = tostring(var.session_live_ttl_seconds)
    VERIFICATION_ARTIFACT_TTL_SECONDS   = tostring(var.verification_artifact_ttl_seconds)
    VOTE_DUPLICATE_DETECTOR_TTL_SECONDS = tostring(var.vote_duplicate_detector_ttl_seconds)
    AWS_ACCOUNT_ID                      = var.aws_account_id
    AWS_REGION                          = var.aws_region
  }, local.runtime_reference_names)

  name  = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/${each.key}"
  type  = "String"
  value = each.value

  tags = merge(local.common_tags, {
    ConfigClass = "runtime-non-secret"
  })
}
