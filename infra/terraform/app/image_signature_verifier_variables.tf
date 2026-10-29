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
