locals {
  expected_state_backend_key = "${var.project_name}/${var.account_alias}/${var.deployment_environment}/${var.state_scope}/terraform.tfstate"
  name_prefix                = "${var.project_name}-${var.account_alias}-${var.deployment_environment}"

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

  runtime_reference_names = {
    SESSION_CAPABILITY_SECRET_REF      = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/session-capability-secret"
    VOTE_SECRET_ENCRYPTION_KEY_REF     = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/vote-secret-encryption-key"
    SESSION_CAPABILITY_TTL_SECONDS_REF = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/config/session-capability-ttl-seconds"
    TURNSTILE_SECRET_KEY_REF           = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/turnstile-secret-key"
    LOG_IP_HASH_SALT_REF               = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/log-ip-hash-salt"
    EXPECTED_ORIGIN_VERIFY_HEADER_REF  = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/expected-origin-verify-header"
    VITE_TURNSTILE_SITE_KEY_REF        = "/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/config/vite-turnstile-site-key"
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

  dynamodb_table_names = [
    local.dynamodb_tables.sessions.name,
    local.dynamodb_tables.votes.name,
    local.dynamodb_tables.rate_limit_events.name,
    local.dynamodb_tables.rate_limit_counters.name,
    local.dynamodb_tables.prover_semaphore.name,
  ]

  target_lambda_names = {
    public_api           = "${local.name_prefix}-public-api"
    finalization_writer  = "${local.name_prefix}-finalization-writer"
    proof_dispatcher     = "${local.name_prefix}-proof-dispatcher"
    verification_worker  = "${local.name_prefix}-verification-worker"
    image_signature_gate = "${local.name_prefix}-image-signature-gate"
    semaphore_janitor    = "${local.name_prefix}-semaphore-janitor"
  }
  target_lambda_role_names = {
    public_api           = "${local.name_prefix}-api-role"
    finalization_writer  = "${local.name_prefix}-finalizer-role"
    proof_dispatcher     = "${local.name_prefix}-dispatcher-role"
    verification_worker  = "${local.name_prefix}-verifier-role"
    image_signature_gate = "${local.name_prefix}-image-gate-role"
    semaphore_janitor    = "${local.name_prefix}-janitor-role"
  }

  proof_artifact_bucket_name             = "${local.name_prefix}-proof-artifacts"
  frontend_bucket_name                   = "${local.name_prefix}-static-frontend"
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
  operator_gate_public_key_configured    = local.target_develop_operator_gate_requested && var.develop_operator_gate_public_key_pem != null && trimspace(var.develop_operator_gate_public_key_pem) != ""
  operator_gate_trusted_key_groups       = local.operator_gate_public_key_configured ? [aws_cloudfront_key_group.develop_operator_gate[0].id] : []
  api_origin_verify_header_name          = "X-Stark-Ballot-Origin-Verify"
  api_origin_verify_header_secret_ref    = local.runtime_reference_names.EXPECTED_ORIGIN_VERIFY_HEADER_REF
  api_origin_verify_header_configured    = true
  api_origin_verify_header_value         = local.api_origin_verify_header_configured ? trimspace(data.aws_secretsmanager_secret_version.api_origin_verify_header[0].secret_string) : ""
  target_develop_operator_gate_enabled   = local.operator_gate_public_key_configured && local.api_origin_verify_header_configured
  target_public_session_create_enabled   = local.target_develop_operator_gate_enabled
  session_create_turnstile_required      = !local.target_develop_operator_gate_enabled
  target_state_machine_name              = "${local.name_prefix}-finalization"
  target_state_machine_arn               = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.target_state_machine_name}"
  target_execution_arn                   = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:execution:${local.target_state_machine_name}:*"
  prover_semaphore_table_name            = local.dynamodb_tables.prover_semaphore.name
  prover_semaphore_lock_name             = "prover-fargate"
  prover_semaphore_stale_seconds         = var.prover_task_timeout_seconds + 900
  prover_image_uri_pattern               = "^${var.aws_account_id}\\.dkr\\.ecr\\.${var.aws_region}\\.amazonaws\\.com\\/[A-Za-z0-9._\\/-]+@sha256:[0-9a-f]{64}$"
  prover_image_repo_uri                  = split("@", var.prover_image_uri)[0]
  prover_image_repo_parts                = split("/", local.prover_image_repo_uri)
  prover_image_repository                = join("/", slice(local.prover_image_repo_parts, 1, length(local.prover_image_repo_parts)))
  prover_image_digest                    = split("@", var.prover_image_uri)[1]
  callback_delivery_retry = [
    {
      ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
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
