locals {
  app_pipeline_enabled                            = var.enable_development_app_pipeline
  protected_production_app_source_branch          = "main"
  protected_production_app_account_alias          = "stark-prod"
  protected_production_app_deployment_environment = "main"
  protected_production_app_state_scope            = "app"
  protected_production_app_aws_account_id         = coalesce(var.protected_production_aws_account_id, "999999999999")
  app_pipeline_identity_approved = (
    var.enable_development_app_pipeline == false
    || (
      var.enable_development_pipeline
      && var.account_alias == "stark-dev"
      && var.deployment_environment == "develop"
      && var.state_scope == "bootstrap"
      && var.source_branch == "develop"
    )
  )

  app_pipeline_name = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-app"
  app_pipeline_artifact_bucket_name = coalesce(
    var.app_pipeline_artifact_bucket_name,
    "sbs-app-pipeline-artifacts-${var.account_alias}-${var.deployment_environment}-${var.aws_account_id}",
  )
  app_release_manifest_bucket_name = coalesce(
    var.foundation_release_manifest_bucket_name,
    "${var.project_name}-${var.account_alias}-${var.deployment_environment}-release-manifests",
  )
  app_artifact_kms_alias     = "alias/${local.app_pipeline_name}-artifacts"
  app_artifact_kms_alias_arn = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.app_artifact_kms_alias}"
  app_toolchain_accepted_pointer_object_arn = (
    "${local.app_release_manifest_bucket_arn}/channels/develop/toolchain/accepted.json"
  )
  app_prover_accepted_pointer_object_arn = (
    "${local.app_release_manifest_bucket_arn}/channels/develop/prover/accepted.json"
  )
  app_toolchain_artifact_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/artifacts/toolchain/*"
  )
  app_prover_release_records_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/artifacts/prover/*"
  )
  app_deployment_record_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/deployments/develop/*"
  )
  app_release_manifest_candidate_objects_arn = (
    "${local.app_release_manifest_bucket_arn}/release-candidates/develop/*"
  )

  app_pipeline_role_name = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-app"
  app_deployment_record_role_name = (
    "stark-ballot-sim-app-record-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_terraform_plan_role_name  = "stark-ballot-sim-tf-plan-${var.account_alias}-${var.deployment_environment}-app"
  app_terraform_apply_role_name = "stark-ballot-sim-tf-apply-${var.account_alias}-${var.deployment_environment}-app"
  app_static_deploy_role_name   = "stark-ballot-sim-static-deploy-${var.account_alias}-${var.deployment_environment}-app"
  app_terraform_smoke_role_name = "stark-ballot-sim-tf-smoke-${var.account_alias}-${var.deployment_environment}-app"
  app_static_fast_pipeline_role_name = (
    "${var.project_name}-static-fast-pipeline-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_static_fast_gate_and_build_role_name = (
    "stark-ballot-sim-static-fast-gate-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_static_fast_smoke_lite_role_name = (
    "stark-ballot-sim-static-fast-smoke-${var.account_alias}-${var.deployment_environment}-app"
  )
  app_github_trigger_role_name = "${var.project_name}-github-trigger-${var.account_alias}-${var.deployment_environment}-app"
  app_runtime_name_prefix      = "${var.project_name}-${var.account_alias}-${var.deployment_environment}"
  app_target_lambda_names = [
    "${local.app_runtime_name_prefix}-public-api",
    "${local.app_runtime_name_prefix}-finalization-writer",
    "${local.app_runtime_name_prefix}-proof-dispatcher",
    "${local.app_runtime_name_prefix}-verification-worker",
    "${local.app_runtime_name_prefix}-image-signature-gate",
    "${local.app_runtime_name_prefix}-semaphore-janitor",
  ]
  app_target_lambda_role_names = [
    "${local.app_runtime_name_prefix}-api-role",
    "${local.app_runtime_name_prefix}-finalizer-role",
    "${local.app_runtime_name_prefix}-dispatcher-role",
    "${local.app_runtime_name_prefix}-verifier-role",
    "${local.app_runtime_name_prefix}-image-gate-role",
    "${local.app_runtime_name_prefix}-janitor-role",
  ]
  app_target_lambda_arns = [
    for name in local.app_target_lambda_names :
    "arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${name}"
  ]
  app_target_lambda_role_arns = [
    for name in local.app_target_lambda_role_names :
    "arn:aws:iam::${var.aws_account_id}:role/${name}"
  ]
  app_target_log_group_arns = [
    for name in local.app_target_lambda_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${name}"
  ]
  app_target_prover_log_group_arn = (
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/ecs/${local.app_runtime_name_prefix}-prover"
  )
  app_target_sfn_log_group_arn = (
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/vendedlogs/states/${local.app_runtime_name_prefix}-finalization"
  )
  app_target_api_access_log_group_arn = (
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/apigateway/${local.app_runtime_name_prefix}-api/access"
  )
  app_target_all_log_group_arns = concat(
    local.app_target_log_group_arns,
    [
      local.app_target_prover_log_group_arn,
      local.app_target_sfn_log_group_arn,
      local.app_target_api_access_log_group_arn,
    ],
  )
  app_target_all_log_group_resource_arns = [
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/*/${local.app_runtime_name_prefix}-*",
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/*/${local.app_runtime_name_prefix}-*:*",
  ]
  app_target_proof_bucket_name    = "${local.app_runtime_name_prefix}-proof-artifacts"
  app_target_proof_bucket_arn     = "arn:aws:s3:::${local.app_target_proof_bucket_name}"
  app_target_frontend_bucket_name = "${local.app_runtime_name_prefix}-static-frontend"
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
  app_target_execution_arn         = "arn:aws:states:${var.aws_region}:${var.aws_account_id}:execution:${local.app_runtime_name_prefix}-finalization:*"
  app_target_execution_status_rule = "${local.app_runtime_name_prefix}-semaphore-janitor-execution"
  app_target_sweep_rule            = "${local.app_runtime_name_prefix}-semaphore-janitor-sweep"
  app_target_event_rule_arns = [
    "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.app_target_execution_status_rule}",
    "arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/${local.app_target_sweep_rule}",
  ]
  app_target_prover_semaphore_table_name = "${local.app_runtime_name_prefix}-prover-semaphore"
  app_target_prover_semaphore_table_arn = (
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_target_prover_semaphore_table_name}"
  )
  app_target_ecs_cluster_arn = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/${local.app_runtime_name_prefix}-prover"
  app_target_ecs_task_definition_arn = (
    "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${local.app_runtime_name_prefix}-prover:*"
  )
  app_target_ecs_role_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_runtime_name_prefix}-prover-execution",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_runtime_name_prefix}-prover-task",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_runtime_name_prefix}-target-sfn",
  ]
  app_target_runtime_role_arns = concat(local.app_target_lambda_role_arns, local.app_target_ecs_role_arns)
  app_target_api_arns = [
    "arn:aws:apigateway:${var.aws_region}::/apis",
    "arn:aws:apigateway:${var.aws_region}::/apis/*",
  ]
  app_target_api_tagging_arns = [
    "arn:aws:apigateway:${var.aws_region}::/tags/arn%3Aaws%3Aapigateway%3A${var.aws_region}%3A%3A%2Fv2%2Fapis%2F*",
  ]
  app_data_kms_alias           = "alias/${local.app_runtime_name_prefix}-app-data"
  app_data_kms_alias_arn       = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.app_data_kms_alias}"
  app_data_kms_key_arn_pattern = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"
  app_dynamodb_table_names = [
    "${local.app_runtime_name_prefix}-sessions",
    "${local.app_runtime_name_prefix}-votes",
    "${local.app_runtime_name_prefix}-rate-limit-events",
    "${local.app_runtime_name_prefix}-rate-limit-counters",
    "${local.app_runtime_name_prefix}-prover-semaphore",
  ]
  app_dynamodb_table_arns = [
    for name in local.app_dynamodb_table_names :
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${name}"
  ]
  app_dynamodb_index_arns = [
    "arn:aws:dynamodb:${var.aws_region}:${var.aws_account_id}:table/${local.app_runtime_name_prefix}-votes/index/*",
  ]
  app_cloudwatch_alarm_arns = [
    "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${local.app_runtime_name_prefix}-*"
  ]
  app_runtime_ssm_parameter_arn = (
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/*"
  )
  app_expected_origin_verify_header_secret_arn = (
    "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/secrets/expected-origin-verify-header-*"
  )
  app_browser_public_config_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/${var.project_name}/${var.account_alias}/${var.deployment_environment}/app/config/vite-turnstile-site-key",
  ]
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
  app_deploy_permissions_boundary_policy_arns = [
    local.app_deploy_permissions_boundary_policy_arn,
    local.app_apply_deploy_permissions_boundary_policy_arn,
    local.app_smoke_deploy_permissions_boundary_policy_arn,
  ]
  app_terraform_plan_runtime_policy_name      = "${local.app_terraform_plan_role_name}-runtime"
  app_terraform_apply_runtime_policy_name     = "${local.app_terraform_apply_role_name}-runtime"
  app_terraform_apply_runtime_kms_policy_name = "${local.app_terraform_apply_role_name}-runtime-kms"
  app_terraform_apply_state_backend_policy_name = (
    "${local.app_terraform_apply_role_name}-state-backend"
  )
  app_plan_managed_policy_arns = [
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_plan_runtime_policy_name}",
  ]
  app_deployment_managed_policy_arns = [
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_plan_runtime_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_runtime_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_terraform_apply_runtime_kms_policy_name}",
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
  app_lane_artifacts_management_policy_name = (
    "${var.project_name}-bootstrap-app-lane-artifacts-${var.account_alias}-${var.deployment_environment}"
  )
  app_lane_management_policy_arns = [
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_pipeline_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_iam_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_role_attachment_management_policy_name}",
    "arn:aws:iam::${var.aws_account_id}:policy/${local.app_lane_artifacts_management_policy_name}",
  ]

  app_validate_project_name = "${local.app_pipeline_name}-validate"
  app_deployment_record_project_name = (
    "${local.app_pipeline_name}-app-deployment-record"
  )
  app_terraform_plan_project_name   = "${local.app_pipeline_name}-terraform-plan"
  app_terraform_apply_project_name  = "${local.app_pipeline_name}-terraform-apply"
  app_static_deploy_project_name    = "${local.app_pipeline_name}-static-deploy"
  app_smoke_project_name            = "${local.app_pipeline_name}-smoke"
  app_static_fast_pipeline_name     = "${local.app_pipeline_name}-static-fast"
  app_static_fast_gate_project_name = "${local.app_pipeline_name}-static-fast-gate-and-build"
  app_static_fast_smoke_project_name = (
    "${local.app_pipeline_name}-static-fast-smoke-lite"
  )

  app_codebuild_project_names = [
    local.app_deployment_record_project_name,
    local.app_validate_project_name,
    local.app_terraform_plan_project_name,
    local.app_terraform_apply_project_name,
    local.app_static_deploy_project_name,
    local.app_smoke_project_name,
    local.app_static_fast_gate_project_name,
    local.app_static_fast_smoke_project_name,
  ]

  app_codebuild_project_arns = [
    for name in local.app_codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  app_pipeline_arn                = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.app_pipeline_name}"
  app_pipeline_action_arn_pattern = "${local.app_pipeline_arn}*"
  app_static_fast_pipeline_arn    = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.app_static_fast_pipeline_name}"
  app_static_fast_action_arn_pattern = (
    "${local.app_static_fast_pipeline_arn}*"
  )
  app_pipeline_artifact_bucket_arn = "arn:aws:s3:::${local.app_pipeline_artifact_bucket_name}"
  app_release_manifest_bucket_arn  = "arn:aws:s3:::${local.app_release_manifest_bucket_name}"
  app_release_manifest_objects_arn = "${local.app_release_manifest_bucket_arn}/*"
  app_source_connection_arns = [
    aws_codeconnections_connection.source[0].arn,
    replace(aws_codeconnections_connection.source[0].arn, ":codeconnections:", ":codestar-connections:"),
  ]
  app_codebuild_project_arn_pattern = (
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.app_pipeline_name}-*"
  )
  app_codebuild_log_group_arns = [
    for name in local.app_codebuild_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  app_codebuild_log_group_arn_pattern = (
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.app_pipeline_name}-*"
  )
  app_pipeline_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_deployment_record_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_deploy_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_smoke_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_gate_and_build_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_fast_smoke_lite_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.app_github_trigger_role_name}",
  ]
  app_pipeline_role_arn_pattern = "arn:aws:iam::${var.aws_account_id}:role/*-${var.account_alias}-${var.deployment_environment}-app"

  app_backend_config_content = join("\n", [
    "bucket       = \"${aws_s3_bucket.state.bucket}\"",
    "key          = \"${local.app_state_backend_key}\"",
    "region       = \"${var.aws_region}\"",
    "encrypt      = true",
    "kms_key_id   = \"${var.state_kms_alias}\"",
    "use_lockfile = true",
  ])
  app_public_hostname_disposition = var.development_app_cloudfront_acm_certificate_arn == null ? "generated-cloudfront-hostname" : "external-dns-acm"
  app_pipeline_tfvars_content = join("\n", [
    "account_alias          = \"stark-dev\"",
    "aws_account_id         = \"${var.aws_account_id}\"",
    "aws_region             = \"${var.aws_region}\"",
    var.development_app_cloudfront_acm_certificate_arn == null ? "cloudfront_acm_certificate_arn = null" : "cloudfront_acm_certificate_arn = \"${var.development_app_cloudfront_acm_certificate_arn}\"",
    "deployment_environment = \"develop\"",
    "develop_operator_gate_enabled = true",
    "develop_operator_gate_public_key_pem = ${jsonencode(var.development_app_operator_gate_public_key_pem)}",
    "project_name           = \"${var.project_name}\"",
    "public_hostname             = \"${var.development_app_public_hostname}\"",
    "public_hostname_disposition = \"${local.app_public_hostname_disposition}\"",
    "state_backend_key      = \"${local.app_state_backend_key}\"",
    "state_scope            = \"app\"",
  ])
  app_backend_config_command              = "printf '%s' '${base64encode(local.app_backend_config_content)}' | base64 -d > infra/terraform/app/backend.pipeline.hcl"
  app_tfvars_command                      = "printf '%s' '${base64encode(local.app_pipeline_tfvars_content)}' | base64 -d > infra/terraform/app/pipeline.auto.tfvars"
  app_guard_env_prefix                    = "TERRAFORM_AWS_ACCOUNT_ID_STARK_DEV=${var.aws_account_id} TERRAFORM_WORKING_DIR=infra/terraform/app TERRAFORM_APP_BACKEND_BUCKET=${aws_s3_bucket.state.bucket} TERRAFORM_APP_BACKEND_REGION=${var.aws_region} TERRAFORM_APP_BACKEND_KMS_KEY_ID=${var.state_kms_alias}"
  app_guard_init_command                  = "${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app init -backend-config=backend.pipeline.hcl"
  app_guard_validate_command              = "${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app validate"
  app_guard_plan_command                  = "${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app plan -out=tfplan -var-file=pipeline.auto.tfvars"
  app_guard_apply_command                 = "${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app apply -auto-approve tfplan"
  app_guard_smoke_command                 = "${local.app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-dev/develop/app smoke"
  app_accepted_marker_path                = "accepted-deployments/stark-dev/develop/app"
  app_accepted_deployment_retention_count = 10
  protected_production_app_state_backend_key = (
    "${var.project_name}/${local.protected_production_app_account_alias}/${local.protected_production_app_deployment_environment}/${local.protected_production_app_state_scope}/terraform.tfstate"
  )
  protected_production_app_backend_config_content = join("\n", [
    "bucket       = \"${aws_s3_bucket.state.bucket}\"",
    "key          = \"${local.protected_production_app_state_backend_key}\"",
    "region       = \"${var.aws_region}\"",
    "encrypt      = true",
    "kms_key_id   = \"${var.state_kms_alias}\"",
    "use_lockfile = true",
  ])
  protected_production_app_pipeline_tfvars_content = join("\n", [
    "account_alias          = \"${local.protected_production_app_account_alias}\"",
    "aws_account_id         = \"${local.protected_production_app_aws_account_id}\"",
    "aws_region             = \"${var.aws_region}\"",
    "deployment_environment = \"${local.protected_production_app_deployment_environment}\"",
    "develop_operator_gate_enabled = false",
    "project_name           = \"${var.project_name}\"",
    "state_backend_key      = \"${local.protected_production_app_state_backend_key}\"",
    "state_scope            = \"${local.protected_production_app_state_scope}\"",
  ])
  protected_production_app_lane_contract_content = join("\n", [
    "source_branch          = \"main\"",
    "account_alias          = \"stark-prod\"",
    "aws_account_id         = \"${local.protected_production_app_aws_account_id}\"",
    "deployment_environment = \"main\"",
    "state_scope            = \"app\"",
  ])
  protected_production_app_guard_env_prefix = (
    "TERRAFORM_AWS_ACCOUNT_ID_STARK_PROD=${local.protected_production_app_aws_account_id} TERRAFORM_WORKING_DIR=infra/terraform/app TERRAFORM_APP_BACKEND_BUCKET=${aws_s3_bucket.state.bucket} TERRAFORM_APP_BACKEND_REGION=${var.aws_region} TERRAFORM_APP_BACKEND_KMS_KEY_ID=${var.state_kms_alias}"
  )
  protected_production_app_guard_init_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app init -backend-config=backend.pipeline.hcl"
  )
  protected_production_app_guard_validate_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app validate"
  )
  protected_production_app_guard_plan_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app plan -out=tfplan -var-file=pipeline.auto.tfvars"
  )
  protected_production_app_guard_apply_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app apply -auto-approve tfplan"
  )
  protected_production_app_guard_smoke_command = (
    "${local.protected_production_app_guard_env_prefix} scripts/terraform/terraform-guarded.sh stark-prod/main/app smoke"
  )
  protected_production_app_accepted_marker_path = "accepted-deployments/stark-prod/main/app"
  protected_production_app_retained_evidence_paths = [
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/tfplan",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/tfplan.sha256",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/tfplan.txt",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/tfplan.json",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/source-preflight.json",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/target-lambda-artifacts.json",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/apply-outputs.json",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/static-frontend-deploy.json",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/app-smoke-report.json",
    "${local.protected_production_app_accepted_marker_path}/$CODEBUILD_RESOLVED_SOURCE_VERSION/authoritative-app-deployment.json",
    "${local.protected_production_app_accepted_marker_path}/index.json",
  ]
  app_missing_requested_source_sha = "__MISSING_REQUESTED_SOURCE_SHA__"
  app_missing_final_integration_evidence_id = (
    "__MISSING_FINAL_INTEGRATION_EVIDENCE_ID__"
  )
  app_missing_bootstrap_baseline_rerun_evidence_id = (
    "__MISSING_BOOTSTRAP_BASELINE_RERUN_EVIDENCE_ID__"
  )
  app_missing_prover_image_uri  = "__MISSING_PROVER_IMAGE_URI__"
  app_missing_expected_image_id = "__MISSING_EXPECTED_IMAGE_ID__"
  app_missing_prover_subnet_ids = "__MISSING_PROVER_SUBNET_IDS__"
  app_missing_prover_security_group_ids = (
    "__MISSING_PROVER_SECURITY_GROUP_IDS__"
  )

}
