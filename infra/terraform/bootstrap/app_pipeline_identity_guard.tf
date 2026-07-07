resource "terraform_data" "development_app_pipeline_identity_guard" {
  input = "${var.account_alias}/${var.deployment_environment}/app:${var.source_branch}"

  lifecycle {
    precondition {
      condition     = local.app_pipeline_identity_approved
      error_message = "enable_development_app_pipeline=true is approved only with the stark-dev/develop/bootstrap pipeline from source_branch=develop."
    }

    precondition {
      condition = (
        !var.enable_development_app_pipeline
        || (
          var.development_app_operator_gate_public_key_pem != null
          && trimspace(var.development_app_operator_gate_public_key_pem) != ""
        )
      )
      error_message = "enable_development_app_pipeline=true requires development_app_operator_gate_public_key_pem for the develop operator gate."
    }
  }
}
