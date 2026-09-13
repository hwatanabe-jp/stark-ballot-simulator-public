locals {
  app_retained_artifact_bucket_name  = local.deployment_shared_names.appRetainedArtifactBucket
  app_runtime_name_prefix            = local.deployment_shared_names.runtimeNamePrefix
  app_signature_runtime_name_prefix  = local.deployment_shared_names.signatureRuntimeNamePrefix
  app_signature_verifier_lambda_name = local.deployment_shared_names.signatureVerifierFunction
  app_signature_verifier_role_name   = "${local.app_signature_runtime_name_prefix}-image-signature-verifier-role"
  app_target_lambda_event_source_mapping_arn_pattern = (
    "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:event-source-mapping:*"
  )
  app_target_lambda_version_inventory_arns = [
    local.app_target_lambda_arn_pattern,
    local.app_signature_verifier_lambda_arn,
  ]
  app_target_lambda_arn_pattern = (
    "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.app_runtime_name_prefix}-*"
  )
  app_signature_verifier_role_arn = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_verifier_role_name}"
  )
  app_target_application_log_group_resource_arns = [
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/*/${local.app_runtime_name_prefix}-*",
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/*/${local.app_runtime_name_prefix}-*:*",
  ]
  app_target_all_log_group_resource_arns = concat(local.app_target_application_log_group_resource_arns, [
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.app_signature_verifier_lambda_name}",
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${local.app_signature_verifier_lambda_name}:*",
  ])
  app_target_proof_bucket_name    = local.deployment_shared_names.proofBucket
  app_target_proof_bucket_arn     = "arn:aws:s3:::${local.app_target_proof_bucket_name}"
  app_target_frontend_bucket_name = local.deployment_shared_names.frontendBucket
  app_target_frontend_bucket_arn  = "arn:aws:s3:::${local.app_target_frontend_bucket_name}"
  app_target_cloudfront_distribution_arn = (
    "arn:aws:cloudfront::${var.aws_account_id}:distribution/*"
  )
  app_target_cloudfront_read_resource_arns = [
    local.app_target_cloudfront_distribution_arn,
    "arn:aws:cloudfront::${var.aws_account_id}:cache-policy/*",
    "arn:aws:cloudfront::${var.aws_account_id}:function/${local.app_runtime_name_prefix}-*",
    "arn:aws:cloudfront::${var.aws_account_id}:origin-access-control/*",
    "arn:aws:cloudfront::${var.aws_account_id}:origin-request-policy/*",
    "arn:aws:cloudfront::${var.aws_account_id}:response-headers-policy/*",
  ]
  app_target_queue_arn = "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.app_runtime_name_prefix}-prover-work"
  app_target_async_queue_arns = [
    local.app_target_queue_arn,
    "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.app_runtime_name_prefix}-prover-work-dlq",
    "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.app_runtime_name_prefix}-verification-work",
    "arn:aws:sqs:${var.aws_region}:${var.aws_account_id}:${local.app_runtime_name_prefix}-verification-work-dlq",
  ]
  app_target_state_machine_arn     = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.app_runtime_name_prefix}-finalization"
  app_target_execution_status_rule = "${local.app_runtime_name_prefix}-sem-janitor-exec"
  app_target_sweep_rule            = "${local.app_runtime_name_prefix}-semaphore-janitor-sweep"
  app_target_ops_ledger_rule_names = [
    "${local.app_runtime_name_prefix}-ops-alarm-changed",
    "${local.app_runtime_name_prefix}-ops-deploy-accepted",
    "${local.app_runtime_name_prefix}-ops-ecs-stopped",
    "${local.app_runtime_name_prefix}-ops-pipeline-changed",
  ]
  app_target_actionable_rule_names = [
    "${local.app_runtime_name_prefix}-action-dlq-prover",
    "${local.app_runtime_name_prefix}-action-dlq-verification",
    "${local.app_runtime_name_prefix}-action-age-prover",
    "${local.app_runtime_name_prefix}-action-age-verification",
    "${local.app_runtime_name_prefix}-action-api-5xx",
    "${local.app_runtime_name_prefix}-action-pipeline-failed",
  ]
  app_target_event_rule_arns = concat(
    [
      "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.app_target_execution_status_rule}",
      "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.app_target_sweep_rule}",
    ],
    [
      for name in local.app_target_ops_ledger_rule_names :
      "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${name}"
    ],
    [
      for name in local.app_target_actionable_rule_names :
      "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${name}"
    ],
  )
  app_target_prover_semaphore_table_name = "${local.app_runtime_name_prefix}-prover-semaphore"
  app_target_prover_semaphore_lock_name  = "prover-fargate"
  app_target_prover_semaphore_table_arn = (
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_target_prover_semaphore_table_name}"
  )
  app_target_ecs_cluster_arn = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/${local.app_runtime_name_prefix}-prover"
  app_target_ecs_task_definition_arn = (
    "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${local.app_runtime_name_prefix}-prover:*"
  )
  app_target_runtime_role_arn_pattern = (
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_runtime_name_prefix}-*"
  )
  app_target_runtime_role_resource_arns = [
    local.app_target_runtime_role_arn_pattern,
    local.app_signature_verifier_role_arn,
  ]
  app_target_api_arns = [
    "arn:aws:apigateway:${var.aws_region}::/apis",
    "arn:aws:apigateway:${var.aws_region}::/apis/*",
  ]
  app_target_api_tagging_arns = [
    "arn:aws:apigateway:${var.aws_region}::/tags/arn%3Aaws%3Aapigateway%3A${var.aws_region}%3A%3A%2Fv2%2Fapis%2F*",
  ]
  app_data_kms_key_arn_pattern = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"
  app_dynamodb_table_arn_pattern = (
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-*"
  )
  app_dynamodb_index_arn_pattern = (
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-*/index/*"
  )
  app_cloudwatch_alarm_arns = [
    "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${local.app_runtime_name_prefix}-*",
  ]
  app_observability_dashboard_name = "${local.app_runtime_name_prefix}-observability"
  app_observability_dashboard_arn  = "arn:aws:cloudwatch::${var.aws_account_id}:dashboard/${local.app_observability_dashboard_name}"
  app_invariant_sns_topic_name     = "${local.app_runtime_name_prefix}-verification-invariant-alerts"
  app_invariant_sns_topic_arn = (
    "arn:aws:sns:${var.aws_region}:${var.aws_account_id}:${local.app_invariant_sns_topic_name}"
  )
  app_actionable_sns_topic_name = "${local.app_runtime_name_prefix}-ops-actionable"
  app_actionable_sns_topic_arn = (
    "arn:aws:sns:${var.aws_region}:${var.aws_account_id}:${local.app_actionable_sns_topic_name}"
  )
  app_observability_sns_topic_arns = [
    local.app_invariant_sns_topic_arn,
    local.app_actionable_sns_topic_arn,
  ]
  app_invariant_email_parameter_path = (
    "/${local.deployment_target.stateNamespace}/observability/invariant-email"
  )
  app_invariant_email_parameter_name = "${local.app_invariant_email_parameter_path}/endpoint"
  app_invariant_email_parameter_arn = (
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.app_invariant_email_parameter_name}"
  )
  app_invariant_email_parameter_path_arn = (
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.app_invariant_email_parameter_path}"
  )
  app_invariant_email_parameter_children_arn = (
    "${local.app_invariant_email_parameter_path_arn}/*"
  )
  app_actionable_email_parameter_path = (
    "/${local.deployment_target.stateNamespace}/observability/ops-actionable-email"
  )
  app_actionable_email_parameter_name = "${local.app_actionable_email_parameter_path}/endpoint"
  app_actionable_email_parameter_arn = (
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.app_actionable_email_parameter_name}"
  )
  app_actionable_email_parameter_path_arn = (
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.app_actionable_email_parameter_path}"
  )
  app_actionable_email_parameter_children_arn = (
    "${local.app_actionable_email_parameter_path_arn}/*"
  )
  app_observability_email_parameter_path_arns = [
    local.app_invariant_email_parameter_path_arn,
    local.app_actionable_email_parameter_path_arn,
  ]
  app_observability_email_parameter_children_arns = [
    local.app_invariant_email_parameter_children_arn,
    local.app_actionable_email_parameter_children_arn,
  ]
  app_observability_email_parameter_arns = [
    local.app_invariant_email_parameter_arn,
    local.app_actionable_email_parameter_arn,
  ]
  app_runtime_ssm_parameter_arn = (
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${trimsuffix(local.deployment_shared_names.runtimeConfigReferencePrefix, "/config")}/*"
  )
  app_expected_origin_verify_header_secret_arn = (
    "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.deployment_shared_names.runtimeSecretReferencePrefix}/expected-origin-verify-header-*"
  )
  app_log_ip_hash_salt_secret_arn = (
    "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.deployment_shared_names.runtimeSecretReferencePrefix}/log-ip-hash-salt-*"
  )
  app_signature_verifier_execution_boundary_policy_name = (
    "${var.project_name}-image-signature-verifier-boundary-${var.account_alias}-${var.deployment_environment}"
  )
  app_signature_verifier_execution_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_signature_verifier_execution_boundary_policy_name}"
  )
  app_retained_artifact_bucket_arn = "arn:aws:s3:::${local.app_retained_artifact_bucket_name}"
  app_signature_verifier_lambda_arn = (
    "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${local.app_signature_verifier_lambda_name}"
  )
  app_signature_verifier_alias_arns = [
    local.app_signature_verifier_lambda_arn,
    "${local.app_signature_verifier_lambda_arn}:preflight",
    "${local.app_signature_verifier_lambda_arn}:runtime",
  ]
  app_pipeline_enabled                      = var.enable_development_app_pipeline
  app_static_fast_available                 = local.static_fast_lane_authority != null
  app_static_fast_enabled                   = local.app_pipeline_enabled && local.app_static_fast_available
  app_pipeline_name                         = local.app_lane_authority.names.pipeline
  app_pipeline_role_name                    = local.app_lane_authority.names.pipelineRole
  app_acceptance_publisher_role_name        = local.deployment_shared_names.appAcceptancePublisherRole
  app_acceptance_publisher_role_arn         = "arn:aws:iam::${var.aws_account_id}:role/${local.app_acceptance_publisher_role_name}"
  app_execution_authority_role_name         = local.deployment_shared_names.appExecutionAuthorityRole
  app_terraform_plan_role_name              = local.app_lane_authority.names.terraformPlanRole
  app_terraform_apply_role_name             = local.app_lane_authority.names.terraformApplyRole
  app_signature_preflight_plan_role_name    = local.deployment_shared_names.appSignaturePreflightPlanRole
  app_signature_preflight_apply_role_name   = local.deployment_shared_names.appSignaturePreflightApplyRole
  app_signature_preflight_invoker_role_name = local.deployment_shared_names.appSignaturePreflightInvokerRole
  app_static_deploy_role_name               = local.deployment_shared_names.appStaticDeployRole
  app_static_fast_static_deploy_role_name   = local.app_static_fast_available ? local.deployment_shared_names.appStaticFastDeployRole : null
  app_terraform_smoke_role_name             = local.app_lane_authority.names.terraformSmokeRole
  app_static_fast_pipeline_role_name        = local.app_static_fast_available ? local.static_fast_lane_authority.names.pipelineRole : null
  app_static_fast_gate_and_build_role_name  = local.app_static_fast_available ? local.deployment_shared_names.appStaticFastGateRole : null
  app_static_fast_smoke_lite_role_name      = local.app_static_fast_available ? local.deployment_shared_names.appStaticFastSmokeRole : null
  app_github_trigger_role_name              = local.app_lane_authority.names.githubTriggerRole
  app_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-app-deploy-boundary-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_deploy_permissions_boundary_policy_name}"
  )
  app_apply_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-app-apply-deploy-boundary-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_apply_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_apply_deploy_permissions_boundary_policy_name}"
  )
  app_smoke_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-app-smoke-deploy-boundary-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_smoke_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_smoke_deploy_permissions_boundary_policy_name}"
  )
  app_acceptance_publisher_boundary_policy_name = (
    "sbs-app-acceptance-publisher-boundary-${var.account_alias}-${var.deployment_environment}"
  )
  app_acceptance_publisher_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_acceptance_publisher_boundary_policy_name}"
  )
  app_deploy_permissions_boundary_policy_arns = [
    local.app_deploy_permissions_boundary_policy_arn,
    local.app_apply_deploy_permissions_boundary_policy_arn,
    local.app_smoke_deploy_permissions_boundary_policy_arn,
    local.app_acceptance_publisher_boundary_policy_arn,
    local.app_signature_verifier_execution_boundary_policy_arn,
  ]
  app_codebuild_common_policy_name            = "${local.app_terraform_plan_role_name}-common"
  app_codebuild_common_policy_arn             = "arn:aws:iam::${var.aws_account_id}:policy/${local.app_codebuild_common_policy_name}"
  app_terraform_plan_runtime_policy_name      = "${local.app_terraform_plan_role_name}-runtime"
  app_terraform_apply_runtime_policy_name     = "${local.app_terraform_apply_role_name}-runtime"
  app_terraform_apply_runtime_kms_policy_name = "${local.app_terraform_apply_role_name}-runtime-kms"
  app_terraform_apply_events_policy_name      = "${local.app_terraform_apply_role_name}-events"
  app_terraform_apply_state_backend_policy_name = (
    "${local.app_terraform_apply_role_name}-state-backend"
  )
  app_deployment_managed_policy_arns = [
    local.app_codebuild_common_policy_arn,
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_plan_runtime_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_runtime_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_runtime_kms_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_events_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_state_backend_policy_name}",
  ]
  app_lane_pipeline_management_policy_name = (
    "${var.project_name}-bootstrap-app-lane-pipeline-${var.account_alias}-${var.deployment_environment}"
  )
  app_lane_iam_management_policy_name = (
    "${var.project_name}-bootstrap-app-lane-iam-${var.account_alias}-${var.deployment_environment}"
  )
  app_lane_role_attachment_management_policy_name = (
    "${var.project_name}-bootstrap-app-lane-role-attachments-${var.account_alias}-${var.deployment_environment}"
  )
  # Retained AWS identity repurposed in place for Terraform authority runtime
  # management; see bootstrap_managed_policy_moves.tf.
  app_lane_artifacts_management_policy_name = (
    "${var.project_name}-bootstrap-app-lane-artifacts-${var.account_alias}-${var.deployment_environment}"
  )
  app_lane_management_policy_arns = [
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_pipeline_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_iam_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_role_attachment_management_policy_name}",
  ]

  app_execution_authority_project_name        = local.deployment_shared_names.appExecutionAuthorityProject
  app_terraform_plan_project_name             = local.app_lane_authority.names.terraformPlanProject
  app_terraform_apply_project_name            = local.app_lane_authority.names.terraformApplyProject
  app_signature_preflight_plan_project_name   = local.deployment_shared_names.appSignaturePreflightPlanProject
  app_signature_preflight_apply_project_name  = local.deployment_shared_names.appSignaturePreflightApplyProject
  app_signature_preflight_invoke_project_name = local.deployment_shared_names.appSignaturePreflightInvokeProject
  app_static_deploy_project_name              = local.deployment_shared_names.appStaticDeployProject
  app_static_fast_static_deploy_project_name  = local.app_static_fast_available ? local.deployment_shared_names.appStaticFastDeployProject : null
  app_smoke_project_name                      = local.app_lane_authority.names.smokeProject
  app_static_fast_pipeline_name               = local.app_static_fast_available ? local.static_fast_lane_authority.names.pipeline : null
  app_static_fast_gate_project_name           = local.app_static_fast_available ? local.deployment_shared_names.appStaticFastGateProject : null
  app_static_fast_smoke_project_name          = local.app_static_fast_available ? local.deployment_shared_names.appStaticFastSmokeProject : null
  app_codebuild_project_names = compact([
    local.app_execution_authority_project_name,
    local.app_terraform_plan_project_name,
    local.app_terraform_apply_project_name,
    local.app_signature_preflight_plan_project_name,
    local.app_signature_preflight_apply_project_name,
    local.app_signature_preflight_invoke_project_name,
    local.app_static_deploy_project_name,
    local.app_static_fast_available ? local.app_static_fast_static_deploy_project_name : null,
    local.app_smoke_project_name,
    local.foundation_app_status_publisher_project_name,
    local.app_static_fast_available ? local.app_static_fast_gate_project_name : null,
    local.app_static_fast_available ? local.app_static_fast_smoke_project_name : null,
  ])
  app_codebuild_project_arns = [
    for name in local.app_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  app_pipeline_arn             = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.app_pipeline_name}"
  app_static_fast_pipeline_arn = local.app_static_fast_available ? "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.app_static_fast_pipeline_name}" : null
  app_codebuild_log_group_arn_by_project_name = {
    for name in local.app_codebuild_project_names :
    name => "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  }
  app_codebuild_log_group_arns = [
    for name in local.app_codebuild_project_names :
    local.app_codebuild_log_group_arn_by_project_name[name]
  ]
  app_pipeline_role_name_arns = compact([
    local.app_acceptance_publisher_role_arn,
    local.foundation_app_status_publisher_role_arn,
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_execution_authority_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_preflight_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_preflight_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_signature_preflight_invoker_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_deploy_role_name}",
    local.app_static_fast_available ? "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_static_deploy_role_name}" : null,
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_smoke_role_name}",
    local.app_static_fast_available ? "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_pipeline_role_name}" : null,
    local.app_static_fast_available ? "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_gate_and_build_role_name}" : null,
    local.app_static_fast_available ? "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_smoke_lite_role_name}" : null,
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_github_trigger_role_name}",
  ])
}
