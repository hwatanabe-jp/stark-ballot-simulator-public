locals {
  expected_state_backend_key = local.app_lane_authority.backendKey
  name_prefix                = local.deployment_shared_names.runtimeNamePrefix

  common_tags = {
    Project      = var.project_name
    AccountAlias = var.account_alias
    Environment  = var.deployment_environment
    ManagedBy    = "Terraform"
    StateScope   = var.state_scope
  }

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
    prover_semaphore = {
      name     = "${local.name_prefix}-prover-semaphore"
      hash_key = "LockName"
    }
  }

  dynamodb_recovery_quiesced = contains([
    "primary_quiesced",
    "replacement_quiesced",
  ], var.dynamodb_recovery_phase)
  dynamodb_recovery_serves_replacement = contains([
    "replacement_quiesced",
    "replacement_active",
  ], var.dynamodb_recovery_phase)

  recovery_sessions_table_arn  = var.dynamodb_recovery_activation == null ? aws_dynamodb_table.sessions.arn : var.dynamodb_recovery_activation.sessions.table_arn
  recovery_votes_table_arn     = var.dynamodb_recovery_activation == null ? aws_dynamodb_table.votes.arn : var.dynamodb_recovery_activation.votes.table_arn
  recovery_sessions_table_name = var.dynamodb_recovery_activation == null ? local.dynamodb_tables.sessions.name : var.dynamodb_recovery_activation.sessions.table_name
  recovery_votes_table_name    = var.dynamodb_recovery_activation == null ? local.dynamodb_tables.votes.name : var.dynamodb_recovery_activation.votes.table_name

  active_sessions_table_arn  = local.dynamodb_recovery_serves_replacement ? local.recovery_sessions_table_arn : aws_dynamodb_table.sessions.arn
  active_votes_table_arn     = local.dynamodb_recovery_serves_replacement ? local.recovery_votes_table_arn : aws_dynamodb_table.votes.arn
  active_sessions_table_name = local.dynamodb_recovery_serves_replacement ? local.recovery_sessions_table_name : local.dynamodb_tables.sessions.name
  active_votes_table_name    = local.dynamodb_recovery_serves_replacement ? local.recovery_votes_table_name : local.dynamodb_tables.votes.name

  runtime_sessions_table_arns = distinct([
    aws_dynamodb_table.sessions.arn,
    local.recovery_sessions_table_arn,
  ])
  runtime_votes_table_arns = distinct([
    aws_dynamodb_table.votes.arn,
    local.recovery_votes_table_arn,
  ])

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
    local.recovery_sessions_table_name,
    local.recovery_votes_table_name,
    local.dynamodb_tables.rate_limit_events.name,
    local.dynamodb_tables.rate_limit_counters.name,
    local.dynamodb_tables.prover_semaphore.name,
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
  image_signature_name_prefix        = local.deployment_shared_names.signatureRuntimeNamePrefix
  image_signature_verifier_name      = local.deployment_shared_names.targetLambdaFunctions.imageSignatureVerifier
  image_signature_verifier_role_name = "${local.image_signature_name_prefix}-image-signature-verifier-role"
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
  api_origin_domain_name                 = replace(aws_apigatewayv2_api.target.api_endpoint, "https://", "")
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
  target_public_session_create_enabled = !local.dynamodb_recovery_quiesced && local.target_develop_operator_gate_enabled
  session_create_turnstile_required    = !local.target_develop_operator_gate_enabled
  target_state_machine_name            = "${local.name_prefix}-finalization"
  target_state_machine_arn             = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.target_state_machine_name}"
  target_execution_arn                 = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:execution:${local.target_state_machine_name}:*"
  prover_semaphore_table_name          = local.dynamodb_tables.prover_semaphore.name
  prover_semaphore_lock_name           = "prover-fargate"
  prover_semaphore_stale_seconds       = var.prover_task_timeout_seconds + 900
  prover_image_uri_pattern             = "^${var.aws_account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com\\/[A-Za-z0-9._\\/-]+@sha256:[0-9a-f]{64}$"
  prover_image_repo_uri                = split("@", var.prover_image_uri)[0]
  prover_image_repo_parts              = split("/", local.prover_image_repo_uri)
  prover_image_repository              = join("/", slice(local.prover_image_repo_parts, 1, length(local.prover_image_repo_parts)))
  prover_image_digest                  = split("@", var.prover_image_uri)[1]
  prover_image_repository_arn          = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${local.prover_image_repository}"
  image_signature_signing_profile_name = local.deployment_shared_names.signerProfile
  image_signature_signing_profile_arn  = "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-profiles/${local.image_signature_signing_profile_name}"
  image_signature_signing_job_arn_pattern = (
    "arn:aws:signer:${var.aws_region}:${var.aws_account_id}:/signing-jobs/*"
  )
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
