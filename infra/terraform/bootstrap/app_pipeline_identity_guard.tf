resource "terraform_data" "development_app_pipeline_identity_guard" {
  input = "${var.account_alias}/${var.deployment_environment}/app:${var.source_branch}"

  lifecycle {
    precondition {
      condition     = local.app_pipeline_identity_approved
      error_message = "enable_development_app_pipeline=true is approved only with the stark-dev/develop/bootstrap pipeline from source_branch=develop."
    }
  }
}
