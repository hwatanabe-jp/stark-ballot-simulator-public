variable "aws_region" {
  description = "AWS Region for foundation resources."
  type        = string
  default     = "ap-northeast-1"

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
  description = "Target AWS account alias for foundation state."
  type        = string

  validation {
    condition     = var.account_alias == "stark-dev"
    error_message = "foundation state is currently authorized only for stark-dev."
  }
}

variable "deployment_environment" {
  description = "Deployment environment name carried in the state identity."
  type        = string

  validation {
    condition     = var.deployment_environment == "develop"
    error_message = "foundation state is currently authorized only for develop."
  }
}

variable "state_scope" {
  description = "Terraform state scope. This root supports foundation only."
  type        = string
  default     = "foundation"

  validation {
    condition     = var.state_scope == "foundation"
    error_message = "infra/terraform/foundation supports only the foundation state scope."
  }
}

variable "project_name" {
  description = "Project name used for identity checks and tags."
  type        = string
  default     = "stark-ballot-simulator"
}

variable "state_backend_key" {
  description = "Expected S3 backend key for this foundation state."
  type        = string

  validation {
    condition     = var.state_backend_key == "stark-ballot-simulator/${var.account_alias}/${var.deployment_environment}/foundation/terraform.tfstate"
    error_message = "state_backend_key must match stark-ballot-simulator/<account_alias>/<deployment_environment>/foundation/terraform.tfstate."
  }
}

variable "release_manifest_bucket_name" {
  description = "Optional explicit bucket name for immutable release manifests."
  type        = string
  default     = null

  validation {
    condition = (
      var.release_manifest_bucket_name == null
      || (
        can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.release_manifest_bucket_name))
        && !can(regex("\\.\\.", var.release_manifest_bucket_name))
      )
    )
    error_message = "release_manifest_bucket_name must be a valid S3 bucket name when set."
  }
}

variable "public_hostname_disposition" {
  description = "Plan 02 public hostname decision carried into the release-candidate handoff."
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
