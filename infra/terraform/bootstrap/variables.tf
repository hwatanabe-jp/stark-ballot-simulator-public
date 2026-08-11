variable "aws_region" {
  description = "AWS Region for bootstrap resources."
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

variable "protected_production_aws_account_id" {
  description = "Expected AWS account ID for repository-only protected-production app lane contract rendering."
  type        = string
  default     = null

  validation {
    condition = (
      var.protected_production_aws_account_id == null
      || can(regex("^[0-9]{12}$", var.protected_production_aws_account_id))
    )
    error_message = "protected_production_aws_account_id must be a 12-digit AWS account ID when set."
  }
}

variable "account_alias" {
  description = "Target AWS account alias, for example stark-dev."
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
    condition     = contains(["develop", "main"], var.deployment_environment)
    error_message = "deployment_environment must be develop or main."
  }
}

variable "state_scope" {
  description = "Terraform state scope. This bootstrap root supports bootstrap only."
  type        = string

  validation {
    condition     = var.state_scope == "bootstrap"
    error_message = "infra/terraform/bootstrap supports only the bootstrap state scope."
  }
}

variable "project_name" {
  description = "Project name used for names and tags."
  type        = string
}

variable "state_bucket_name" {
  description = "S3 bucket name for Terraform remote state."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name)) && !can(regex("\\.\\.", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid S3 bucket name."
  }
}

variable "state_backend_key" {
  description = "Expected S3 backend key for this bootstrap state."
  type        = string
}

variable "state_kms_key_id" {
  description = "Existing or adopted KMS key ID for Terraform state encryption."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f-]{36}$", var.state_kms_key_id))
    error_message = "state_kms_key_id must be a KMS key UUID."
  }
}

variable "state_kms_alias" {
  description = "KMS alias name used by the Terraform backend."
  type        = string

  validation {
    condition     = can(regex("^alias/[A-Za-z0-9/_-]+$", var.state_kms_alias))
    error_message = "state_kms_alias must be a KMS alias such as alias/example."
  }
}

variable "backend_principal_arns" {
  description = "IAM principal ARNs allowed to use the bootstrap backend before deploy roles exist."
  type        = list(string)

  validation {
    condition = length(var.backend_principal_arns) > 0 && alltrue([
      for arn in var.backend_principal_arns :
      can(regex("^arn:aws(-[a-z]+)?:iam::[0-9]{12}:role/.+$", arn))
    ])
    error_message = "backend_principal_arns must contain at least one IAM role ARN."
  }
}

variable "enable_development_pipeline" {
  description = "Whether to manage the initial development saved-plan pipeline prerequisites in this bootstrap root."
  type        = bool
  default     = false
}

variable "github_full_repository_id" {
  description = "GitHub repository in owner/name form for the source connection."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_full_repository_id))
    error_message = "github_full_repository_id must be in owner/name form."
  }
}

variable "source_branch" {
  description = "Source branch used by the development bootstrap pipeline."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.source_branch)) && !can(regex("\\.\\.", var.source_branch))
    error_message = "source_branch must be a safe Git branch name."
  }
}

variable "control_source_sha" {
  description = "Exact reviewed Bootstrap source revision currently applied to source-bound repository tooling."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.control_source_sha))
    error_message = "control_source_sha must be a full lowercase 40-character Git commit SHA."
  }
}

variable "terraform_version" {
  description = "Terraform CLI version installed by pipeline CodeBuild jobs."
  type        = string
  default     = "1.15.8"

  validation {
    condition     = var.terraform_version == "1.15.8"
    error_message = "terraform_version must be the exact reviewed Terraform version 1.15.8."
  }
}

variable "enable_development_app_pipeline" {
  description = "Whether to manage the skeletal development app saved-plan pipeline from bootstrap state."
  type        = bool
  default     = false
}

variable "development_app_public_hostname" {
  description = "Externally owned develop public hostname consumed by the app saved-plan lane."
  type        = string
  default     = "develop.stark-ballot-sim.hwatanabe.dev"

  validation {
    condition = (
      can(regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$", var.development_app_public_hostname))
      && !can(regex("^https?://", var.development_app_public_hostname))
      && !can(regex("[/?#]", var.development_app_public_hostname))
    )
    error_message = "development_app_public_hostname must be a hostname, not a URL."
  }
}

variable "development_app_cloudfront_acm_certificate_arn" {
  description = "us-east-1 ACM certificate ARN for the externally owned develop app CloudFront alias."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.development_app_cloudfront_acm_certificate_arn == null
      || can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[A-Za-z0-9-]+$", var.development_app_cloudfront_acm_certificate_arn))
    )
    error_message = "development_app_cloudfront_acm_certificate_arn must be a us-east-1 ACM certificate ARN when set."
  }
}

variable "enable_development_foundation_pipeline" {
  description = "Whether to manage the development foundation saved-plan pipeline from bootstrap state."
  type        = bool
  default     = false
}
