data "aws_iam_policy" "image_signature_verifier_permissions_boundary" {
  arn = var.image_signature_verifier_permissions_boundary_arn
}

locals {
  image_signature_verifier_prover_image_uri = coalesce(
    var.image_signature_verifier_base_prover_image_uri,
    var.image_signature_preflight_prover_image_uri,
    var.prover_image_uri,
  )
  image_signature_verifier_prover_repo_uri = split(
    "@",
    local.image_signature_verifier_prover_image_uri,
  )[0]
  image_signature_verifier_prover_repo_parts = split(
    "/",
    local.image_signature_verifier_prover_repo_uri,
  )
  image_signature_verifier_prover_repository = join(
    "/",
    slice(
      local.image_signature_verifier_prover_repo_parts,
      1,
      length(local.image_signature_verifier_prover_repo_parts),
    ),
  )
  image_signature_verifier_prover_digest = split(
    "@",
    local.image_signature_verifier_prover_image_uri,
  )[1]
  image_signature_verifier_preflight_image_valid = (
    can(regex(local.prover_image_uri_pattern, local.image_signature_verifier_prover_image_uri))
    && local.image_signature_verifier_prover_repository == local.prover_image_repository
  )
  image_signature_verifier_timeout_budget_valid = (
    var.image_signature_verifier_handler_deadline_ms < var.image_signature_verifier_lambda_timeout_seconds * 1000
    && var.image_signature_verifier_lambda_timeout_seconds < var.image_signature_verifier_step_timeout_seconds
    && (
      var.image_signature_verifier_process_timeout_ms
      + (var.image_signature_status_max_attempts * var.image_signature_status_attempt_timeout_ms)
      + ((var.image_signature_status_max_attempts - 1) * var.image_signature_status_retry_delay_ms)
      + 5000
    ) <= var.image_signature_verifier_handler_deadline_ms
  )
  image_signature_verifier_authority_selection_valid = (
    local.image_signature_verifier_initialization
    ? (
      local.image_signature_verifier_standalone
      && local.deployment_target.environmentTier == "production"
      && local.deployment_target_inputs_exact
      && var.deploy_mode == "normal"
      && var.image_signature_preflight_prover_image_uri == var.prover_image_uri
      && var.image_signature_verifier_base_prover_image_uri == null
      && var.image_signature_verifier_selected_authority == null
      && var.image_signature_verifier_reconciled_function_version == null
      && var.image_signature_verifier_reconciliation_desired_json == null
      && var.image_signature_verifier_reconciliation_desired_sha256 == null
    )
    : (
      var.image_signature_preflight_prover_image_uri != null
      ? (
        var.image_signature_verifier_base_prover_image_uri == null
        && var.image_signature_verifier_selected_authority == null
        && var.image_signature_verifier_reconciled_function_version != null
        && var.image_signature_verifier_reconciliation_desired_json != null
        && var.image_signature_verifier_reconciliation_desired_sha256 != null
      )
      : (
        var.deploy_mode == "rollback"
        ? (
          var.image_signature_verifier_base_prover_image_uri != null
          && var.image_signature_verifier_selected_authority != null
          && var.image_signature_verifier_reconciled_function_version == null
          && var.image_signature_verifier_reconciliation_desired_json == null
          && var.image_signature_verifier_reconciliation_desired_sha256 == null
        )
        : (
          var.image_signature_verifier_base_prover_image_uri == null
          && var.image_signature_verifier_selected_authority == null
          && var.image_signature_verifier_reconciled_function_version != null
          && var.image_signature_verifier_reconciliation_desired_json != null
          && var.image_signature_verifier_reconciliation_desired_sha256 != null
        )
      )
    )
  )
  image_signature_verifier_execution_role_assume_policy_sha256 = sha256(
    jsonencode(jsondecode(data.aws_iam_policy_document.target_lambda_assume_role.json))
  )
  image_signature_verifier_execution_role_policy_sha256 = sha256(
    jsonencode(jsondecode(data.aws_iam_policy_document.image_signature_verifier.json))
  )
  image_signature_verifier_permissions_boundary_policy_sha256 = sha256(
    jsonencode(jsondecode(data.aws_iam_policy.image_signature_verifier_permissions_boundary.policy))
  )
  image_signature_verifier_rollback_role_authority_valid = (
    var.image_signature_verifier_selected_authority == null
    ? true
    : (
      var.image_signature_verifier_selected_authority.function_arn
      == "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.image_signature_verifier_name}"
      && var.image_signature_verifier_selected_authority.execution_role_arn
      == "arn:aws:iam::${var.aws_account_id}:role/${local.image_signature_verifier_role_name}"
      && var.image_signature_verifier_selected_authority.execution_role_assume_policy_sha256
      == local.image_signature_verifier_execution_role_assume_policy_sha256
      && var.image_signature_verifier_selected_authority.execution_role_policy_sha256
      == local.image_signature_verifier_execution_role_policy_sha256
      && var.image_signature_verifier_selected_authority.execution_role_permissions_boundary_arn
      == data.aws_iam_policy.image_signature_verifier_permissions_boundary.arn
      && var.image_signature_verifier_selected_authority.execution_role_permissions_boundary_policy_sha256
      == local.image_signature_verifier_permissions_boundary_policy_sha256
    )
  )

  image_signature_verifier_environment = {
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_ASSET_MANIFEST_SHA256 = var.lambda_artifacts["image_signature_verifier"].asset_manifest_sha256
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_IMAGE_DIGEST          = local.image_signature_verifier_prover_digest
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGION                = var.aws_region
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_REGISTRY_ID           = var.aws_account_id
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_REPOSITORY_NAME       = local.image_signature_verifier_prover_repository
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_SIGNING_PROFILE_ARN   = local.image_signature_signing_profile_arn
    IMAGE_SIGNATURE_VERIFIER_EXPECTED_TRUST_ROOT_SHA256     = var.lambda_artifacts["image_signature_verifier"].trust_root_sha256
    IMAGE_SIGNATURE_VERIFIER_HANDLER_DEADLINE_MS            = tostring(var.image_signature_verifier_handler_deadline_ms)
    IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPT_TIMEOUT_MS      = tostring(var.image_signature_status_attempt_timeout_ms)
    IMAGE_SIGNATURE_VERIFIER_STATUS_ATTEMPTS                = tostring(var.image_signature_status_max_attempts)
    IMAGE_SIGNATURE_VERIFIER_STATUS_RETRY_DELAY_MS          = tostring(var.image_signature_status_retry_delay_ms)
    IMAGE_SIGNATURE_VERIFIER_TIMEOUT_MS                     = tostring(var.image_signature_verifier_process_timeout_ms)
    NODE_ENV                                                = "production"
  }

  # Keep default/empty fields explicit so runtime deployment evidence cannot
  # hide an out-of-band change behind an omitted AWS response member.
  image_signature_verifier_configuration_authority = {
    architectures          = ["x86_64"]
    dead_letter_target_arn = null
    environment            = local.image_signature_verifier_environment
    ephemeral_storage_mb   = 1024
    handler                = "index.handler"
    kms_key_arn            = null
    layers                 = []
    logging_config = {
      application_log_level = "INFO"
      log_format            = "JSON"
      log_group             = aws_cloudwatch_log_group.image_signature_verifier.name
      system_log_level      = "INFO"
    }
    memory_size_mb  = 1024
    package_type    = "Zip"
    role_arn        = aws_iam_role.image_signature_verifier.arn
    runtime         = var.lambda_runtime
    timeout_seconds = var.image_signature_verifier_lambda_timeout_seconds
    tracing_mode    = "PassThrough"
    vpc_config = {
      ipv6_allowed_for_dual_stack = false
      security_group_ids          = []
      subnet_ids                  = []
      vpc_id                      = null
    }
  }
  image_signature_verifier_current_authority = {
    function_arn       = aws_lambda_function.image_signature_verifier.arn
    function_version   = local.image_signature_verifier_alias_function_version
    architecture       = one(aws_lambda_function.image_signature_verifier.architectures)
    runtime            = aws_lambda_function.image_signature_verifier.runtime
    timeout_seconds    = aws_lambda_function.image_signature_verifier.timeout
    environment_sha256 = sha256(jsonencode(local.image_signature_verifier_environment))
    function_configuration_sha256 = sha256(
      jsonencode(local.image_signature_verifier_configuration_authority)
    )
    execution_role_arn                                = aws_iam_role.image_signature_verifier.arn
    execution_role_assume_policy_sha256               = local.image_signature_verifier_execution_role_assume_policy_sha256
    execution_role_policy_sha256                      = local.image_signature_verifier_execution_role_policy_sha256
    execution_role_permissions_boundary_arn           = data.aws_iam_policy.image_signature_verifier_permissions_boundary.arn
    execution_role_permissions_boundary_policy_sha256 = local.image_signature_verifier_permissions_boundary_policy_sha256
    preflight_alias_arn                               = aws_lambda_alias.image_signature_verifier_preflight.arn
    runtime_alias_arn                                 = "${aws_lambda_function.image_signature_verifier.arn}:runtime"
    package                                           = var.lambda_artifacts["image_signature_verifier"]
  }
  image_signature_verifier_deployment_authority = (
    var.image_signature_verifier_selected_authority == null
    ? local.image_signature_verifier_current_authority
    : var.image_signature_verifier_selected_authority
  )

}

resource "terraform_data" "image_signature_verifier_permissions_boundary_authority" {
  input = {
    arn           = data.aws_iam_policy.image_signature_verifier_permissions_boundary.arn
    policy_sha256 = local.image_signature_verifier_permissions_boundary_policy_sha256
  }
}

resource "terraform_data" "image_signature_verifier_reconciliation_authority" {
  input = local.image_signature_verifier_initialization ? null : {
    desired_json              = var.image_signature_verifier_reconciliation_desired_json
    desired_sha256            = var.image_signature_verifier_reconciliation_desired_sha256
    expected_function_version = var.image_signature_verifier_reconciled_function_version
  }

  lifecycle {
    precondition {
      condition = (
        var.image_signature_verifier_reconciliation_desired_json == null
        ? var.image_signature_verifier_reconciliation_desired_sha256 == null
        : sha256(var.image_signature_verifier_reconciliation_desired_json) == var.image_signature_verifier_reconciliation_desired_sha256
      )
      error_message = "The verifier reconciliation authority hash must bind the exact reviewed desired JSON."
    }
  }
}

resource "aws_lambda_function" "image_signature_verifier" {
  function_name     = local.image_signature_verifier_name
  role              = aws_iam_role.image_signature_verifier.arn
  runtime           = var.lambda_runtime
  architectures     = ["x86_64"]
  handler           = "index.handler"
  s3_bucket         = var.lambda_artifacts["image_signature_verifier"].s3_bucket
  s3_key            = var.lambda_artifacts["image_signature_verifier"].s3_key
  s3_object_version = var.lambda_artifacts["image_signature_verifier"].s3_object_version
  source_code_hash  = var.lambda_artifacts["image_signature_verifier"].source_code_hash
  timeout           = var.image_signature_verifier_lambda_timeout_seconds
  memory_size       = 1024
  publish           = local.image_signature_verifier_initialization

  ephemeral_storage {
    size = 1024
  }

  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
    system_log_level      = "INFO"
  }

  environment {
    variables = local.image_signature_verifier_environment
  }

  lifecycle {
    # Isolated reconciliation owns mutable verifier code and configuration;
    # the full App plan retains their exact desired authority in state and only selects qualified aliases.
    ignore_changes = [
      architectures,
      dead_letter_config,
      environment,
      ephemeral_storage,
      handler,
      kms_key_arn,
      layers,
      logging_config,
      memory_size,
      publish,
      role,
      runtime,
      s3_bucket,
      s3_key,
      s3_object_version,
      source_code_hash,
      timeout,
      tracing_config,
      vpc_config,
    ]

    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "AWS caller account must match aws_account_id before mutating the verifier."
    }

    precondition {
      condition     = data.aws_region.current.region == var.aws_region
      error_message = "AWS provider region must match aws_region before mutating the verifier."
    }

    precondition {
      condition     = local.image_signature_verifier_authority_selection_valid
      error_message = "Isolated preflight must not select rollback authority; full rollback requires both the current base verifier binding and exact selected authority; normal deployment must not override the base binding."
    }

    precondition {
      condition = (
        data.aws_iam_policy.image_signature_verifier_permissions_boundary.arn
        == var.image_signature_verifier_permissions_boundary_arn
        && local.image_signature_verifier_rollback_role_authority_valid
      )
      error_message = "The verifier execution role and live bootstrap-managed permissions boundary must match the exact retained rollback authority."
    }

    precondition {
      condition     = local.image_signature_verifier_preflight_image_valid
      error_message = "The verifier preflight image must remain in the exact account, region, and Prover repository selected by the App runtime."
    }

    precondition {
      condition     = local.image_signature_verifier_timeout_budget_valid
      error_message = "The verifier process, signing-status retry, cleanup, handler, Step Functions, and Lambda timeout budgets must remain strictly bounded."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.image_signature_verifier,
    aws_iam_role_policy.image_signature_verifier,
  ]

  tags = local.common_tags
}

resource "aws_lambda_alias" "image_signature_verifier_preflight" {
  name             = "preflight"
  description      = "Qualified non-accepting cryptographic verifier preflight"
  function_name    = local.image_signature_verifier_name
  function_version = local.image_signature_verifier_alias_function_version

  depends_on = [terraform_data.image_signature_verifier_reconciliation_authority]
}

resource "aws_lambda_alias" "image_signature_verifier_runtime" {
  name             = "runtime"
  description      = "Qualified runtime cryptographic verifier gate"
  function_name    = aws_lambda_function.image_signature_verifier.function_name
  function_version = local.image_signature_verifier_alias_function_version
}
