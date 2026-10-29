resource "terraform_data" "development_app_pipeline_identity_guard" {
  input = {
    state_identity       = local.app_lane_authority.stateIdentity
    source_branch        = local.deployment_target.sourceBranch
    status_source_type   = "GITHUB"
    status_artifact_type = "NO_ARTIFACTS"
  }

  lifecycle {
    precondition {
      condition     = local.app_pipeline_identity_approved
      error_message = "enable_development_app_pipeline=true is approved only with the ${local.bootstrap_lane_authority.stateIdentity} pipeline from source_branch=${local.deployment_target.sourceBranch}."
    }
  }
}
