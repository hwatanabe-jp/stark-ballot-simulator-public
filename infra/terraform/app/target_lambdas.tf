locals {
  target_lambda_common_environment = {
    AWS_ACCOUNT_ID                       = var.aws_account_id
    AWS_NODEJS_CONNECTION_REUSE_ENABLED  = "1"
    APP_SOURCE_SHA                       = var.app_source_sha
    DEPLOYMENT_ID                        = var.deployment_id
    DEPLOY_MODE                          = var.deploy_mode
    DYNAMODB_SESSIONS_TABLE              = local.active_sessions_table_arn
    DYNAMODB_VOTES_TABLE                 = local.active_votes_table_arn
    EXPECTED_IMAGE_ID                    = var.expected_image_id
    EXPECTED_ORIGIN_VERIFY_HEADER_REF    = local.runtime_reference_names.EXPECTED_ORIGIN_VERIFY_HEADER_REF
    FINALIZE_ASYNC_MODE                  = "true"
    HONO_CORS_ALLOW_ORIGINS              = local.target_public_origin
    LOG_FORMAT                           = "json"
    LOG_IP_HASH_SALT_REF                 = local.runtime_reference_names.LOG_IP_HASH_SALT_REF
    PROVER_STATE_MACHINE_ARN             = local.target_state_machine_arn
    PROVER_SEMAPHORE_LOCK_NAME           = local.prover_semaphore_lock_name
    PROVER_SEMAPHORE_STALE_SECONDS       = tostring(local.prover_semaphore_stale_seconds)
    PROVER_SEMAPHORE_TABLE_NAME          = aws_dynamodb_table.prover_semaphore.name
    PROVER_MAX_CONCURRENT_PROVERS        = tostring(var.prover_max_concurrent_provers)
    PROVER_STEP_FUNCTIONS_ENABLED        = "true"
    PROVER_WORK_QUEUE_URL                = aws_sqs_queue.prover_work.url
    RATE_LIMIT_COUNTERS_TABLE            = aws_dynamodb_table.rate_limit_counters.arn
    RATE_LIMIT_EVENTS_TABLE              = aws_dynamodb_table.rate_limit_events.arn
    RATE_LIMIT_STORE                     = "dynamo"
    RUNTIME_DEPLOYMENT_ENV               = var.deployment_environment
    S3_PROOF_BUCKET                      = aws_s3_bucket.proof_artifacts.bucket
    S3_PROOF_PREFIX                      = local.proof_artifact_prefix
    SESSION_CAPABILITY_SECRET_REF        = local.runtime_reference_names.SESSION_CAPABILITY_SECRET_REF
    SESSION_CAPABILITY_TTL_SECONDS_REF   = local.runtime_reference_names.SESSION_CAPABILITY_TTL_SECONDS_REF
    SESSION_CREATE_TURNSTILE_REQUIRED    = tostring(local.session_create_turnstile_required)
    SESSION_LIVE_TTL_SECONDS             = tostring(var.session_live_ttl_seconds)
    TARGET_AWS_RUNTIME                   = "1"
    TARGET_DEVELOP_OPERATOR_GATE_ENABLED = tostring(local.target_develop_operator_gate_enabled)
    TARGET_PUBLIC_SESSION_CREATE_ENABLED = tostring(local.target_public_session_create_enabled)
    TRUSTED_PROXY                        = "api-gateway"
    TURNSTILE_ALLOWED_HOSTNAMES          = local.turnstile_allowed_hostname
    TURNSTILE_SECRET_KEY_REF             = local.runtime_reference_names.TURNSTILE_SECRET_KEY_REF
    USE_S3                               = "true"
    USE_MOCK_STORE                       = "false"
    VERIFICATION_ARTIFACT_TTL_SECONDS    = tostring(var.verification_artifact_ttl_seconds)
    VERIFICATION_WORK_QUEUE_URL          = aws_sqs_queue.verification_work.url
    VERIFIER_PUBLIC_BASE_URL             = var.verifier_public_base_url
    VERIFIER_SERVICE_BIN                 = var.verifier_service_bin_path
    VERIFICATION_WORKER_FUNCTION_NAME    = local.target_application_lambda_names.verification_worker
    VITE_STH_MIN_MATCHES                 = "1"
    VITE_STH_SOURCES                     = "/api/sth"
    VOTE_DUPLICATE_DETECTOR_TTL_SECONDS  = tostring(var.vote_duplicate_detector_ttl_seconds)
    VOTE_SECRET_ENCRYPTION_KEY_REF       = local.runtime_reference_names.VOTE_SECRET_ENCRYPTION_KEY_REF
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
  timeout           = each.key == "verification_worker" ? 60 : 30
  memory_size       = each.key == "verification_worker" ? 1024 : 512

  logging_config {
    log_format            = "JSON"
    application_log_level = "DEBUG"
    system_log_level      = "INFO"
  }

  environment {
    variables = merge(local.target_lambda_common_environment, each.key == "semaphore_janitor" ? {
      OPS_LEDGER_LOG_GROUP_NAME     = aws_cloudwatch_log_group.ops_ledger.name
      OPS_LEDGER_PIPELINE_BASE_NAME = local.ops_ledger_pipeline_names[0]
      OPS_LEDGER_RESOURCE_PREFIX    = local.name_prefix
    } : {})
  }

  depends_on = [
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
  enabled                 = !local.dynamodb_recovery_quiesced
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
  enabled                 = !local.dynamodb_recovery_quiesced
  function_response_types = ["ReportBatchItemFailures"]

  depends_on = [aws_iam_role_policy.target_lambda_verification_worker]
}
