locals {
  expected_state_backend_key = local.app_lane_authority.backendKey
  name_prefix                = local.deployment_shared_names.runtimeNamePrefix

  dynamodb_tables = {
    sessions = {
      name     = "${local.name_prefix}-sessions"
      hash_key = "sessionId"
    }
    votes = {
      name      = "${local.name_prefix}-votes"
      hash_key  = "sessionId"
      range_key = "voteIndex"
    }
    rate_limit_events = {
      name      = "${local.name_prefix}-rate-limit-events"
      hash_key  = "scope"
      range_key = "eventKey"
    }
    rate_limit_counters = {
      name     = "${local.name_prefix}-rate-limit-counters"
      hash_key = "key"
    }
  }

  # A maintenance change is reviewed as source and a fresh ordinary saved plan.
  # This closes new sessions and queue/sweeper admission; operators must still
  # block existing-session writes and prove all in-flight writers have drained.
  application_quiesced = false

  active_sessions_table_arn   = aws_dynamodb_table.sessions.arn
  active_votes_table_arn      = aws_dynamodb_table.votes.arn
  active_sessions_table_name  = aws_dynamodb_table.sessions.name
  active_votes_table_name     = aws_dynamodb_table.votes.name
  runtime_sessions_table_arns = [local.active_sessions_table_arn]
  runtime_votes_table_arns    = [local.active_votes_table_arn]

  runtime_reference_names = {
    SESSION_CAPABILITY_SECRET_REF      = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/session-capability-secret"
    VOTE_SECRET_ENCRYPTION_KEY_REF     = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/vote-secret-encryption-key"
    SESSION_CAPABILITY_TTL_SECONDS_REF = "${local.deployment_shared_names.runtimeConfigReferencePrefix}/session-capability-ttl-seconds"
    TURNSTILE_SECRET_KEY_REF           = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/turnstile-secret-key"
    LOG_IP_HASH_SALT_REF               = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/log-ip-hash-salt"
    EXPECTED_ORIGIN_VERIFY_HEADER_REF  = "${local.deployment_shared_names.runtimeSecretReferencePrefix}/expected-origin-verify-header"
    VITE_TURNSTILE_SITE_KEY_REF        = "${local.deployment_shared_names.runtimeConfigReferencePrefix}/vite-turnstile-site-key"
  }

  runtime_secret_reference_paths = [
    local.runtime_reference_names.SESSION_CAPABILITY_SECRET_REF,
    local.runtime_reference_names.VOTE_SECRET_ENCRYPTION_KEY_REF,
    local.runtime_reference_names.TURNSTILE_SECRET_KEY_REF,
    local.runtime_reference_names.EXPECTED_ORIGIN_VERIFY_HEADER_REF,
    local.runtime_reference_names.LOG_IP_HASH_SALT_REF,
  ]
  runtime_config_reference_paths = [
    local.runtime_reference_names.SESSION_CAPABILITY_TTL_SECONDS_REF,
    local.runtime_reference_names.VITE_TURNSTILE_SITE_KEY_REF,
  ]
  runtime_reference_ssm_parameter_arns = [
    for reference in concat(local.runtime_secret_reference_paths, local.runtime_config_reference_paths) :
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${reference}"
  ]
  runtime_reference_secrets_manager_arns = [
    for reference in local.runtime_secret_reference_paths :
    "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${reference}-*"
  ]
  log_ip_hash_salt_secret_arn = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.runtime_reference_names.LOG_IP_HASH_SALT_REF}-*"

  dynamodb_table_names = distinct([
    local.dynamodb_tables.sessions.name,
    local.dynamodb_tables.votes.name,
    local.dynamodb_tables.rate_limit_events.name,
    local.dynamodb_tables.rate_limit_counters.name,
  ])

  target_application_lambda_names = {
    public_api          = local.deployment_shared_names.targetLambdaFunctions.publicApi
    finalization_writer = local.deployment_shared_names.targetLambdaFunctions.finalizationWriter
    proof_dispatcher    = local.deployment_shared_names.targetLambdaFunctions.proofDispatcher
    verification_worker = local.deployment_shared_names.targetLambdaFunctions.verificationWorker
    semaphore_janitor   = local.deployment_shared_names.targetLambdaFunctions.semaphoreJanitor
  }
  target_application_lambda_role_names = {
    public_api          = "${local.name_prefix}-api-role"
    finalization_writer = "${local.name_prefix}-finalizer-role"
    proof_dispatcher    = "${local.name_prefix}-dispatcher-role"
    verification_worker = "${local.name_prefix}-verifier-role"
    semaphore_janitor   = "${local.name_prefix}-janitor-role"
  }
  target_lambda_names = merge(local.target_application_lambda_names, {
    image_signature_verifier = local.image_signature_verifier_name
  })
  target_lambda_role_names = merge(local.target_application_lambda_role_names, {
    image_signature_verifier = local.image_signature_verifier_role_name
  })

  proof_artifact_bucket_name             = local.deployment_shared_names.proofBucket
  frontend_bucket_name                   = local.deployment_shared_names.frontendBucket
  frontend_distribution_comment          = "${local.name_prefix} static frontend"
  proof_artifact_prefix                  = "sessions/"
  prover_work_queue_name                 = "${local.name_prefix}-prover-work"
  prover_work_dlq_name                   = "${local.name_prefix}-prover-work-dlq"
  verification_work_queue_name           = "${local.name_prefix}-verification-work"
  verification_work_dlq_name             = "${local.name_prefix}-verification-work-dlq"
  api_name                               = "${local.name_prefix}-api"
  api_origin_domain_name                 = "${aws_api_gateway_rest_api.target.id}.execute-api.${var.aws_region}.amazonaws.com"
  api_throttle_burst_limit               = 50
  api_throttle_rate_limit                = 25
  target_public_origin                   = trimsuffix(var.verifier_public_base_url, "/")
  turnstile_allowed_hostname             = var.public_hostname
  cloudfront_custom_hostname_enabled     = var.public_hostname_disposition != "generated-cloudfront-hostname"
  cloudfront_aliases                     = local.cloudfront_custom_hostname_enabled ? [var.public_hostname] : []
  target_develop_operator_gate_requested = var.deployment_environment == "develop" && var.develop_operator_gate_enabled
  api_origin_verify_header_name          = "X-Stark-Ballot-Origin-Verify"
  api_origin_verify_header_secret_ref    = local.runtime_reference_names.EXPECTED_ORIGIN_VERIFY_HEADER_REF
  api_origin_verify_header_value         = trimspace(data.aws_secretsmanager_secret_version.api_origin_verify_header[0].secret_string)
  api_origin_verify_header_configured = nonsensitive(
    length(trimspace(data.aws_secretsmanager_secret_version.api_origin_verify_header[0].secret_string)) > 0
  )
  target_develop_operator_gate_enabled = local.operator_gate_keyset_configured && local.api_origin_verify_header_configured
  target_public_session_create_enabled = !local.application_quiesced && (var.deployment_environment == "main" || local.target_develop_operator_gate_enabled)
  session_create_turnstile_required    = !local.target_develop_operator_gate_enabled
  target_state_machine_name            = "${local.name_prefix}-finalization"
  target_state_machine_arn             = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.target_state_machine_name}"
  target_execution_arn                 = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:execution:${local.target_state_machine_name}:*"
  callback_delivery_retry = [
    {
      ErrorEquals     = ["TransientBundleRestoreError", "Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
      IntervalSeconds = 2
      MaxAttempts     = 3
      BackoffRate     = 2
    },
  ]
  callback_delivery_catch = [
    {
      ErrorEquals = ["States.ALL"]
      ResultPath  = "$.callbackError"
      Next        = "CallbackDeliveryFailed"
    },
  ]
}
