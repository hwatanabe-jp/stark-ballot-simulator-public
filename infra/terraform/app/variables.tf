variable "deployment_id" {
  description = "Opaque accepted application deployment generation stamped into target runtimes."
  type        = string

  validation {
    condition     = can(regex("^dep_[0-9a-f]{32}$", var.deployment_id))
    error_message = "deployment_id must be an opaque dep_ identifier with 32 lowercase hexadecimal characters."
  }
}

variable "app_source_sha" {
  description = "Full selected application source SHA accepted by the app deployment lane."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}([0-9a-f]{24})?$", var.app_source_sha))
    error_message = "app_source_sha must be the selected lowercase 40- or 64-character Git SHA."
  }
}

variable "enable_dynamodb_deletion_protection" {
  description = "Whether development DynamoDB tables should enable deletion protection."
  type        = bool
  default     = true
}

variable "session_live_ttl_seconds" {
  description = "Live-session retention used by target runtime config."
  type        = number
  default     = 1800

  validation {
    condition     = var.session_live_ttl_seconds == 1800
    error_message = "session_live_ttl_seconds must be 1800 under the storage retention policy."
  }
}

variable "verification_artifact_ttl_seconds" {
  description = "Finalized verification/artifact retention used by target runtime config."
  type        = number
  default     = 7200

  validation {
    condition     = var.verification_artifact_ttl_seconds == 7200
    error_message = "verification_artifact_ttl_seconds must be 7200 under the storage retention policy."
  }
}

variable "proof_artifact_lifecycle_days" {
  description = "S3 lifecycle retention in days for target private proof/artifact objects."
  type        = number
  default     = 7

  validation {
    condition     = var.proof_artifact_lifecycle_days == 7
    error_message = "proof_artifact_lifecycle_days must be 7 under the storage retention policy."
  }
}

variable "vote_duplicate_detector_ttl_seconds" {
  description = "Per-session duplicate-vote detector retention used by target runtime config."
  type        = number
  default     = 1800

  validation {
    condition     = var.vote_duplicate_detector_ttl_seconds == 1800
    error_message = "vote_duplicate_detector_ttl_seconds must be 1800 under the storage retention policy."
  }
}

variable "prover_max_concurrent_provers" {
  description = "Shared AWS Batch replenishable capacity for on-demand Fargate prover jobs."
  type        = number
  default     = 2

  validation {
    condition     = var.prover_max_concurrent_provers == 2
    error_message = "prover_max_concurrent_provers must be 2."
  }
}

variable "fargate_vcpu_alarm_threshold" {
  description = "Passive alarm threshold for account-level Fargate On-Demand vCPU usage."
  type        = number
  default     = 40

  validation {
    condition     = floor(var.fargate_vcpu_alarm_threshold) == var.fargate_vcpu_alarm_threshold && var.fargate_vcpu_alarm_threshold >= 1
    error_message = "fargate_vcpu_alarm_threshold must be a positive integer."
  }
}

variable "verifier_service_bin_path" {
  description = "Executable path for the Rust verifier-service binary inside the immutable verification worker Lambda package."
  type        = string
  default     = "/var/task/verifier-service"

  validation {
    condition     = var.verifier_service_bin_path == "/var/task/verifier-service"
    error_message = "verifier_service_bin_path must point to the verifier-service executable packaged in the verification worker zip."
  }
}

variable "expected_image_id" {
  description = "Expected zkVM ImageID for the target runtime."
  type        = string

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{64}$", var.expected_image_id))
    error_message = "expected_image_id must be a 32-byte 0x-prefixed hex string."
  }
}

variable "image_id_mapping_evidence" {
  description = "Repository ImageID mapping evidence used to authorize expected_image_id."
  type = object({
    mapping_path               = string
    mapping_sha256             = string
    current_method_version     = number
    current_method_version_key = string
    variant                    = string
    expected_image_id          = string
  })

  validation {
    condition = (
      var.image_id_mapping_evidence.mapping_path == "public/imageId-mapping.json"
      && can(regex("^[0-9a-f]{64}$", var.image_id_mapping_evidence.mapping_sha256))
      && tostring(var.image_id_mapping_evidence.current_method_version) == var.image_id_mapping_evidence.current_method_version_key
      && contains(["default", "x86_64"], var.image_id_mapping_evidence.variant)
      && lower(var.image_id_mapping_evidence.expected_image_id) == lower(var.expected_image_id)
    )
    error_message = "image_id_mapping_evidence must describe the active current public/imageId-mapping.json entry that matches expected_image_id."
  }
}

variable "verifier_public_base_url" {
  description = "Public verifier/API base URL used by target runtime link generation."
  type        = string
  default     = "https://develop.stark-ballot-sim.hwatanabe.dev"

  validation {
    condition = (
      can(regex("^https://[^/?#]+/?$", var.verifier_public_base_url))
      && !can(regex("[?#]", var.verifier_public_base_url))
    )
    error_message = "verifier_public_base_url must be an https origin without path, query, or fragment."
  }

  validation {
    condition = (
      var.deployment_environment != "main"
      || lower(trimsuffix(var.verifier_public_base_url, "/")) == "https://${lower(var.public_hostname)}"
    )
    error_message = "Production verifier_public_base_url must match the configured public hostname."
  }
}

variable "public_hostname_disposition" {
  description = "Public hostname disposition consumed by the app root."
  type        = string
  default     = "external-dns-acm"

  validation {
    condition = contains([
      "generated-cloudfront-hostname",
      "external-dns-acm",
      "foundation-owned-dns-acm",
    ], var.public_hostname_disposition)
    error_message = "public_hostname_disposition must be generated-cloudfront-hostname, external-dns-acm, or foundation-owned-dns-acm."
  }
}

variable "public_hostname" {
  description = "Develop public hostname used for CloudFront alias, Turnstile host allowlist, and runtime public URL evidence."
  type        = string
  default     = "develop.stark-ballot-sim.hwatanabe.dev"

  validation {
    condition = (
      can(regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$", var.public_hostname))
      && !can(regex("^https?://", var.public_hostname))
      && !can(regex("[/?#]", var.public_hostname))
    )
    error_message = "public_hostname must be a hostname, not a URL."
  }
}

variable "cloudfront_acm_certificate_arn" {
  description = "us-east-1 ACM certificate ARN for the externally owned or foundation-owned CloudFront alias."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.cloudfront_acm_certificate_arn == null
      || can(regex("^arn:aws:acm:us-east-1:${var.aws_account_id}:certificate/[A-Za-z0-9-]+$", var.cloudfront_acm_certificate_arn))
    )
    error_message = "cloudfront_acm_certificate_arn must be a same-account us-east-1 ACM certificate ARN when set."
  }

  validation {
    condition = (
      var.deployment_environment != "main"
      || (
        var.cloudfront_acm_certificate_arn != null
        && contains(["external-dns-acm", "foundation-owned-dns-acm"], var.public_hostname_disposition)
        && lower(var.public_hostname) != "develop.stark-ballot-sim.hwatanabe.dev"
      )
    )
    error_message = "Production requires a custom public hostname disposition, explicit hostname, and same-account us-east-1 ACM certificate."
  }
}

variable "develop_operator_gate_enabled" {
  description = "Enable the outer operator/tester CloudFront gate for the develop hostname."
  type        = bool
  default     = false

  validation {
    condition     = var.deployment_environment == "develop" || !var.develop_operator_gate_enabled
    error_message = "develop_operator_gate_enabled may be true only for the develop app lane."
  }
}

variable "prover_subnet_ids" {
  description = "Public or controlled subnet IDs used by the target Fargate prover task."
  type        = list(string)

  validation {
    condition     = length(var.prover_subnet_ids) > 0 && alltrue([for id in var.prover_subnet_ids : can(regex("^subnet-[0-9a-f]+$", id))])
    error_message = "prover_subnet_ids must contain at least one subnet ID."
  }
}

variable "prover_security_group_ids" {
  description = "Security group IDs used by the target Fargate prover task."
  type        = list(string)

  validation {
    condition     = length(var.prover_security_group_ids) > 0 && alltrue([for id in var.prover_security_group_ids : can(regex("^sg-[0-9a-f]+$", id))])
    error_message = "prover_security_group_ids must contain at least one security group ID."
  }
}

variable "prover_cpu" {
  description = "Fargate CPU units for the target prover task."
  type        = number
  default     = 16384
}

variable "prover_memory" {
  description = "Fargate memory MiB for the target prover task."
  type        = number
  default     = 32768
}

variable "prover_task_timeout_seconds" {
  description = "Maximum execution time of an AWS Batch prover attempt, excluding queue wait."
  type        = number
  default     = 1800

  validation {
    condition     = var.prover_task_timeout_seconds >= 60 && floor(var.prover_task_timeout_seconds) == var.prover_task_timeout_seconds
    error_message = "prover_task_timeout_seconds must be an integer of at least 60 seconds."
  }
}
