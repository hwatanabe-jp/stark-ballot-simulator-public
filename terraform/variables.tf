# 基本設定変数
# 詳細な変数定義は今後のリソース実装時に追加

variable "aws_region" {
  description = "AWS Region for deployment"
  type        = string
  default     = "ap-northeast-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]{1}$", var.aws_region))
    error_message = "AWS region must be in the format: us-east-1, ap-northeast-1, etc."
  }
}

variable "aws_profile" {
  description = "AWS CLI profile to use for authentication (aws-vault / shared config)"
  type        = string
  default     = "terraform-admin"
}

variable "environment" {
  description = "Deployment environment (develop or main)"
  type        = string

  validation {
    condition     = contains(["develop", "main"], var.environment)
    error_message = "Environment must be either 'develop' or 'main'."
  }
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "stark-ballot-simulator"
}

variable "ecs_image_uri" {
  description = "Digest-pinned ECR image URI for the zkVM prover task (required for signed-image verification)"
  type        = string
  default     = ""

  validation {
    condition = (
      length(trimspace(var.ecs_image_uri)) > 0
      && can(regex("@sha256:[0-9a-f]{64}$", var.ecs_image_uri))
    )
    error_message = "ecs_image_uri must be a digest-pinned ECR URI (e.g., ...@sha256:<64-hex>). Do not use tags such as :latest or commit SHAs because ECR signing status is evaluated per digest."
  }
}

variable "risc0_toolchain_codebuild_name" {
  description = "CodeBuild project name for the RISC Zero toolchain base image"
  type        = string
  default     = "stark-ballot-simulator-risc0-toolchain-builder"

  validation {
    condition     = length(trimspace(var.risc0_toolchain_codebuild_name)) > 0
    error_message = "risc0_toolchain_codebuild_name must be set."
  }
}

variable "risc0_toolchain_source_version" {
  description = "Git ref used by the shared RISC Zero toolchain CodeBuild project"
  type        = string
  default     = "refs/heads/main"

  validation {
    condition = (
      length(trimspace(var.risc0_toolchain_source_version)) > 0
      && can(regex("^refs/(heads|tags)/.+$", var.risc0_toolchain_source_version))
    )
    error_message = "risc0_toolchain_source_version must be a Git ref such as refs/heads/main or refs/tags/v1.2.3."
  }
}

variable "risc0_version" {
  description = "Pinned RISC Zero release version used by the shared toolchain builder"
  type        = string
  default     = "3.0.5"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.risc0_version))
    error_message = "risc0_version must be a semantic version like 3.0.5."
  }
}

variable "risc0_commit" {
  description = "Pinned risc0/risc0 commit for the shared toolchain builder"
  type        = string
  default     = "8eb06ab020a92dc5b63ba6dd0836d432aba6d890"

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.risc0_commit))
    error_message = "risc0_commit must be a 40-character lowercase Git commit SHA."
  }
}

variable "risc0_rust_version" {
  description = "Pinned host Rust version used by the shared toolchain builder"
  type        = string
  default     = "1.91.1"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.risc0_rust_version))
    error_message = "risc0_rust_version must be a semantic version like 1.91.1."
  }
}

variable "risc0_rust_toolchain_tag" {
  description = "Pinned risc0/rust toolchain tag used to build the ARM64 guest toolchain"
  type        = string
  default     = "r0.1.91.1"

  validation {
    condition     = can(regex("^r[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$", var.risc0_rust_toolchain_tag))
    error_message = "risc0_rust_toolchain_tag must look like r0.1.91.1."
  }
}

variable "risc0_toolchain_image_retention_count" {
  description = "Number of RISC Zero toolchain images to keep in ECR"
  type        = number
  default     = 5

  validation {
    condition     = var.risc0_toolchain_image_retention_count > 0
    error_message = "risc0_toolchain_image_retention_count must be greater than 0."
  }
}

variable "ecr_signing_profile_arn" {
  description = "AWS Signer profile ARN used by ECR managed signing"
  type        = string
  default     = ""

  validation {
    condition = (
      length(trimspace(var.ecr_signing_profile_arn)) > 0
      && !can(regex("[<>]", var.ecr_signing_profile_arn))
      && can(regex("^arn:aws(-[a-z]+)?:signer:[a-z]{2}-[a-z]+-[0-9]{1}:[0-9]{12}:/signing-profiles/[A-Za-z0-9_+=,.@-]+$", trimspace(var.ecr_signing_profile_arn)))
    )
    error_message = "ecr_signing_profile_arn must be a concrete AWS Signer profile ARN, not a placeholder."
  }
}

variable "ecs_cpu" {
  description = "Fargate CPU units for the prover task definition"
  type        = number
  default     = 16384
}

variable "ecs_memory" {
  description = "Fargate memory (MiB) for the prover task definition"
  type        = number
  default     = 32768
}

variable "s3_proof_prefix" {
  description = "Prefix inside the proof bundle bucket for verifier artifacts"
  type        = string
  default     = "sessions/"

  validation {
    condition     = var.s3_proof_prefix == "" || can(regex("/$", var.s3_proof_prefix))
    error_message = "s3_proof_prefix must be empty or end with a trailing slash (e.g., \"sessions/\")."
  }
}

variable "s3_cors_allowed_origins" {
  description = "Allowed origins for S3 proof bundle CORS (empty disables CORS configuration)"
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.s3_cors_allowed_origins :
      length(trimspace(origin)) > 0
      && !can(regex("[<>]", origin))
      && can(regex("^https?://[^\\s,]+$", trimspace(origin)))
    ])
    error_message = "s3_cors_allowed_origins entries must be concrete HTTP(S) origins without placeholders."
  }
}

variable "finalize_callback_lambda_arn" {
  description = "ARN of the finalize-callback-runner Lambda (Amplify backend)"
  type        = string

  validation {
    condition = (
      length(trimspace(var.finalize_callback_lambda_arn)) > 0
      && !can(regex("[<>]", var.finalize_callback_lambda_arn))
      && can(regex("^arn:aws(-[a-z]+)?:lambda:[a-z]{2}-[a-z]+-[0-9]{1}:[0-9]{12}:function:[A-Za-z0-9-_]+(:[A-Za-z0-9-_]+)?$", trimspace(var.finalize_callback_lambda_arn)))
    )
    error_message = "finalize_callback_lambda_arn must be a concrete Lambda function ARN, not a placeholder."
  }
}

variable "codebuild_source_location" {
  description = "CodeBuild source location (e.g., public GitHub repository URL)"
  type        = string

  validation {
    condition = (
      length(trimspace(var.codebuild_source_location)) > 0
      && !can(regex("[<>]", var.codebuild_source_location))
      && can(regex("^https://github\\.com/[^\\s/]+/[^\\s/]+(\\.git)?$", trimspace(var.codebuild_source_location)))
    )
    error_message = "codebuild_source_location must be a concrete GitHub HTTPS repository URL, not a placeholder."
  }
}

variable "codestar_connection_arn" {
  description = "ARN of the CodeStar connection for GitHub access"
  type        = string
  default     = ""

  validation {
    condition = (
      length(trimspace(var.codestar_connection_arn)) > 0
      && !can(regex("[<>]", var.codestar_connection_arn))
      && can(regex("^arn:aws(-[a-z]+)?:codestar-connections:[a-z]{2}-[a-z]+-[0-9]{1}:[0-9]{12}:connection/[0-9A-Fa-f-]+$", trimspace(var.codestar_connection_arn)))
    )
    error_message = "codestar_connection_arn must be a concrete CodeStar connection ARN, not a placeholder."
  }
}

# 将来のリソース実装用の変数
# 今後のフェーズで以下の変数を追加予定:
# - amplify_graphql_api_arn
# - amplify_data_endpoint
# - vpc_cidr
# - availability_zones
# - etc.
