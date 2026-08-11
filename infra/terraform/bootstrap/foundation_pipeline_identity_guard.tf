resource "terraform_data" "development_foundation_pipeline_identity_guard" {
  input = "${local.foundation_lane_authority.stateIdentity}:${local.deployment_target.sourceBranch}"

  lifecycle {
    precondition {
      condition     = local.foundation_pipeline_identity_approved
      error_message = "enable_development_foundation_pipeline=true is approved only with the ${local.bootstrap_lane_authority.stateIdentity} pipeline from source_branch=${local.deployment_target.sourceBranch}."
    }
  }
}
