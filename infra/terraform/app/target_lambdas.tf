locals {
  target_lambda_timeout_seconds = {
    public_api          = 30
    finalization_writer = 120
    proof_dispatcher    = 30
    verification_worker = 60
    semaphore_janitor   = 30
  }

  target_lambda_common_environment = {
    AWS_ACCOUNT_ID                      = var.aws_account_id
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    APP_SOURCE_SHA                      = var.app_source_sha
    DEPLOYMENT_ID                       = var.deployment_id
    DEPLOY_MODE                         = var.deploy_mode
    DYNAMODB_SESSIONS_TABLE             = local.active_sessions_table_arn
    DYNAMODB_VOTES_TABLE                = local.active_votes_table_arn
    EXPECTED_IMAGE_ID                   = var.expected_image_id
    EXPECTED_ORIGIN_VERIFY_HEADER_REF   = local.runtime_reference_names.EXPECTED_ORIGIN_VERIFY_HEADER_REF
    HONO_CORS_ALLOW_ORIGINS             = local.target_public_origin
    LOG_FORMAT                          = "json"
    LOG_IP_HASH_SALT_REF                = local.runtime_reference_names.LOG_IP_HASH_SALT_REF
    NODE_ENV                            = "production"
    PROVER_STATE_MACHINE_ARN            = local.target_state_machine_arn
    PROVER_WORK_QUEUE_URL               = aws_sqs_queue.prover_work.url
    RATE_LIMIT_COUNTERS_TABLE           = aws_dynamodb_table.rate_limit_counters.arn
    RATE_LIMIT_EVENTS_TABLE             = aws_dynamodb_table.rate_limit_events.arn
    RUNTIME_DEPLOYMENT_ENV              = var.deployment_environment
    RUNTIME_PROFILE                     = "target-aws-async"
    S3_PROOF_BUCKET                     = aws_s3_bucket.proof_artifacts.bucket
    S3_PROOF_PREFIX                     = local.proof_artifact_prefix
    SESSION_CAPABILITY_SECRET_REF       = local.runtime_reference_names.SESSION_CAPABILITY_SECRET_REF
    SESSION_CAPABILITY_TTL_SECONDS_REF  = local.runtime_reference_names.SESSION_CAPABILITY_TTL_SECONDS_REF
    SESSION_LIVE_TTL_SECONDS            = tostring(var.session_live_ttl_seconds)
    TRUSTED_PROXY                       = "api-gateway"
    TURNSTILE_ALLOWED_HOSTNAMES         = local.turnstile_allowed_hostname
    TURNSTILE_SECRET_KEY_REF            = local.runtime_reference_names.TURNSTILE_SECRET_KEY_REF
    VERIFICATION_ARTIFACT_TTL_SECONDS   = tostring(var.verification_artifact_ttl_seconds)
    VERIFICATION_WORK_QUEUE_URL         = aws_sqs_queue.verification_work.url
    VERIFIER_PUBLIC_BASE_URL            = var.verifier_public_base_url
    VERIFIER_SERVICE_BIN                = var.verifier_service_bin_path
    VERIFICATION_WORKER_FUNCTION_NAME   = local.target_application_lambda_names.verification_worker
    VITE_STH_MIN_MATCHES                = "1"
    VITE_STH_SOURCES                    = "/api/sessions/:sessionId/bulletin/sth"
    VOTE_DUPLICATE_DETECTOR_TTL_SECONDS = tostring(var.vote_duplicate_detector_ttl_seconds)
    VOTE_SECRET_ENCRYPTION_KEY_REF      = local.runtime_reference_names.VOTE_SECRET_ENCRYPTION_KEY_REF
  }
}

resource "aws_lambda_function" "target" {
  for_each = local.target_application_lambda_names

  function_name     = each.value
  role              = aws_iam_role.target_lambda[each.key].arn
  runtime           = var.lambda_runtime
  handler           = "index.handler"
  s3_bucket         = var.lambda_artifacts[each.key].s3_bucket
  s3_key            = var.lambda_artifacts[each.key].s3_key
  s3_object_version = var.lambda_artifacts[each.key].s3_object_version
  source_code_hash  = var.lambda_artifacts[each.key].source_code_hash
  timeout           = local.target_lambda_timeout_seconds[each.key]
  memory_size       = each.key == "verification_worker" ? 1024 : 512

  logging_config {
    log_format            = "JSON"
    application_log_level = "DEBUG"
    system_log_level      = "INFO"
  }

  environment {
    variables = merge(
      local.target_lambda_common_environment,
      each.key == "public_api" ? {
        RUNTIME_PROFILE = local.application_quiesced ? "target-aws-async-quiesced" : "target-aws-async"
        TRUSTED_PROXY   = local.cloudflare_origin_required ? "cloudflare" : "api-gateway"
      } : {},
      each.key == "semaphore_janitor" ? {
        OPS_LEDGER_LOG_GROUP_NAME     = aws_cloudwatch_log_group.ops_ledger.name
        OPS_LEDGER_PIPELINE_BASE_NAME = local.ops_ledger_pipeline_names[0]
        OPS_LEDGER_RESOURCE_PREFIX    = local.name_prefix
      } : {},
    )
  }

  depends_on = [
    # Do not trust Cloudflare's client-IP header until all viewer behaviors
    # enforce the source-pinned origin token and their deployment has completed.
    aws_cloudfront_distribution.frontend,
    aws_cloudwatch_log_group.target_lambdas,
    aws_iam_role_policy.target_lambda_finalization_writer,
    aws_iam_role_policy.target_lambda_proof_dispatcher,
    aws_iam_role_policy.target_lambda_public_api,
    aws_iam_role_policy.target_lambda_semaphore_janitor,
    aws_iam_role_policy.target_lambda_verification_worker,
    aws_kms_key.app_data,
  ]

  tags = local.common_tags
}

resource "aws_lambda_event_source_mapping" "prover_work" {
  event_source_arn        = aws_sqs_queue.prover_work.arn
  function_name           = aws_lambda_function.target["proof_dispatcher"].arn
  batch_size              = 1
  enabled                 = !local.application_quiesced
  function_response_types = ["ReportBatchItemFailures"]

  depends_on = [
    aws_iam_role_policy.target_lambda_proof_dispatcher,
    aws_sfn_state_machine.target_finalization,
  ]
}

resource "aws_lambda_event_source_mapping" "verification_work" {
  event_source_arn        = aws_sqs_queue.verification_work.arn
  function_name           = aws_lambda_function.target["verification_worker"].arn
  batch_size              = 1
  enabled                 = !local.application_quiesced
  function_response_types = ["ReportBatchItemFailures"]

  depends_on = [aws_iam_role_policy.target_lambda_verification_worker]
}
