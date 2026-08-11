resource "aws_signer_signing_profile" "ecr" {
  name        = local.ecr_signing_profile_name
  platform_id = "Notation-OCI-SHA384-ECDSA"

  tags = local.common_tags
}

locals {
  ecr_signing_configuration = {
    rules = [{
      signingProfileArn = aws_signer_signing_profile.ecr.arn
      repositoryFilters = [
        for repository_name in local.ecr_signing_repository_filters : {
          filter     = repository_name
          filterType = "WILDCARD_MATCH"
        }
      ]
    }]
  }
}

resource "terraform_data" "ecr_signing_configuration" {
  input = {
    aws_region            = var.aws_region
    signing_configuration = jsonencode(local.ecr_signing_configuration)
  }

  triggers_replace = [
    aws_signer_signing_profile.ecr.arn,
    sha256(jsonencode(local.ecr_signing_repository_filters)),
  ]

  lifecycle {
    precondition {
      condition     = local.deployment_target_inputs_exact
      error_message = "Foundation inputs must match the exact reviewed stark-dev/develop target and lane configuration."
    }
  }

  provisioner "local-exec" {
    command = "aws ecr put-signing-configuration --region ${self.input.aws_region} --signing-configuration '${self.input.signing_configuration}' --output json --no-cli-pager"
  }

  depends_on = [
    aws_ecr_repository.prover,
  ]
}
