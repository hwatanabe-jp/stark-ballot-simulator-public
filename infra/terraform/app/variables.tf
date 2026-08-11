variable "aws_region" {
  description = "AWS Region for app resources."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]{1}$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name."
  }
}

variable "aws_account_id" {
  description = "Expected AWS account ID for the selected account alias."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "account_alias" {
  description = "Target AWS account alias for the app state."
  type        = string

  validation {
    condition     = contains(["stark-dev", "stark-prod"], var.account_alias)
    error_message = "account_alias must be stark-dev or stark-prod for the app state."
  }
}

variable "deployment_environment" {
  description = "Deployment environment name carried in the state identity."
  type        = string

  validation {
    condition     = contains(["develop", "main"], var.deployment_environment)
    error_message = "deployment_environment must be develop or main for the app state."
  }

  validation {
    condition = (
      (var.account_alias == "stark-dev" && var.deployment_environment == "develop")
      || (var.account_alias == "stark-prod" && var.deployment_environment == "main")
    )
    error_message = "app state identity must map develop to stark-dev or main to stark-prod."
  }
}

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

variable "deploy_mode" {
  description = "Saved-plan application deployment selection mode."
  type        = string

  validation {
    condition     = contains(["normal", "rollback"], var.deploy_mode)
    error_message = "deploy_mode must be normal or rollback."
  }
}

variable "state_scope" {
  description = "Terraform state scope. This app root supports app only."
  type        = string

  validation {
    condition     = var.state_scope == "app"
    error_message = "infra/terraform/app supports only the app state scope."
  }
}

variable "project_name" {
  description = "Project name used for identity checks and tags."
  type        = string
}

variable "image_signature_verifier_permissions_boundary_arn" {
  description = "Bootstrap-managed least-privilege permissions boundary required on the image-signature verifier execution role."
  type        = string

  validation {
    condition = var.image_signature_verifier_permissions_boundary_arn == (
      "arn:aws:iam::${var.aws_account_id}:policy/${var.project_name}-image-signature-verifier-boundary-${var.account_alias}-${var.deployment_environment}"
    )
    error_message = "image_signature_verifier_permissions_boundary_arn must identify the exact bootstrap-managed verifier execution boundary."
  }
}

variable "state_backend_key" {
  description = "Expected S3 backend key for this app state."
  type        = string
}

variable "enable_dynamodb_deletion_protection" {
  description = "Whether development DynamoDB tables should enable deletion protection."
  type        = bool
  default     = true
}

variable "dynamodb_recovery_phase" {
  description = "Explicit four-phase DynamoDB recovery transition state selected by the app saved-plan lane."
  type        = string
  default     = "primary_active"

  validation {
    condition = contains([
      "primary_active",
      "primary_quiesced",
      "replacement_quiesced",
      "replacement_active",
    ], var.dynamodb_recovery_phase)
    error_message = "dynamodb_recovery_phase must be primary_active, primary_quiesced, replacement_quiesced, or replacement_active."
  }
}

variable "dynamodb_recovery_activation" {
  description = "Validated, non-secret two-table recovery activation selected by the app saved-plan lane; null keeps the Terraform-owned primary tables active."
  type = object({
    manifest_type          = string
    validation_status      = string
    recovery_id            = string
    recovery_point         = string
    manifest_sha256        = string
    account_alias          = string
    deployment_environment = string
    account_id             = string
    region                 = string
    kms_key_arn            = string
    sessions = object({
      source_table_arn = string
      table_arn        = string
      table_name       = string
      key_schema       = string
    })
    votes = object({
      source_table_arn     = string
      table_arn            = string
      table_name           = string
      key_schema           = string
      vote_id_index_schema = string
    })
  })
  default  = null
  nullable = true

  validation {
    condition = var.dynamodb_recovery_activation == null ? true : (
      var.dynamodb_recovery_activation.manifest_type == "dynamodb-recovery-activation"
      && var.dynamodb_recovery_activation.validation_status == "validated"
      && can(regex("^[0-9a-f]{64}$", var.dynamodb_recovery_activation.recovery_id))
      && can(regex("^[0-9a-f]{64}$", var.dynamodb_recovery_activation.manifest_sha256))
      && can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", var.dynamodb_recovery_activation.recovery_point))
    )
    error_message = "dynamodb_recovery_activation must be a validated semantic manifest with one recovery ID, checksum, and UTC recovery point."
  }

  validation {
    condition = var.dynamodb_recovery_activation == null ? true : (
      var.dynamodb_recovery_activation.account_alias == var.account_alias
      && var.dynamodb_recovery_activation.deployment_environment == var.deployment_environment
      && var.dynamodb_recovery_activation.account_id == var.aws_account_id
      && var.dynamodb_recovery_activation.region == var.aws_region
      && can(regex("^arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/[0-9a-fA-F-]+$", var.dynamodb_recovery_activation.kms_key_arn))
    )
    error_message = "dynamodb_recovery_activation account, region, alias, environment, and KMS key must match the app lane."
  }

  validation {
    condition = var.dynamodb_recovery_activation == null ? true : (
      var.dynamodb_recovery_activation.sessions.source_table_arn == "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.account_alias}-${var.deployment_environment}-sessions"
      && var.dynamodb_recovery_activation.votes.source_table_arn == "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.project_name}-${var.account_alias}-${var.deployment_environment}-votes"
      && var.dynamodb_recovery_activation.sessions.table_arn == "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.dynamodb_recovery_activation.sessions.table_name}"
      && var.dynamodb_recovery_activation.votes.table_arn == "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${var.dynamodb_recovery_activation.votes.table_name}"
    )
    error_message = "dynamodb_recovery_activation must select replacement ARNs for the app lane's primary sessions and votes pair."
  }

  validation {
    condition = var.dynamodb_recovery_activation == null ? true : (
      startswith(var.dynamodb_recovery_activation.sessions.table_name, "${var.project_name}-${var.account_alias}-${var.deployment_environment}-sessions-recovery-")
      && startswith(var.dynamodb_recovery_activation.votes.table_name, "${var.project_name}-${var.account_alias}-${var.deployment_environment}-votes-recovery-")
      && trimprefix(var.dynamodb_recovery_activation.sessions.table_name, "${var.project_name}-${var.account_alias}-${var.deployment_environment}-sessions-recovery-") == trimprefix(var.dynamodb_recovery_activation.votes.table_name, "${var.project_name}-${var.account_alias}-${var.deployment_environment}-votes-recovery-")
      && var.dynamodb_recovery_activation.sessions.key_schema == "sessionId:S:HASH"
      && var.dynamodb_recovery_activation.votes.key_schema == "sessionId:S:HASH,voteIndex:N:RANGE"
      && var.dynamodb_recovery_activation.votes.vote_id_index_schema == "voteId-index:voteId:S:HASH:KEYS_ONLY"
    )
    error_message = "dynamodb_recovery_activation replacement names and table schemas must match one complete DynamoSessionStore recovery pair."
  }
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

variable "lambda_runtime" {
  description = "Node.js Lambda runtime for target-owned packages."
  type        = string
  default     = "nodejs24.x"

  validation {
    condition     = contains(["nodejs24.x"], var.lambda_runtime)
    error_message = "lambda_runtime must be nodejs24.x for the current target runtime."
  }
}

variable "lambda_artifacts" {
  description = "Immutable target-owned Lambda package artifacts produced by the app pipeline."
  type = map(object({
    s3_bucket             = string
    s3_key                = string
    s3_object_version     = string
    source_code_hash      = string
    asset_manifest_sha256 = optional(string)
    trust_root_sha256     = optional(string)
  }))

  validation {
    condition = toset(keys(var.lambda_artifacts)) == toset([
      "public_api",
      "finalization_writer",
      "proof_dispatcher",
      "verification_worker",
      "image_signature_verifier",
      "semaphore_janitor",
    ])
    error_message = "lambda_artifacts must contain exactly public_api, finalization_writer, proof_dispatcher, verification_worker, image_signature_verifier, and semaphore_janitor."
  }

  validation {
    condition = alltrue([
      for artifact in values(var.lambda_artifacts) :
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", artifact.s3_bucket))
      && !can(regex("\\.\\.", artifact.s3_bucket))
      && trimspace(artifact.s3_key) != ""
      && !startswith(artifact.s3_key, "/")
      && trimspace(artifact.s3_object_version) != ""
      && can(regex("^[A-Za-z0-9+/]{43}=$", artifact.source_code_hash))
    ])
    error_message = "Each lambda_artifacts entry must include a valid S3 bucket, nonempty S3 key, nonempty S3 object version, and base64 SHA-256 source_code_hash."
  }

  validation {
    condition = alltrue([
      for name, artifact in var.lambda_artifacts :
      name == "image_signature_verifier"
      ? (
        can(regex("^[0-9a-f]{64}$", artifact.asset_manifest_sha256))
        && can(regex("^[0-9a-f]{64}$", artifact.trust_root_sha256))
      )
      : artifact.asset_manifest_sha256 == null && artifact.trust_root_sha256 == null
    ])
    error_message = "Only image_signature_verifier may include asset_manifest_sha256 and trust_root_sha256, and both must be lowercase SHA-256 values."
  }
}

variable "prover_max_concurrent_provers" {
  description = "Maximum number of target Fargate prover tasks admitted through the DynamoDB semaphore."
  type        = number
  default     = 2

  validation {
    condition     = floor(var.prover_max_concurrent_provers) == var.prover_max_concurrent_provers && var.prover_max_concurrent_provers >= 1
    error_message = "prover_max_concurrent_provers must be a positive integer."
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

variable "prover_image_uri" {
  description = "Pinned target prover container image URI with digest."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com\\/[A-Za-z0-9._\\/-]+@sha256:[0-9a-f]{64}$", var.prover_image_uri))
    error_message = "prover_image_uri must be a digest-pinned ECR URI."
  }
}

variable "image_signature_preflight_prover_image_uri" {
  description = "Optional digest-pinned Prover image used only by the isolated verifier preflight apply; routine full App plans leave this null."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.image_signature_preflight_prover_image_uri == null
      || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com\\/[A-Za-z0-9._\\/-]+@sha256:[0-9a-f]{64}$", var.image_signature_preflight_prover_image_uri))
    )
    error_message = "image_signature_preflight_prover_image_uri must be null or a digest-pinned ECR URI."
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
      || can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[A-Za-z0-9-]+$", var.cloudfront_acm_certificate_arn))
    )
    error_message = "cloudfront_acm_certificate_arn must be a us-east-1 ACM certificate ARN when set."
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
  description = "Maximum runtime for the target async prover ECS task before Step Functions records a timeout callback."
  type        = number
  default     = 1800

  validation {
    condition     = var.prover_task_timeout_seconds > 0 && floor(var.prover_task_timeout_seconds) == var.prover_task_timeout_seconds
    error_message = "prover_task_timeout_seconds must be a positive integer."
  }
}
