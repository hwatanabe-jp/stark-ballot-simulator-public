resource "terraform_data" "bootstrap_apply_authorization_propagation" {
  count = local.pipeline_enabled ? 1 : 0

  triggers_replace = {
    bootstrap_boundary_policy_sha256 = sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_deploy_permissions_boundary[0].json
    )))
    bootstrap_policy_admin_sha256 = local.app_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.terraform_apply_app_lane_policy_admin[0].json
    ))) : "app-pipeline-disabled"
    app_lane_pipeline_management_policy_sha256 = local.app_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_apply_app_lane_pipeline_management[0].json
    ))) : "app-pipeline-disabled"
    app_lane_iam_management_policy_sha256 = local.app_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_apply_app_lane_iam_management[0].json
    ))) : "app-pipeline-disabled"
    app_lane_role_attachment_management_policy_sha256 = local.app_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_apply_app_lane_role_attachment_management[0].json
    ))) : "app-pipeline-disabled"
    foundation_lane_iam_management_policy_sha256 = local.foundation_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_apply_foundation_lane_iam_management[0].json
    ))) : "foundation-pipeline-disabled"
    bootstrap_smoke_role_policy_sha256 = sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.terraform_apply_smoke_role_bootstrap[0].json
    )))
  }

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.terraform_apply_app_lane_policy_admin,
    aws_iam_role_policy_attachment.terraform_apply_app_lane_policy_admin,
    aws_iam_policy.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_policy.bootstrap_apply_app_lane_iam_management,
    aws_iam_policy.bootstrap_apply_app_lane_role_attachment_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
    aws_iam_policy.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy.terraform_apply_smoke_role_bootstrap,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.bootstrap_deploy_permissions_boundary,
      aws_iam_policy.terraform_apply_app_lane_policy_admin,
      aws_iam_role_policy_attachment.terraform_apply_app_lane_policy_admin,
      aws_iam_policy.bootstrap_apply_app_lane_pipeline_management,
      aws_iam_policy.bootstrap_apply_app_lane_iam_management,
      aws_iam_policy.bootstrap_apply_app_lane_role_attachment_management,
      aws_iam_role_policy_attachment.bootstrap_apply_app_lane_pipeline_management,
      aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
      aws_iam_role_policy_attachment.bootstrap_apply_app_lane_role_attachment_management,
      aws_iam_policy.bootstrap_apply_foundation_lane_iam_management,
      aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
      aws_iam_role_policy.terraform_apply_smoke_role_bootstrap,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}

resource "terraform_data" "terraform_baseline_authority_storage_authorization_propagation" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  triggers_replace = {
    storage_management_policy_sha256 = sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.terraform_baseline_authority_storage_management[0].json
    )))
  }

  depends_on = [
    aws_iam_policy.terraform_baseline_authority_management,
    aws_iam_role_policy_attachment.terraform_baseline_authority_management,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.terraform_baseline_authority_management,
      aws_iam_role_policy_attachment.terraform_baseline_authority_management,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}

resource "terraform_data" "terraform_report_only_execution_authorization_propagation" {
  count = local.terraform_drift_enabled ? 1 : 0

  triggers_replace = {
    report_only_authorization_sha256 = sha256(jsonencode({
      codebuildTrust = jsondecode(data.aws_iam_policy_document.codebuild_assume_role[0].json)
      runners = {
        boundaries = {
          for root, document in data.aws_iam_policy_document.terraform_drift_runner_boundary :
          root => jsondecode(document.json)
        }
        identities = {
          for root, documents in local.terraform_drift_runner_identity_policy_documents :
          root => [for document in documents : jsondecode(document)]
        }
      }
      coordinator = {
        core = jsondecode(data.aws_iam_policy_document.terraform_drift_coordinator[0].json)
        guardrails = {
          for responsibility, document in data.aws_iam_policy_document.terraform_drift_coordinator_guardrail :
          responsibility => jsondecode(document.json)
        }
      }
      readiness = {
        for kind in keys(local.rollback_recovery_readiness_configuration) : kind => {
          trust    = jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_assume_role[kind].json)
          boundary = jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_boundary[kind].json)
          identity = jsondecode(data.aws_iam_policy_document.rollback_recovery_readiness_combined[kind].json)
        }
      }
      schedule = {
        trust    = jsondecode(data.aws_iam_policy_document.terraform_drift_schedule_assume_role[0].json)
        identity = jsondecode(data.aws_iam_policy_document.terraform_drift_schedule[0].json)
      }
    }))
  }

  depends_on = [
    module.terraform_drift_codebuild_log_groups,
    aws_iam_policy.terraform_drift_runner_boundary,
    aws_iam_role.terraform_drift_runner,
    aws_iam_policy.terraform_drift_runner_bootstrap_provider,
    aws_iam_policy.terraform_drift_runner_app_provider,
    aws_iam_role_policy.terraform_drift_coordinator,
    aws_iam_role.terraform_drift_coordinator,
    aws_iam_policy.terraform_drift_coordinator_guardrail,
    aws_iam_role_policy_attachment.terraform_drift_coordinator_guardrail,
    aws_iam_role_policy.terraform_drift_runner,
    aws_iam_role_policy.terraform_drift_runner_bootstrap_exact,
    aws_iam_role_policy_attachment.terraform_drift_runner_bootstrap_provider,
    aws_iam_role_policy.terraform_drift_runner_foundation_provider,
    aws_iam_role_policy.terraform_drift_runner_foundation_exact,
    aws_iam_role_policy.terraform_drift_runner_app_sensitive,
    aws_iam_role_policy_attachment.terraform_drift_runner_app_provider,
    aws_iam_policy.rollback_recovery_readiness_boundary,
    aws_iam_policy.rollback_recovery_readiness_core,
    aws_iam_policy.rollback_recovery_readiness_sensitive,
    aws_iam_role.rollback_recovery_readiness,
    aws_iam_role_policy.rollback_recovery_readiness_provider,
    aws_iam_role_policy_attachment.rollback_recovery_readiness_core,
    aws_iam_role_policy_attachment.rollback_recovery_readiness_sensitive,
    aws_iam_role.terraform_drift_schedule,
    aws_iam_role_policy.terraform_drift_schedule,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.terraform_drift_runner_boundary,
      aws_iam_role.terraform_drift_runner,
      aws_iam_policy.terraform_drift_runner_bootstrap_provider,
      aws_iam_policy.terraform_drift_runner_app_provider,
      aws_iam_role_policy.terraform_drift_coordinator,
      aws_iam_role.terraform_drift_coordinator,
      aws_iam_policy.terraform_drift_coordinator_guardrail,
      aws_iam_role_policy_attachment.terraform_drift_coordinator_guardrail,
      aws_iam_role_policy.terraform_drift_runner,
      aws_iam_role_policy.terraform_drift_runner_bootstrap_exact,
      aws_iam_role_policy_attachment.terraform_drift_runner_bootstrap_provider,
      aws_iam_role_policy.terraform_drift_runner_foundation_provider,
      aws_iam_role_policy.terraform_drift_runner_foundation_exact,
      aws_iam_role_policy.terraform_drift_runner_app_sensitive,
      aws_iam_role_policy_attachment.terraform_drift_runner_app_provider,
      aws_iam_policy.rollback_recovery_readiness_boundary,
      aws_iam_policy.rollback_recovery_readiness_core,
      aws_iam_policy.rollback_recovery_readiness_sensitive,
      aws_iam_role.rollback_recovery_readiness,
      aws_iam_role_policy.rollback_recovery_readiness_provider,
      aws_iam_role_policy_attachment.rollback_recovery_readiness_core,
      aws_iam_role_policy_attachment.rollback_recovery_readiness_sensitive,
      aws_iam_role.terraform_drift_schedule,
      aws_iam_role_policy.terraform_drift_schedule,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}
