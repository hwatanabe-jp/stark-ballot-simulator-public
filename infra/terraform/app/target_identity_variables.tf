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

variable "state_backend_key" {
  description = "Expected S3 backend key for this app state."
  type        = string
}
