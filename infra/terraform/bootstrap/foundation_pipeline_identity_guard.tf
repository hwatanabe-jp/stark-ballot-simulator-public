resource "terraform_data" "development_foundation_pipeline_identity_guard" {
  input = "${var.account_alias}/${var.deployment_environment}/foundation:${var.source_branch}"

  lifecycle {
    precondition {
      condition     = local.foundation_pipeline_identity_approved
      error_message = "enable_development_foundation_pipeline=true is approved only with the stark-dev/develop/bootstrap pipeline from source_branch=develop."
    }
  }
}
