variable "deploy_mode" {
  description = "Saved-plan application deployment selection mode."
  type        = string

  validation {
    condition     = contains(["normal", "rollback"], var.deploy_mode)
    error_message = "deploy_mode must be normal or rollback."
  }
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
    condition = toset(keys(var.lambda_artifacts)) == toset(local.image_signature_verifier_standalone ? ["image_signature_verifier"] : [
      "public_api",
      "finalization_writer",
      "proof_dispatcher",
      "verification_worker",
      "image_signature_verifier",
      "semaphore_janitor",
    ])
    error_message = "lambda_artifacts must contain exactly public_api, finalization_writer, proof_dispatcher, verification_worker, image_signature_verifier, and semaphore_janitor. The separate verifier-only configuration admits only image_signature_verifier."
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

variable "prover_image_uri" {
  description = "Pinned target prover container image URI with digest."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z]{2}-[a-z]+-[0-9]\\.amazonaws\\.com\\/[A-Za-z0-9._\\/-]+@sha256:[0-9a-f]{64}$", var.prover_image_uri))
    error_message = "prover_image_uri must be a digest-pinned ECR URI."
  }
}

variable "image_signature_preflight_prover_image_uri" {
  description = "Optional digest-pinned Prover image selected by the isolated verifier preflight; normal full App plans carry that same selection, while refresh and rollback leave it null."
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
