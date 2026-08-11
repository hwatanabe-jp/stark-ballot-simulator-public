variable "aws_region" {
  description = "AWS Region for foundation resources."
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
  description = "Target AWS account alias for foundation state."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,62}$", var.account_alias))
    error_message = "account_alias must be a lowercase account alias."
  }
}

variable "deployment_environment" {
  description = "Deployment environment name carried in the state identity."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,62}$", var.deployment_environment))
    error_message = "deployment_environment must be a lowercase environment identifier."
  }
}

variable "state_scope" {
  description = "Terraform state scope. This root supports foundation only."
  type        = string

  validation {
    condition     = var.state_scope == "foundation"
    error_message = "infra/terraform/foundation supports only the foundation state scope."
  }
}

variable "project_name" {
  description = "Project name used for identity checks and tags."
  type        = string
}

variable "state_backend_key" {
  description = "Expected S3 backend key for this foundation state."
  type        = string
}

variable "public_hostname_disposition" {
  description = "Public hostname decision carried into the release-candidate handoff."
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
