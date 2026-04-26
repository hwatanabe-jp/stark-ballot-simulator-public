locals {
  vpc_cidr = "10.0.0.0/16"

  public_subnets = {
    apne1a = {
      cidr = "10.0.1.0/24"
      az   = "ap-northeast-1a"
    }
    apne1c = {
      cidr = "10.0.2.0/24"
      az   = "ap-northeast-1c"
    }
  }

  environment_settings = {
    develop = {
      s3_lifecycle_days  = 7
      log_retention_days = 7
    }
    main = {
      s3_lifecycle_days  = 30
      log_retention_days = 14
    }
  }

  cloudtrail_retention_days = 90
  enable_cloudtrail         = var.environment == "main"
  shared_log_retention_days = local.environment_settings["main"].log_retention_days

  proof_bundle_bucket_name = "stark-ballot-simulator-proof-bundles-${var.environment}"
  ecs_log_group_name       = "/aws/ecs/${var.project_name}-prover-${var.environment}"
  sfn_log_group_name       = "/aws/stepfunctions/${var.project_name}-prover-${var.environment}"
}

locals {
  current_environment_settings = try(local.environment_settings[var.environment], local.environment_settings["develop"])
  proof_bundle_bucket_arn      = "arn:aws:s3:::${local.proof_bundle_bucket_name}"
  account_id                   = data.aws_caller_identity.current.account_id
  partition                    = data.aws_partition.current.partition
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}
