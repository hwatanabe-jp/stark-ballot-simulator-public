resource "terraform_data" "execution_principal_guard" {
  input = data.aws_caller_identity.current.arn

  lifecycle {
    precondition {
      condition = can(regex(
        local.required_terraform_principal_arn_pattern,
        data.aws_caller_identity.current.arn,
      ))
      error_message = "Terraform must run as the terraform-admin aws-vault role. Current caller ARN: ${data.aws_caller_identity.current.arn}"
    }
  }
}
