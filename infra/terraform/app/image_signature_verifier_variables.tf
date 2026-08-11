variable "image_signature_verifier_lambda_timeout_seconds" {
  description = "Hard timeout for the dedicated cryptographic image-signature verifier Lambda."
  type        = number
  default     = 120

  validation {
    condition = (
      floor(var.image_signature_verifier_lambda_timeout_seconds) == var.image_signature_verifier_lambda_timeout_seconds
      && var.image_signature_verifier_lambda_timeout_seconds >= 30
      && var.image_signature_verifier_lambda_timeout_seconds <= 900
    )
    error_message = "image_signature_verifier_lambda_timeout_seconds must be an integer from 30 through 900."
  }
}

variable "image_signature_verifier_step_timeout_seconds" {
  description = "Bounded Step Functions timeout for one cryptographic image-signature verifier invocation."
  type        = number
  default     = 130

  validation {
    condition = (
      floor(var.image_signature_verifier_step_timeout_seconds) == var.image_signature_verifier_step_timeout_seconds
      && var.image_signature_verifier_step_timeout_seconds >= 20
    )
    error_message = "image_signature_verifier_step_timeout_seconds must be an integer of at least 20."
  }
}

variable "image_signature_verifier_handler_deadline_ms" {
  description = "Soft handler deadline that bounds readiness polling, the verifier process, cleanup, and serialization."
  type        = number
  default     = 100000

  validation {
    condition = (
      floor(var.image_signature_verifier_handler_deadline_ms) == var.image_signature_verifier_handler_deadline_ms
      && var.image_signature_verifier_handler_deadline_ms >= 10000
      && var.image_signature_verifier_handler_deadline_ms <= 120000
    )
    error_message = "image_signature_verifier_handler_deadline_ms must be an integer from 10000 through 120000."
  }
}

variable "image_signature_verifier_process_timeout_ms" {
  description = "Timeout for the fixed Notation subprocess within one verifier invocation."
  type        = number
  default     = 60000

  validation {
    condition = (
      floor(var.image_signature_verifier_process_timeout_ms) == var.image_signature_verifier_process_timeout_ms
      && var.image_signature_verifier_process_timeout_ms >= 1000
      && var.image_signature_verifier_process_timeout_ms <= 60000
    )
    error_message = "image_signature_verifier_process_timeout_ms must be an integer from 1000 through 60000."
  }
}

variable "image_signature_status_max_attempts" {
  description = "Maximum exact-profile ECR signing-readiness observations before failing closed."
  type        = number
  default     = 4

  validation {
    condition = (
      floor(var.image_signature_status_max_attempts) == var.image_signature_status_max_attempts
      && var.image_signature_status_max_attempts >= 1
      && var.image_signature_status_max_attempts <= 10
    )
    error_message = "image_signature_status_max_attempts must be an integer from 1 through 10."
  }
}

variable "image_signature_status_attempt_timeout_ms" {
  description = "Per-attempt timeout for the ECR signing-readiness SDK request."
  type        = number
  default     = 4000

  validation {
    condition = (
      floor(var.image_signature_status_attempt_timeout_ms) == var.image_signature_status_attempt_timeout_ms
      && var.image_signature_status_attempt_timeout_ms >= 250
      && var.image_signature_status_attempt_timeout_ms <= 15000
    )
    error_message = "image_signature_status_attempt_timeout_ms must be an integer from 250 through 15000."
  }
}

variable "image_signature_status_retry_delay_ms" {
  description = "Fixed delay between retryable empty or IN_PROGRESS signing-readiness observations."
  type        = number
  default     = 5000

  validation {
    condition = (
      floor(var.image_signature_status_retry_delay_ms) == var.image_signature_status_retry_delay_ms
      && var.image_signature_status_retry_delay_ms >= 0
      && var.image_signature_status_retry_delay_ms <= 5000
    )
    error_message = "image_signature_status_retry_delay_ms must be an integer from 0 through 5000."
  }
}

variable "image_signature_verifier_base_prover_image_uri" {
  description = "Current live verifier image binding retained only while a rollback repoints aliases to a historical immutable version."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.image_signature_verifier_base_prover_image_uri == null
      || can(regex(
        "^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$",
        var.image_signature_verifier_base_prover_image_uri,
      ))
    )
    error_message = "image_signature_verifier_base_prover_image_uri must be null or a digest-pinned ECR image URI."
  }
}

variable "image_signature_verifier_selected_authority" {
  description = "Exact accepted immutable verifier identity selected by the full App plan. The isolated normal preflight leaves this null."
  type = object({
    function_arn                                      = string
    function_version                                  = string
    architecture                                      = string
    runtime                                           = string
    timeout_seconds                                   = number
    environment_sha256                                = string
    function_configuration_sha256                     = string
    execution_role_arn                                = string
    execution_role_assume_policy_sha256               = string
    execution_role_policy_sha256                      = string
    execution_role_permissions_boundary_arn           = string
    execution_role_permissions_boundary_policy_sha256 = string
    preflight_alias_arn                               = string
    runtime_alias_arn                                 = string
    package = object({
      s3_bucket             = string
      s3_key                = string
      s3_object_version     = string
      source_code_hash      = string
      asset_manifest_sha256 = string
      trust_root_sha256     = string
    })
  })
  default  = null
  nullable = true

  validation {
    condition = var.image_signature_verifier_selected_authority == null ? true : (
      can(regex("^[1-9][0-9]*$", var.image_signature_verifier_selected_authority.function_version))
      && var.image_signature_verifier_selected_authority.architecture == "x86_64"
      && var.image_signature_verifier_selected_authority.runtime == var.lambda_runtime
      && floor(var.image_signature_verifier_selected_authority.timeout_seconds) == var.image_signature_verifier_selected_authority.timeout_seconds
      && var.image_signature_verifier_selected_authority.timeout_seconds > 0
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.environment_sha256))
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.function_configuration_sha256))
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.execution_role_assume_policy_sha256))
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.execution_role_policy_sha256))
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.execution_role_permissions_boundary_policy_sha256))
      && var.image_signature_verifier_selected_authority.execution_role_permissions_boundary_arn == var.image_signature_verifier_permissions_boundary_arn
      && var.image_signature_verifier_selected_authority.preflight_alias_arn == "${var.image_signature_verifier_selected_authority.function_arn}:preflight"
      && var.image_signature_verifier_selected_authority.runtime_alias_arn == "${var.image_signature_verifier_selected_authority.function_arn}:runtime"
      && can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.image_signature_verifier_selected_authority.package.s3_bucket))
      && trimspace(var.image_signature_verifier_selected_authority.package.s3_key) != ""
      && trimspace(var.image_signature_verifier_selected_authority.package.s3_object_version) != ""
      && var.image_signature_verifier_selected_authority.package.s3_object_version != "null"
      && can(regex("^[A-Za-z0-9+/]{43}=$", var.image_signature_verifier_selected_authority.package.source_code_hash))
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.package.asset_manifest_sha256))
      && can(regex("^[0-9a-f]{64}$", var.image_signature_verifier_selected_authority.package.trust_root_sha256))
    )
    error_message = "image_signature_verifier_selected_authority must identify one exact accepted immutable verifier version and package."
  }
}
