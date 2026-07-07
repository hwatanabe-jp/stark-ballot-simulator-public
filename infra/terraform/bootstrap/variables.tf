variable "aws_region" {
  description = "AWS Region for bootstrap resources."
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
  default     = "bootstrap"

  validation {
    condition     = var.state_scope == "bootstrap"
    error_message = "infra/terraform/bootstrap supports only the bootstrap state scope."
  }
}

variable "project_name" {
  description = "Project name used for names and tags."
  type        = string
  default     = "stark-ballot-simulator"
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

  validation {
    condition     = can(regex("^stark-ballot-simulator/[a-z][a-z0-9-]*/(develop|main)/bootstrap/terraform\\.tfstate$", var.state_backend_key))
    error_message = "state_backend_key must use stark-ballot-simulator/<account-alias>/<environment>/bootstrap/terraform.tfstate."
  }
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
  default     = "hwatanabe-jp/stark-ballot-simulator"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_full_repository_id))
    error_message = "github_full_repository_id must be in owner/name form."
  }
}

variable "source_branch" {
  description = "Source branch used by the development bootstrap pipeline."
  type        = string
  default     = "develop"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.source_branch)) && !can(regex("\\.\\.", var.source_branch))
    error_message = "source_branch must be a safe Git branch name."
  }
}

variable "terraform_version" {
  description = "Terraform CLI version installed by pipeline CodeBuild jobs."
  type        = string
  default     = "1.15.5"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.terraform_version))
    error_message = "terraform_version must be a semantic version such as 1.15.5."
  }
}

variable "pipeline_artifact_bucket_name" {
  description = "Optional explicit S3 bucket name for development pipeline artifacts."
  type        = string
  default     = null

  validation {
    condition = (
      var.pipeline_artifact_bucket_name == null
      || (
        can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.pipeline_artifact_bucket_name))
        && !can(regex("\\.\\.", var.pipeline_artifact_bucket_name))
      )
    )
    error_message = "pipeline_artifact_bucket_name must be a valid S3 bucket name when set."
  }
}

variable "pipeline_artifact_retention_days" {
  description = "Number of days to retain current and noncurrent development pipeline artifacts."
  type        = number
  default     = 30

  validation {
    condition     = contains([7, 14, 30, 60, 90], var.pipeline_artifact_retention_days)
    error_message = "pipeline_artifact_retention_days must be one of 7, 14, 30, 60, or 90."
  }
}

variable "pipeline_log_retention_days" {
  description = "CloudWatch Logs retention for development bootstrap pipeline CodeBuild jobs."
  type        = number
  default     = 30

  validation {
    condition     = contains([7, 14, 30, 60, 90, 120, 150, 180, 365], var.pipeline_log_retention_days)
    error_message = "pipeline_log_retention_days must be a supported CloudWatch Logs retention value."
  }
}

variable "enable_development_app_pipeline" {
  description = "Whether to manage the skeletal development app saved-plan pipeline from bootstrap state."
  type        = bool
  default     = false
}

variable "app_pipeline_artifact_bucket_name" {
  description = "Optional explicit S3 bucket name for development app pipeline artifacts."
  type        = string
  default     = null

  validation {
    condition = (
      var.app_pipeline_artifact_bucket_name == null
      || (
        can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.app_pipeline_artifact_bucket_name))
        && !can(regex("\\.\\.", var.app_pipeline_artifact_bucket_name))
      )
    )
    error_message = "app_pipeline_artifact_bucket_name must be a valid S3 bucket name when set."
  }
}

variable "foundation_release_manifest_bucket_name" {
  description = "Optional explicit foundation-owned S3 bucket name that stores immutable release manifests consumed by the app pipeline."
  type        = string
  default     = null

  validation {
    condition = (
      var.foundation_release_manifest_bucket_name == null
      || (
        can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.foundation_release_manifest_bucket_name))
        && !can(regex("\\.\\.", var.foundation_release_manifest_bucket_name))
      )
    )
    error_message = "foundation_release_manifest_bucket_name must be a valid S3 bucket name when set."
  }
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

variable "development_app_operator_gate_public_key_pem" {
  description = "PEM-encoded CloudFront public key consumed by the develop app operator/tester gate."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.development_app_operator_gate_public_key_pem == null
      || can(regex("^-----BEGIN PUBLIC KEY-----[\\s\\S]+-----END PUBLIC KEY-----\\s*$", var.development_app_operator_gate_public_key_pem))
    )
    error_message = "development_app_operator_gate_public_key_pem must be a PEM-encoded public key when set."
  }
}

variable "app_pipeline_artifact_retention_days" {
  description = "Minimum days to retain development app deployment-authority artifacts."
  type        = number
  default     = 180

  validation {
    condition     = contains([180, 365], var.app_pipeline_artifact_retention_days)
    error_message = "app_pipeline_artifact_retention_days must be 180 or 365."
  }
}

variable "app_pipeline_log_retention_days" {
  description = "CloudWatch Logs retention for development app pipeline CodeBuild jobs."
  type        = number
  default     = 180

  validation {
    condition     = contains([180, 365], var.app_pipeline_log_retention_days)
    error_message = "app_pipeline_log_retention_days must be 180 or 365."
  }
}

variable "enable_development_foundation_pipeline" {
  description = "Whether to manage the development foundation saved-plan pipeline from bootstrap state."
  type        = bool
  default     = false
}

variable "foundation_pipeline_artifact_bucket_name" {
  description = "Optional explicit S3 bucket name for development foundation pipeline artifacts."
  type        = string
  default     = null

  validation {
    condition = (
      var.foundation_pipeline_artifact_bucket_name == null
      || (
        can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.foundation_pipeline_artifact_bucket_name))
        && !can(regex("\\.\\.", var.foundation_pipeline_artifact_bucket_name))
      )
    )
    error_message = "foundation_pipeline_artifact_bucket_name must be a valid S3 bucket name when set."
  }
}

variable "foundation_pipeline_artifact_retention_days" {
  description = "Minimum days to retain development foundation deployment-authority artifacts."
  type        = number
  default     = 365

  validation {
    condition     = contains([180, 365], var.foundation_pipeline_artifact_retention_days)
    error_message = "foundation_pipeline_artifact_retention_days must be 180 or 365."
  }
}

variable "foundation_pipeline_log_retention_days" {
  description = "CloudWatch Logs retention for development foundation pipeline CodeBuild jobs."
  type        = number
  default     = 365

  validation {
    condition     = contains([180, 365], var.foundation_pipeline_log_retention_days)
    error_message = "foundation_pipeline_log_retention_days must be 180 or 365."
  }
}
