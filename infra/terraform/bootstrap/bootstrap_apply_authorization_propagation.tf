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
    foundation_lane_pipeline_management_policy_sha256 = local.foundation_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_apply_foundation_lane_pipeline_management[0].json
    ))) : "foundation-pipeline-disabled"
    foundation_lane_artifacts_management_policy_sha256 = local.foundation_pipeline_enabled ? sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.bootstrap_apply_foundation_lane_artifacts_management[0].json
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
    aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
    aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
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
      aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management,
      aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
      aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management,
      aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
      aws_iam_role_policy.terraform_apply_smoke_role_bootstrap,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }

  provisioner "local-exec" {
    when        = destroy
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
    artifact_management_policy_sha256 = sha256(jsonencode(jsondecode(
      data.aws_iam_policy_document.terraform_apply_artifact_management[0].json
    )))
  }

  depends_on = [
    aws_iam_policy.terraform_baseline_authority_management,
    aws_iam_role_policy_attachment.terraform_baseline_authority_management,
    aws_iam_policy.terraform_apply_artifact_management,
    aws_iam_role_policy_attachment.terraform_apply_artifact_management,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.terraform_baseline_authority_management,
      aws_iam_role_policy_attachment.terraform_baseline_authority_management,
      aws_iam_policy.terraform_apply_artifact_management,
      aws_iam_role_policy_attachment.terraform_apply_artifact_management,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}

resource "terraform_data" "terraform_acceptance_publication_authorization_propagation" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  triggers_replace = {
    publication_authorization_sha256 = sha256(jsonencode({
      bootstrap = {
        callerBoundary = jsondecode(
          data.aws_iam_policy_document.bootstrap_deploy_permissions_boundary[0].json
        )
        callerIdentity = jsondecode(
          data.aws_iam_policy_document.terraform_smoke[0].json
        )
        publisherTrust = jsondecode(
          data.aws_iam_policy_document.bootstrap_terraform_acceptance_publisher_assume_role[0].json
        )
        publisherIdentity = jsondecode(
          data.aws_iam_policy_document.terraform_baseline_publisher["bootstrap"].json
        )
      }
      foundation = {
        callerBoundary = jsondecode(
          data.aws_iam_policy_document.foundation_smoke_deploy_permissions_boundary[0].json
        )
        callerIdentity = jsondecode(
          data.aws_iam_policy_document.foundation_terraform_smoke[0].json
        )
        publisherTrust = jsondecode(
          data.aws_iam_policy_document.foundation_terraform_acceptance_publisher_assume_role[0].json
        )
        publisherIdentity = jsondecode(
          data.aws_iam_policy_document.terraform_baseline_publisher["foundation"].json
        )
      }
      app = {
        appSmokeTrust = jsondecode(
          data.aws_iam_policy_document.codebuild_assume_role[0].json
        )
        appSmokeBoundary = jsondecode(
          data.aws_iam_policy_document.app_smoke_deploy_permissions_boundary[0].json
        )
        appSmokeIdentity = jsondecode(
          data.aws_iam_policy_document.app_terraform_smoke[0].json
        )
        appSmokeCommonIdentity = {
          policyArn = local.app_codebuild_common_policy_arn
          policy = jsondecode(
            data.aws_iam_policy_document.app_codebuild_common[0].json
          )
        }
        publisherTrust = jsondecode(
          data.aws_iam_policy_document.app_acceptance_publisher_assume_role[0].json
        )
        publisherBoundary = jsondecode(
          data.aws_iam_policy_document.app_acceptance_publisher_boundary[0].json
        )
        publisherIdentity = jsondecode(
          data.aws_iam_policy_document.app_acceptance_publisher[0].json
        )
        statusPublisherTrust = jsondecode(
          data.aws_iam_policy_document.codebuild_assume_role[0].json
        )
        statusPublisherBoundary = jsondecode(
          data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json
        )
        statusPublisherIdentity = jsondecode(
          data.aws_iam_policy_document.app_deployment_status_publisher[0].json
        )
        retainedKeyPolicy = jsondecode(
          data.aws_iam_policy_document.app_artifact_kms_key[0].json
        )
        retainedBucketPolicy = jsondecode(
          data.aws_iam_policy_document.app_pipeline_artifacts_bucket[0].json
        )
      }
      keyPolicy = jsondecode(
        data.aws_iam_policy_document.terraform_authority_key[0].json
      )
      bucketPolicy = jsondecode(
        data.aws_iam_policy_document.terraform_authority_bucket[0].json
      )
    }))
  }

  depends_on = [
    aws_iam_role.bootstrap_terraform_acceptance_publisher,
    aws_iam_role.foundation_terraform_acceptance_publisher,
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_role_policy.terraform_smoke,
    aws_iam_role_policy.foundation_terraform_smoke,
    aws_iam_role_policy.terraform_baseline_publisher,
    aws_iam_policy.foundation_smoke_deploy_permissions_boundary,
    aws_iam_role.app_terraform_smoke,
    aws_iam_policy.app_smoke_deploy_permissions_boundary,
    aws_iam_policy.app_codebuild_common,
    aws_iam_role_policy_attachment.app_codebuild_common_smoke,
    aws_iam_role_policy.app_terraform_smoke,
    aws_iam_role.app_acceptance_publisher,
    aws_iam_policy.app_acceptance_publisher_boundary,
    aws_iam_role_policy.app_acceptance_publisher,
    aws_iam_role.app_deployment_status_publisher,
    aws_iam_policy.app_deploy_permissions_boundary,
    aws_iam_role_policy.app_deployment_status_publisher,
    aws_kms_key.app_pipeline_artifacts,
    aws_s3_bucket_policy.app_pipeline_artifacts,
    aws_kms_key.terraform_authority,
    aws_s3_bucket_policy.terraform_authority,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_role.bootstrap_terraform_acceptance_publisher,
      aws_iam_role.foundation_terraform_acceptance_publisher,
      aws_iam_policy.bootstrap_deploy_permissions_boundary,
      aws_iam_role_policy.terraform_smoke,
      aws_iam_role_policy.foundation_terraform_smoke,
      aws_iam_role_policy.terraform_baseline_publisher,
      aws_iam_policy.foundation_smoke_deploy_permissions_boundary,
      aws_iam_role.app_terraform_smoke,
      aws_iam_policy.app_smoke_deploy_permissions_boundary,
      aws_iam_policy.app_codebuild_common,
      aws_iam_role_policy_attachment.app_codebuild_common_smoke,
      aws_iam_role_policy.app_terraform_smoke,
      aws_iam_role.app_acceptance_publisher,
      aws_iam_policy.app_acceptance_publisher_boundary,
      aws_iam_role_policy.app_acceptance_publisher,
      aws_iam_role.app_deployment_status_publisher,
      aws_iam_policy.app_deploy_permissions_boundary,
      aws_iam_role_policy.app_deployment_status_publisher,
      aws_kms_key.app_pipeline_artifacts,
      aws_s3_bucket_policy.app_pipeline_artifacts,
      aws_kms_key.terraform_authority,
      aws_s3_bucket_policy.terraform_authority,
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
      onDemand = {
        trust    = jsondecode(data.aws_iam_policy_document.terraform_drift_on_demand_assume_role[0].json)
        identity = jsondecode(data.aws_iam_policy_document.terraform_drift_on_demand_start[0].json)
        guardrails = {
          for responsibility, document in data.aws_iam_policy_document.terraform_drift_coordinator_guardrail :
          responsibility => jsondecode(document.json)
        }
      }
    }))
  }

  depends_on = [
    module.terraform_drift_codebuild_log_groups,
    aws_iam_policy.terraform_drift_runner_boundary,
    aws_iam_role.terraform_drift_runner,
    aws_iam_policy.terraform_drift_runner_bootstrap_provider,
    aws_iam_policy.terraform_drift_runner_app_provider,
    aws_iam_role.terraform_drift_on_demand,
    aws_iam_role_policy.terraform_drift_on_demand_start,
    aws_iam_policy.terraform_drift_coordinator_guardrail,
    aws_iam_role_policy_attachment.terraform_drift_on_demand_guardrail,
    aws_iam_role_policy.terraform_drift_runner,
    aws_iam_role_policy_attachment.terraform_drift_runner_bootstrap_provider,
    aws_iam_role_policy.terraform_drift_runner_foundation_provider,
    aws_iam_role_policy.terraform_drift_runner_foundation_exact,
    aws_iam_role_policy.terraform_drift_runner_app_sensitive,
    aws_iam_role_policy_attachment.terraform_drift_runner_app_provider,
  ]

  lifecycle {
    replace_triggered_by = [
      aws_iam_policy.terraform_drift_runner_boundary,
      aws_iam_role.terraform_drift_runner,
      aws_iam_policy.terraform_drift_runner_bootstrap_provider,
      aws_iam_policy.terraform_drift_runner_app_provider,
      aws_iam_role.terraform_drift_on_demand,
      aws_iam_role_policy.terraform_drift_on_demand_start,
      aws_iam_policy.terraform_drift_coordinator_guardrail,
      aws_iam_role_policy_attachment.terraform_drift_on_demand_guardrail,
      aws_iam_role_policy.terraform_drift_runner,
      aws_iam_role_policy_attachment.terraform_drift_runner_bootstrap_provider,
      aws_iam_role_policy.terraform_drift_runner_foundation_provider,
      aws_iam_role_policy.terraform_drift_runner_foundation_exact,
      aws_iam_role_policy.terraform_drift_runner_app_sensitive,
      aws_iam_role_policy_attachment.terraform_drift_runner_app_provider,
    ]
  }

  provisioner "local-exec" {
    command     = "sleep 30"
    interpreter = ["/bin/sh", "-c"]
  }
}
