output "app_state_identity" {
  description = "Account-aware Terraform state identity for the skeletal app lane."
  value       = "${var.account_alias}/${var.deployment_environment}/${var.state_scope}"
}

output "app_state_backend_key" {
  description = "Terraform remote state key for the skeletal app lane."
  value       = var.state_backend_key
}

output "app_lane_scope" {
  description = "App-lane identity marker for target deployment evidence."
  value       = terraform_data.skeletal_app_lane.output
}

output "deployment_identity" {
  description = "Accepted deployment generation stamped into target server runtimes."
  value = {
    deployment_id  = var.deployment_id
    app_source_sha = var.app_source_sha
    deploy_mode    = var.deploy_mode
  }
}

output "ops_ledger" {
  description = "Normalized, long-retention target operations ledger acceptance coordinates."
  value = {
    log_group_name        = aws_cloudwatch_log_group.ops_ledger.name
    query_definition_name = aws_cloudwatch_query_definition.ops_ledger_window.name
    event_rule_names = {
      for key, rule in aws_cloudwatch_event_rule.ops_ledger : key => rule.name
    }
  }
}

output "dynamodb_runtime_config" {
  description = "Non-secret DynamoDB and rate-limit runtime config names for target runtime."
  value = {
    aws_account_id                       = var.aws_account_id
    aws_region                           = var.aws_region
    dynamodb_sessions_table              = local.active_sessions_table_arn
    dynamodb_votes_table                 = local.active_votes_table_arn
    rate_limit_events_table              = aws_dynamodb_table.rate_limit_events.arn
    rate_limit_counters_table            = aws_dynamodb_table.rate_limit_counters.arn
    rate_limit_store                     = "dynamo"
    session_live_ttl_seconds             = var.session_live_ttl_seconds
    session_capability_secret_ref        = local.runtime_reference_names.SESSION_CAPABILITY_SECRET_REF
    session_capability_ttl_seconds_ref   = local.runtime_reference_names.SESSION_CAPABILITY_TTL_SECONDS_REF
    verification_artifact_ttl_seconds    = var.verification_artifact_ttl_seconds
    vote_secret_encryption_key_ref       = local.runtime_reference_names.VOTE_SECRET_ENCRYPTION_KEY_REF
    vote_duplicate_detector_ttl_seconds  = var.vote_duplicate_detector_ttl_seconds
    recovery_phase                       = var.dynamodb_recovery_phase
    recovery_quiesced                    = local.dynamodb_recovery_quiesced
    serves_replacement                   = local.dynamodb_recovery_serves_replacement
    target_public_session_create_enabled = local.target_public_session_create_enabled
    event_source_mappings_enabled        = !local.dynamodb_recovery_quiesced
    recovery_activation                  = var.dynamodb_recovery_activation
  }
}

output "dynamodb_recovery_transition" {
  description = "Non-secret desired and served state for the four-phase DynamoDB recovery transition."
  value = {
    phase                                = var.dynamodb_recovery_phase
    quiesced                             = local.dynamodb_recovery_quiesced
    serves_replacement                   = local.dynamodb_recovery_serves_replacement
    recovery_manifest_present            = var.dynamodb_recovery_activation != null
    target_public_session_create_enabled = local.target_public_session_create_enabled
    event_source_mappings_enabled        = !local.dynamodb_recovery_quiesced
    served = {
      sessions_table_arn = local.active_sessions_table_arn
      votes_table_arn    = local.active_votes_table_arn
    }
    primary = {
      sessions_table_arn = aws_dynamodb_table.sessions.arn
      votes_table_arn    = aws_dynamodb_table.votes.arn
    }
    replacement = var.dynamodb_recovery_activation == null ? null : {
      sessions_table_arn = local.recovery_sessions_table_arn
      votes_table_arn    = local.recovery_votes_table_arn
    }
    recovery_manifest = var.dynamodb_recovery_activation == null ? null : {
      recovery_id     = var.dynamodb_recovery_activation.recovery_id
      recovery_point  = var.dynamodb_recovery_activation.recovery_point
      manifest_sha256 = var.dynamodb_recovery_activation.manifest_sha256
    }
  }
}

output "runtime_secret_config_reference_names" {
  description = "Non-secret target runtime reference identifiers for target secret/config sources; values are not secret material."
  value       = local.runtime_reference_names
}

output "dynamodb_table_inventory" {
  description = "Target table inventory with access paths and lifecycle controls."
  value = {
    sessions = {
      table_name                      = local.active_sessions_table_name
      table_arn                       = local.active_sessions_table_arn
      purpose                         = "Session metadata, finalization envelope, bitmap/receipt sidecar items, and owner authority."
      primary_access_path             = "GetItem/PutItem by sessionId"
      ttl_attribute                   = "expiresAt"
      pitr_enabled                    = true
      sse_kms_key_arn                 = aws_kms_key.app_data.arn
      deletion_protection             = var.enable_dynamodb_deletion_protection
      owner_role_arns                 = { for key in ["public_api", "finalization_writer", "proof_dispatcher"] : key => aws_iam_role.target_lambda[key].arn }
      read_throttle_alarm_name        = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["sessions"].alarm_name
      read_throttle_alarm_arn         = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["sessions"].arn
      write_throttle_alarm_name       = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["sessions"].alarm_name
      write_throttle_alarm_arn        = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["sessions"].arn
      least_privilege_access_decision = "Session-table runtime access is limited by aws_iam_policy_document.target_lambda_session_store_runtime statements UseSessionTable and UseSessionVoteTransactions for the Hono API, finalize callback, and prover dispatch roles; KMS use is constrained by UseAppDataKey to this table name."
    }
    votes = {
      table_name                      = local.active_votes_table_name
      table_arn                       = local.active_votes_table_arn
      purpose                         = "Session-owned vote rows and CT bulletin restoration material."
      primary_access_path             = "Query by sessionId sorted by voteIndex"
      secondary_access                = "voteId-index is index-only; target proof acceptance remains session-scoped."
      ttl_attribute                   = "expiresAt"
      pitr_enabled                    = true
      sse_kms_key_arn                 = aws_kms_key.app_data.arn
      deletion_protection             = var.enable_dynamodb_deletion_protection
      owner_role_arns                 = { for key in ["public_api", "finalization_writer", "proof_dispatcher"] : key => aws_iam_role.target_lambda[key].arn }
      read_throttle_alarm_name        = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["votes"].alarm_name
      read_throttle_alarm_arn         = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["votes"].arn
      write_throttle_alarm_name       = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["votes"].alarm_name
      write_throttle_alarm_arn        = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["votes"].arn
      least_privilege_access_decision = "Vote-table runtime access is limited by aws_iam_policy_document.target_lambda_session_store_runtime statements UseVoteTable and UseSessionVoteTransactions for the Hono API, finalize callback, and prover dispatch roles; no voteId-index ARN is granted for target acceptance, and KMS use is constrained by UseAppDataKey to this table name."
    }
    rate_limit_events = {
      table_name                      = aws_dynamodb_table.rate_limit_events.name
      table_arn                       = aws_dynamodb_table.rate_limit_events.arn
      purpose                         = "DynamoDB-backed rolling-window rate-limit events."
      primary_access_path             = "Query by scope and time-sortable unique eventKey"
      ttl_attribute                   = "expiresAt"
      pitr_enabled                    = true
      sse_kms_key_arn                 = aws_kms_key.app_data.arn
      deletion_protection             = var.enable_dynamodb_deletion_protection
      owner_role_arn                  = aws_iam_role.target_lambda["public_api"].arn
      read_throttle_alarm_name        = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["rate_limit_events"].alarm_name
      read_throttle_alarm_arn         = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["rate_limit_events"].arn
      write_throttle_alarm_name       = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["rate_limit_events"].alarm_name
      write_throttle_alarm_arn        = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["rate_limit_events"].arn
      least_privilege_access_decision = "Rate-limit event access is limited by aws_iam_policy_document.target_lambda_store_runtime statement UseRateLimitEventsTable for the Hono API role; KMS use is constrained by UseAppDataKey to this table name."
    }
    rate_limit_counters = {
      table_name                      = aws_dynamodb_table.rate_limit_counters.name
      table_arn                       = aws_dynamodb_table.rate_limit_counters.arn
      purpose                         = "DynamoDB-backed hourly/daily global rate-limit counters."
      primary_access_path             = "GetItem/UpdateItem by key"
      ttl_attribute                   = "expiresAt"
      pitr_enabled                    = true
      sse_kms_key_arn                 = aws_kms_key.app_data.arn
      deletion_protection             = var.enable_dynamodb_deletion_protection
      owner_role_arn                  = aws_iam_role.target_lambda["public_api"].arn
      read_throttle_alarm_name        = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["rate_limit_counters"].alarm_name
      read_throttle_alarm_arn         = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["rate_limit_counters"].arn
      write_throttle_alarm_name       = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["rate_limit_counters"].alarm_name
      write_throttle_alarm_arn        = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["rate_limit_counters"].arn
      least_privilege_access_decision = "Rate-limit counter access is limited by aws_iam_policy_document.target_lambda_store_runtime statement UseRateLimitCountersTable for the Hono API role; KMS use is constrained by UseAppDataKey to this table name."
    }
    prover_semaphore = {
      table_name          = aws_dynamodb_table.prover_semaphore.name
      table_arn           = aws_dynamodb_table.prover_semaphore.arn
      purpose             = "Target prover concurrency semaphore with one seeded lock row and per-execution owner markers."
      primary_access_path = "GetItem/UpdateItem by LockName"
      ttl_attribute       = null
      pitr_enabled        = true
      sse_kms_key_arn     = aws_kms_key.app_data.arn
      deletion_protection = var.enable_dynamodb_deletion_protection
      owner_role_arns = {
        semaphore_janitor = aws_iam_role.target_lambda["semaphore_janitor"].arn
        target_sfn        = aws_iam_role.target_sfn.arn
      }
      read_throttle_alarm_name        = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["prover_semaphore"].alarm_name
      read_throttle_alarm_arn         = aws_cloudwatch_metric_alarm.dynamodb_read_throttle_events["prover_semaphore"].arn
      write_throttle_alarm_name       = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["prover_semaphore"].alarm_name
      write_throttle_alarm_arn        = aws_cloudwatch_metric_alarm.dynamodb_write_throttle_events["prover_semaphore"].arn
      least_privilege_access_decision = "Semaphore access is limited to the target state machine and semaphore-janitor Lambda; KMS use is constrained to this table name."
    }
  }
}

output "runtime_non_secret_parameter_names" {
  description = "SSM String parameter names for non-secret target runtime references."
  value = {
    for key, parameter in aws_ssm_parameter.runtime_config_names :
    key => parameter.name
  }
}

output "observability_detection_inventory" {
  description = "Safe-name inventory for passive detectors, the compact dashboard, and the invariant-only notification surface."
  value = {
    metric_namespace              = local.observability_metric_namespace
    dashboard_name                = aws_cloudwatch_dashboard.observability.dashboard_name
    invariant_alarm_name          = aws_cloudwatch_metric_alarm.verification_invariant_contradiction.alarm_name
    notification_topic_name       = aws_sns_topic.verification_invariant_alerts.name
    email_parameter_name          = local.invariant_email_parameter_name
    email_subscription_configured = local.invariant_email_parameter_present
    metric_filter_names = {
      dispatch_dropped                = aws_cloudwatch_log_metric_filter.dispatch_dropped.name
      finalization_terminal_outcomes  = sort(values(aws_cloudwatch_log_metric_filter.finalization_terminal_outcomes)[*].name)
      verification_failure_categories = aws_cloudwatch_log_metric_filter.verification_failure_categories.name
      invariant_contradiction         = aws_cloudwatch_log_metric_filter.verification_invariant_contradiction.name
    }
    passive_alarm_names = {
      additional_lambda_errors = sort(values(aws_cloudwatch_metric_alarm.target_lambda_errors_additional)[*].alarm_name)
      lambda_throttles         = sort(values(aws_cloudwatch_metric_alarm.target_lambda_throttles)[*].alarm_name)
      api_gateway_5xx          = aws_cloudwatch_metric_alarm.target_api_gateway_5xx.alarm_name
      work_queue_age           = sort(values(aws_cloudwatch_metric_alarm.work_queue_oldest_message_age)[*].alarm_name)
    }
  }
}

output "target_lambda_role_arns" {
  description = "IAM role ARNs for each Terraform-managed target Lambda runtime surface."
  value = merge(
    {
      for key, role in aws_iam_role.target_lambda :
      key => role.arn
    },
    {
      image_signature_verifier = aws_iam_role.image_signature_verifier.arn
    },
  )
}

output "image_signature_verifier" {
  description = "Non-secret immutable cryptographic image-signature verifier deployment coordinates."
  value       = local.image_signature_verifier_deployment_authority
}

output "image_signature_preflight" {
  description = "Non-secret verifier coordinates available immediately after the isolated preflight apply."
  value = {
    function_arn       = aws_lambda_function.image_signature_verifier.arn
    function_version   = aws_lambda_function.image_signature_verifier.version
    architecture       = one(aws_lambda_function.image_signature_verifier.architectures)
    runtime            = aws_lambda_function.image_signature_verifier.runtime
    timeout_seconds    = aws_lambda_function.image_signature_verifier.timeout
    environment_sha256 = sha256(jsonencode(local.image_signature_verifier_environment))
    function_configuration_sha256 = sha256(
      jsonencode(local.image_signature_verifier_configuration_authority)
    )
    execution_role_arn                                = aws_iam_role.image_signature_verifier.arn
    execution_role_assume_policy_sha256               = local.image_signature_verifier_execution_role_assume_policy_sha256
    execution_role_policy_sha256                      = local.image_signature_verifier_execution_role_policy_sha256
    execution_role_permissions_boundary_arn           = data.aws_iam_policy.image_signature_verifier_permissions_boundary.arn
    execution_role_permissions_boundary_policy_sha256 = local.image_signature_verifier_permissions_boundary_policy_sha256
    preflight_alias_arn                               = aws_lambda_alias.image_signature_verifier_preflight.arn
    package                                           = var.lambda_artifacts["image_signature_verifier"]
  }
}

output "target_runtime" {
  description = "Non-secret target API and async runtime inventory."
  value = {
    api = {
      api_id         = aws_apigatewayv2_api.target.id
      api_endpoint   = aws_apigatewayv2_api.target.api_endpoint
      default_stage  = aws_apigatewayv2_stage.default.name
      route_key      = aws_apigatewayv2_route.api_proxy.route_key
      direct_use     = "rejected-by-origin-verify-header-after-cloudfront-authority"
      lambda_arn     = aws_lambda_function.target["public_api"].arn
      role_arn       = aws_iam_role.target_lambda["public_api"].arn
      lambda_package = var.lambda_artifacts["public_api"]
      access_log_group = {
        name = aws_cloudwatch_log_group.api_access.name
        arn  = aws_cloudwatch_log_group.api_access.arn
      }
      throttle = {
        burst_limit = local.api_throttle_burst_limit
        rate_limit  = local.api_throttle_rate_limit
      }
    }
    callback = {
      lambda_arn     = aws_lambda_function.target["finalization_writer"].arn
      role_arn       = aws_iam_role.target_lambda["finalization_writer"].arn
      contract_type  = "step-functions-finalization-writer"
      lambda_package = var.lambda_artifacts["finalization_writer"]
    }
    async = {
      prover_work_queue_arn                      = aws_sqs_queue.prover_work.arn
      prover_work_queue_url                      = aws_sqs_queue.prover_work.url
      prover_work_event_source_mapping_uuid      = aws_lambda_event_source_mapping.prover_work.uuid
      prover_work_event_source_mapping_enabled   = !local.dynamodb_recovery_quiesced
      dispatch_lambda_arn                        = aws_lambda_function.target["proof_dispatcher"].arn
      dispatch_role_arn                          = aws_iam_role.target_lambda["proof_dispatcher"].arn
      image_signature_lambda_arn                 = aws_lambda_function.image_signature_verifier.arn
      image_signature_role_arn                   = aws_iam_role.image_signature_verifier.arn
      image_signature_verifier_package           = local.image_signature_verifier_deployment_authority.package
      image_signature_version                    = local.image_signature_verifier_deployment_authority.function_version
      image_signature_runtime_alias_arn          = aws_lambda_alias.image_signature_verifier_runtime.arn
      semaphore_janitor_arn                      = aws_lambda_function.target["semaphore_janitor"].arn
      semaphore_janitor_role_arn                 = aws_iam_role.target_lambda["semaphore_janitor"].arn
      semaphore_janitor_package                  = var.lambda_artifacts["semaphore_janitor"]
      semaphore_table_name                       = aws_dynamodb_table.prover_semaphore.name
      semaphore_lock_name                        = local.prover_semaphore_lock_name
      state_machine_arn                          = aws_sfn_state_machine.target_finalization.arn
      state_machine_log_group                    = aws_cloudwatch_log_group.target_sfn.arn
      target_sfn_executions_failed_alarm_name    = aws_cloudwatch_metric_alarm.target_sfn_executions_failed.alarm_name
      target_sfn_executions_failed_alarm_arn     = aws_cloudwatch_metric_alarm.target_sfn_executions_failed.arn
      target_sfn_executions_timed_out_alarm_name = aws_cloudwatch_metric_alarm.target_sfn_executions_timed_out.alarm_name
      target_sfn_executions_timed_out_alarm_arn  = aws_cloudwatch_metric_alarm.target_sfn_executions_timed_out.arn
      prover_image_uri                           = var.prover_image_uri
      expected_image_id                          = var.expected_image_id
      image_id_mapping_evidence                  = var.image_id_mapping_evidence
      dispatch_package                           = var.lambda_artifacts["proof_dispatcher"]
      prover_work_dlq_arn                        = aws_sqs_queue.prover_work_dlq.arn
      prover_work_dlq_url                        = aws_sqs_queue.prover_work_dlq.url
      prover_work_dlq_depth_alarm_name           = aws_cloudwatch_metric_alarm.prover_work_dlq_depth.alarm_name
      prover_work_dlq_depth_alarm_arn            = aws_cloudwatch_metric_alarm.prover_work_dlq_depth.arn
      proof_dispatcher_errors_alarm_name         = aws_cloudwatch_metric_alarm.target_lambda_errors_proof_dispatcher.alarm_name
      proof_dispatcher_errors_alarm_arn          = aws_cloudwatch_metric_alarm.target_lambda_errors_proof_dispatcher.arn
      finalization_writer_errors_alarm_name      = aws_cloudwatch_metric_alarm.target_lambda_errors_finalization_writer.alarm_name
      finalization_writer_errors_alarm_arn       = aws_cloudwatch_metric_alarm.target_lambda_errors_finalization_writer.arn
      semaphore_janitor_errors_alarm_name        = aws_cloudwatch_metric_alarm.target_lambda_errors_semaphore_janitor.alarm_name
      semaphore_janitor_errors_alarm_arn         = aws_cloudwatch_metric_alarm.target_lambda_errors_semaphore_janitor.arn
      fargate_on_demand_vcpu_usage_alarm_name    = aws_cloudwatch_metric_alarm.fargate_on_demand_vcpu_usage.alarm_name
      fargate_on_demand_vcpu_usage_alarm_arn     = aws_cloudwatch_metric_alarm.fargate_on_demand_vcpu_usage.arn
    }
    verifier = {
      lambda_arn                                     = aws_lambda_function.target["verification_worker"].arn
      role_arn                                       = aws_iam_role.target_lambda["verification_worker"].arn
      lambda_package                                 = var.lambda_artifacts["verification_worker"]
      verification_work_queue_arn                    = aws_sqs_queue.verification_work.arn
      verification_work_queue_url                    = aws_sqs_queue.verification_work.url
      verification_work_event_source_mapping_uuid    = aws_lambda_event_source_mapping.verification_work.uuid
      verification_work_event_source_mapping_enabled = !local.dynamodb_recovery_quiesced
      verification_work_dlq_arn                      = aws_sqs_queue.verification_work_dlq.arn
      verification_work_dlq_url                      = aws_sqs_queue.verification_work_dlq.url
      verification_work_dlq_depth_alarm_name         = aws_cloudwatch_metric_alarm.verification_work_dlq_depth.alarm_name
      verification_work_dlq_depth_alarm_arn          = aws_cloudwatch_metric_alarm.verification_work_dlq_depth.arn
    }
    artifacts = {
      proof_bucket_name    = aws_s3_bucket.proof_artifacts.bucket
      proof_bucket_arn     = aws_s3_bucket.proof_artifacts.arn
      proof_prefix         = local.proof_artifact_prefix
      public_bundle_policy = "bundle.zip allowlist only; private report and bitmap artifacts remain sibling protected objects"
      bucket_versioning    = "Enabled"
      lifecycle_days       = var.proof_artifact_lifecycle_days
    }
  }
}

output "develop_operator_gate_keyset" {
  description = "Nonsecret KMS and CloudFront coordinates for the tracked develop operator-gate keyset."
  value = {
    enabled                = local.target_develop_operator_gate_enabled
    keyset_type            = local.operator_gate_keyset.keysetType
    issuer_generation      = local.operator_gate_keyset.issuerGeneration
    signing_algorithm      = "RSASSA_PKCS1_V1_5_SHA_256"
    cookie_hash_algorithm  = "SHA256"
    key_group_id           = local.operator_gate_keyset_configured ? aws_cloudfront_key_group.develop_operator_gate[0].id : null
    key_group_name         = local.operator_gate_name
    trusted_public_key_ids = local.operator_gate_trusted_public_key_ids
    generations = {
      for generation, key in local.operator_gate_managed_generations : generation => {
        status                   = key.status
        kms_key_arn              = aws_kms_key.develop_operator_gate[generation].arn
        kms_alias_name           = try(aws_kms_alias.develop_operator_gate[generation].name, null)
        cloudfront_public_key_id = try(aws_cloudfront_public_key.develop_operator_gate_managed[generation].id, null)
      }
    }
  }
}

output "static_frontend" {
  description = "Static frontend workload inventory."
  value = {
    frontend_bucket_name           = aws_s3_bucket.frontend_static.bucket
    frontend_bucket_arn            = aws_s3_bucket.frontend_static.arn
    cloudfront_distribution_id     = aws_cloudfront_distribution.frontend.id
    cloudfront_distribution_arn    = aws_cloudfront_distribution.frontend.arn
    cloudfront_distribution_domain = aws_cloudfront_distribution.frontend.domain_name
    cloudfront_aliases             = local.cloudfront_aliases
    public_hostname_disposition    = var.public_hostname_disposition
    api_origin_domain_name         = local.api_origin_domain_name
    operator_gate_enabled          = local.target_develop_operator_gate_enabled
    operator_gate_key_group_ids    = local.operator_gate_trusted_key_groups
    api_origin_verify_header_name  = local.api_origin_verify_header_name
    api_origin_verify_header_set   = local.api_origin_verify_header_configured
    app_shell_cache_policy_id      = aws_cloudfront_cache_policy.frontend_app_shell.id
    static_asset_cache_policy_id   = aws_cloudfront_cache_policy.frontend_static_assets.id
    api_cache_policy_id            = aws_cloudfront_cache_policy.api_disabled.id
    response_headers_policy_id     = aws_cloudfront_response_headers_policy.frontend_security.id
    public_artifact_scan_required  = true
    source_maps_public             = false
  }
}
