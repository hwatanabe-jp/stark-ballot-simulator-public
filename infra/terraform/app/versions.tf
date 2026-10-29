terraform {
  required_version = "= 1.17.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.70.0"
    }
  }
}

provider "aws" {
  region              = local.deployment_target.region
  allowed_account_ids = [local.deployment_target.accountId]
}
